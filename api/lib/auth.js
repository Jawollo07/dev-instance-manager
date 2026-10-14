'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')
const scrypt = promisify(crypto.scrypt)
const mysql = require('mysql2/promise')

const SESSION_COOKIE = 'dim_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const USERNAME_RE = /^[a-zA-Z0-9@._+-]{1,64}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const USERS_FILE = () => process.env.DIM_USERS_FILE || '/var/lib/dev-instance-manager-users/users.json'
let pool
let ready

function db() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'dim_app',
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME || 'dev_instance_manager',
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
      charset: 'utf8mb4',
      timezone: 'Z'
    })
  }
  if (!ready) ready = initialize()
  return pool
}

async function initialize() {
  const p = pool
  if (!process.env.DB_PASSWORD) throw new Error('DB_PASSWORD ist nicht konfiguriert.')
  await p.execute(`CREATE TABLE IF NOT EXISTS dim_users (
    username VARCHAR(64) NOT NULL PRIMARY KEY,
    slug VARCHAR(32) NOT NULL UNIQUE,
    role ENUM('user','admin') NOT NULL DEFAULT 'user',
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    salt CHAR(32) NOT NULL,
    password_hash CHAR(128) NOT NULL,
    created_at VARCHAR(40) NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await p.execute(`CREATE TABLE IF NOT EXISTS dim_sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX dim_sessions_user (username),
    INDEX dim_sessions_expiry (expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  await p.execute(`CREATE TABLE IF NOT EXISTS dim_audit (
    id CHAR(24) NOT NULL PRIMARY KEY,
    event_at VARCHAR(40) NOT NULL,
    actor VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,
    target VARCHAR(64) NULL,
    status VARCHAR(16) NOT NULL,
    details JSON NULL,
    INDEX dim_audit_time (event_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  const [[count]] = await p.query('SELECT COUNT(*) AS count FROM dim_users')
  if (Number(count.count) === 0) {
    // One-time import of the legacy JSON file. Never overwrites existing DB users.
    let legacy
    try { legacy = JSON.parse(await fs.readFile(USERS_FILE(), 'utf8')) }
    catch (err) { if (err.code === 'ENOENT') return; throw new Error('Legacy-Benutzerdatei konnte nicht importiert werden.') }
    if (!legacy || !Array.isArray(legacy.users)) throw new Error('Ungültiges Legacy-Benutzerdateiformat.')
    const conn = await p.getConnection()
    try {
      await conn.beginTransaction()
      for (const u of legacy.users) {
        if (!u || !USERNAME_RE.test(u.username || '') || !SLUG_RE.test(u.slug || String(u.username || '').toLowerCase()) ||
            !['user','admin'].includes(u.role || 'user') || !/^[a-f0-9]{32}$/i.test(u.salt || '') ||
            !/^[a-f0-9]{128}$/i.test(u.hash || '')) continue
        await conn.execute('INSERT IGNORE INTO dim_users (username,slug,role,disabled,salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?)',
          [u.username, u.slug || u.username.toLowerCase(), u.role || 'user', u.disabled === true, u.salt, u.hash, u.createdAt || null])
      }
      await conn.commit()
    } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
  }
}

async function query(sql, params) {
  const p = db()
  await ready
  return p.execute(sql, params)
}
function parseCookies(header = '') {
  const cookies = Object.create(null)
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const key = part.slice(0, i).trim()
    const value = part.slice(i + 1).trim()
    if (key && value.length <= 256) cookies[key] = value
  }
  return cookies
}
function cookieOptions() {
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : '')
}
function setSessionCookie(reply, token) { reply.header('set-cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions()}`) }
function clearSessionCookie(reply) {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : ''))
}
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex')

async function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const [rows] = await query('SELECT username, expires_at FROM dim_sessions WHERE token_hash=? LIMIT 1', [tokenHash(token)])
  if (!rows.length) return null
  const expires = new Date(rows[0].expires_at).getTime()
  if (!Number.isFinite(expires) || expires <= Date.now()) {
    await query('DELETE FROM dim_sessions WHERE token_hash=?', [tokenHash(token)])
    return null
  }
  const nextExpiry = new Date(Date.now() + SESSION_TTL_MS)
  await query('UPDATE dim_sessions SET expires_at=? WHERE token_hash=?', [nextExpiry, tokenHash(token)])
  return { token, username: rows[0].username }
}
async function currentUser(req) { return (await sessionFor(req))?.username || null }

async function readUsers() {
  const [rows] = await query('SELECT username,slug,role,disabled,salt,password_hash AS hash,created_at AS createdAt FROM dim_users ORDER BY username')
  return rows.map(u => ({ ...u, disabled: Boolean(u.disabled), createdAt: u.createdAt || undefined }))
}
async function writeUsers(users) {
  const p = db()
  await ready
  const conn = await p.getConnection()
  try {
    await conn.beginTransaction()
    const names = new Set()
    const slugs = new Set()
    for (const u of users) {
      if (!u || !USERNAME_RE.test(u.username || '') || !SLUG_RE.test(u.slug || '') ||
          !['user','admin'].includes(u.role) || !/^[a-f0-9]{32}$/i.test(u.salt || '') ||
          !/^[a-f0-9]{128}$/i.test(u.hash || '') || names.has(u.username) || slugs.has(u.slug)) {
        throw new Error('Ungültige oder doppelte Benutzerdaten.')
      }
      names.add(u.username); slugs.add(u.slug)
    }
    await conn.execute('DELETE FROM dim_users')
    for (const u of users) {
      await conn.execute('INSERT INTO dim_users (username,slug,role,disabled,salt,password_hash,created_at) VALUES (?,?,?,?,?,?,?)',
        [u.username,u.slug,u.role,u.disabled === true,u.salt,u.hash,u.createdAt || null])
    }
    await conn.commit()
  } catch (e) { await conn.rollback(); throw e } finally { conn.release() }
}
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('Passwort muss mindestens 12 Zeichen lang sein und höchstens 1024 Byte enthalten.')
  }
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}
async function verifyPassword(password, user) {
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16, 0x5a)
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64, 0xa5)
  const actual = await scrypt(password, salt, 64)
  return crypto.timingSafeEqual(actual, expected) && Boolean(user) && user.disabled !== true
}
async function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex')
  await query('DELETE FROM dim_sessions WHERE expires_at <= UTC_TIMESTAMP(3)')
  const [rows] = await query('SELECT COUNT(*) AS count FROM dim_sessions')
  if (Number(rows[0].count) >= 512) throw new Error('Zu viele aktive Sitzungen.')
  await query('INSERT INTO dim_sessions (token_hash,username,expires_at) VALUES (?,?,?)',
    [tokenHash(token), username, new Date(Date.now() + SESSION_TTL_MS)])
  return token
}
async function destroySession(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (token && /^[a-f0-9]{64}$/.test(token)) await query('DELETE FROM dim_sessions WHERE token_hash=?', [tokenHash(token)])
}
module.exports = {
  USERNAME_RE, SLUG_RE, SESSION_COOKIE, readUsers, writeUsers, hashPassword, verifyPassword, createSession,
  currentUser, destroySession, setSessionCookie, clearSessionCookie, query
}
