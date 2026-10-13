'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const { promisify } = require('node:util')
const scrypt = promisify(crypto.scrypt)

const SESSION_COOKIE = 'dim_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const sessions = new Map()
const USERNAME_RE = /^[a-zA-Z0-9@._+-]{1,64}$/
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const USERS_FILE = () => process.env.DIM_USERS_FILE || '/var/lib/dev-instance-manager-users/users.json'

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

function setSessionCookie(reply, token) {
  reply.header('set-cookie', `${SESSION_COOKIE}=${token}; ${cookieOptions()}`)
}

function clearSessionCookie(reply) {
  reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` +
    (process.env.NODE_ENV === 'production' ? '; Secure' : ''))
}

function sessionFor(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null
  const session = sessions.get(token)
  if (!session) return null
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return null
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS
  return { token, username: session.username }
}

function currentUser(req) {
  return sessionFor(req)?.username || null
}

async function readUsers() {
  const file = USERS_FILE()
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw new Error('Benutzerdatei kann nicht gelesen werden.')
  }
  if (!parsed || !Array.isArray(parsed.users)) throw new Error('Ungültiges Benutzerdateiformat.')
  return parsed.users.map(u => u && ({ ...u, slug: u.slug || String(u.username || '').toLowerCase(), role: u.role || 'user' })).filter(u =>
    u && typeof u.username === 'string' && USERNAME_RE.test(u.username) &&
    typeof u.slug === 'string' && SLUG_RE.test(u.slug) &&
    typeof u.role === 'string' && ['user', 'admin'].includes(u.role) &&
    typeof u.salt === 'string' && /^[a-f0-9]{32,128}$/i.test(u.salt) &&
    typeof u.hash === 'string' && /^[a-f0-9]{128}$/i.test(u.hash)
  )
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 1024) {
    throw new Error('Passwort muss mindestens 12 Zeichen lang sein und höchstens 1024 Byte enthalten.')
  }
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, 64)
  return { salt: salt.toString('hex'), hash: hash.toString('hex') }
}

async function writeUsers(users) {
  const file = USERS_FILE()
  const dir = require('node:path').dirname(file)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
  await fs.writeFile(temp, JSON.stringify({ users }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  await fs.rename(temp, file)
  await fs.chmod(file, 0o600)
}

async function verifyPassword(password, user) {
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16, 0x5a)
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64, 0xa5)
  const actual = await scrypt(password, salt, 64)
  return crypto.timingSafeEqual(actual, expected) && Boolean(user) && user.disabled !== true
}

function createSession(username) {
  const now = Date.now()
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token)
  if (sessions.size >= 512) throw new Error('Zu viele aktive Sitzungen.')
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS })
  return token
}

function destroySession(req) {
  const session = sessionFor(req)
  if (session) sessions.delete(session.token)
}

module.exports = {
  USERNAME_RE, SLUG_RE, SESSION_COOKIE, readUsers, writeUsers, hashPassword, verifyPassword, createSession,
  currentUser, destroySession, setSessionCookie, clearSessionCookie
}
