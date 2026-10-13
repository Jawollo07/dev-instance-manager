'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const { promisify } = require('node:util')
const scrypt = promisify(crypto.scrypt)

const SESSION_COOKIE = 'dim_session'
const SESSION_TTL_MS = 8 * 60 * 60 * 1000
const sessions = new Map()
const USERNAME_RE = /^[a-zA-Z0-9@._+-]{1,64}$/

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
  const file = process.env.DIM_USERS_FILE || '/etc/dev-instance-manager/users.json'
  let parsed
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw new Error('Benutzerdatei kann nicht gelesen werden.')
  }
  if (!parsed || !Array.isArray(parsed.users)) throw new Error('Ungültiges Benutzerdateiformat.')
  return parsed.users.filter(u =>
    u && typeof u.username === 'string' && USERNAME_RE.test(u.username) &&
    typeof u.salt === 'string' && /^[a-f0-9]{32,128}$/i.test(u.salt) &&
    typeof u.hash === 'string' && /^[a-f0-9]{128}$/i.test(u.hash)
  )
}

async function verifyPassword(password, user) {
  const salt = user ? Buffer.from(user.salt, 'hex') : Buffer.alloc(16, 0x5a)
  const expected = user ? Buffer.from(user.hash, 'hex') : Buffer.alloc(64, 0xa5)
  const actual = await scrypt(password, salt, 64)
  return crypto.timingSafeEqual(actual, expected) && Boolean(user) && user.disabled !== true
}

function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex')
  sessions.set(token, { username, expiresAt: Date.now() + SESSION_TTL_MS })
  return token
}

function destroySession(req) {
  const session = sessionFor(req)
  if (session) sessions.delete(session.token)
}

module.exports = {
  USERNAME_RE, SESSION_COOKIE, readUsers, verifyPassword, createSession,
  currentUser, destroySession, setSessionCookie, clearSessionCookie
}
