'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { build } = require('../helper')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

test('health endpoint reports service readiness without exposing host details', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok', service: 'dev-instance-manager' })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('instance status requires a valid local session', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/admin/users' })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Bitte anmelden.' })
})

test('client-supplied identity headers cannot impersonate a user', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: {
      'x-authentik-username': 'alice',
      'x-user': 'alice',
      'x-forwarded-user': 'alice'
    }
  })
  assert.equal(response.statusCode, 401)
})

test('login rejects unknown users with a generic error', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'nobody', password: 'this-is-a-long-password' }
  })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Benutzername oder Passwort ungültig.' })
})

test('login rejects invalid request shapes', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice' }
  })
  assert.equal(response.statusCode, 400)
})

test('local login issues a session cookie and logout revokes it', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dim-auth-'))
  const file = path.join(dir, 'users.json')
  const oldFile = process.env.DIM_USERS_FILE
  const oldNodeEnv = process.env.NODE_ENV
  t.after(async () => {
    if (oldFile === undefined) delete process.env.DIM_USERS_FILE
    else process.env.DIM_USERS_FILE = oldFile
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldNodeEnv
    await fs.rm(dir, { recursive: true, force: true })
  })
  process.env.DIM_USERS_FILE = file
  process.env.NODE_ENV = 'test'
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync('correct-horse-battery-staple', salt, 64)
  await fs.writeFile(file, JSON.stringify({
    users: [{ username: 'alice', salt: salt.toString('hex'), hash: hash.toString('hex'), disabled: false }]
  }), { mode: 0o600 })

  const app = await build(t)
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'alice', password: 'correct-horse-battery-staple' }
  })
  assert.equal(login.statusCode, 200)
  assert.deepEqual(login.json(), { user: 'alice' })
  const setCookie = login.headers['set-cookie']
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  const cookie = setCookie.split(';', 1)[0]

  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.deepEqual(me.json(), { user: 'alice' })

  const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } })
  assert.equal(logout.statusCode, 200)
  const afterLogout = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })
  assert.equal(afterLogout.statusCode, 401)
})

test('workspace URL challenges with Basic Auth and ignores spoofed identity headers', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/test1',
    headers: { 'x-user': 'test1', 'x-forwarded-user': 'test1' }
  })
  assert.equal(response.statusCode, 401)
  assert.match(response.headers['www-authenticate'], /^Basic realm=/)
})

test('Basic Auth credentials for one slug cannot access another slug', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dim-basic-'))
  const file = path.join(dir, 'users.json')
  const oldFile = process.env.DIM_USERS_FILE
  const oldNodeEnv = process.env.NODE_ENV
  t.after(async () => {
    if (oldFile === undefined) delete process.env.DIM_USERS_FILE
    else process.env.DIM_USERS_FILE = oldFile
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldNodeEnv
    await fs.rm(dir, { recursive: true, force: true })
  })
  process.env.DIM_USERS_FILE = file
  process.env.NODE_ENV = 'test'
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync('correct-horse-battery-staple', salt, 64)
  await fs.writeFile(file, JSON.stringify({
    users: [{ username: 'alice', slug: 'alice', role: 'user', salt: salt.toString('hex'), hash: hash.toString('hex'), disabled: false }]
  }), { mode: 0o600 })
  const app = await build(t)
  const authorization = 'Basic ' + Buffer.from('alice:correct-horse-battery-staple').toString('base64')
  const response = await app.inject({ method: 'GET', url: '/bob', headers: { authorization } })
  assert.equal(response.statusCode, 401)
  assert.match(response.headers['www-authenticate'], /^Basic realm=/)
})

test('admin API denies a regular user's valid session', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dim-admin-'))
  const file = path.join(dir, 'users.json')
  const oldFile = process.env.DIM_USERS_FILE
  const oldNodeEnv = process.env.NODE_ENV
  t.after(async () => {
    if (oldFile === undefined) delete process.env.DIM_USERS_FILE
    else process.env.DIM_USERS_FILE = oldFile
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = oldNodeEnv
    await fs.rm(dir, { recursive: true, force: true })
  })
  process.env.DIM_USERS_FILE = file
  process.env.NODE_ENV = 'test'
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync('correct-horse-battery-staple', salt, 64)
  await fs.writeFile(file, JSON.stringify({
    users: [{ username: 'alice', slug: 'alice', role: 'user', salt: salt.toString('hex'), hash: hash.toString('hex'), disabled: false }]
  }), { mode: 0o600 })
  const app = await build(t)
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'correct-horse-battery-staple' } })
  const cookie = login.headers['set-cookie'].split(';', 1)[0]
  const response = await app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie } })
  assert.equal(response.statusCode, 403)
})
