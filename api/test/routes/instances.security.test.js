'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { build } = require('../helper')

test('health endpoint reports service readiness without exposing host details', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { status: 'ok', service: 'dev-instance-manager' })
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('instance status requires a valid local session', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/instance' })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Bitte anmelden.' })
})

test('client-supplied identity headers cannot impersonate a user', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/instance',
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
    payload: { username: 'alice', password: 'long-password', isAdmin: true }
  })
  assert.equal(response.statusCode, 400)
})
