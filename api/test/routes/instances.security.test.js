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

test('instance status requires a trusted identity header', async (t) => {
  const app = await build(t)
  const response = await app.inject({ method: 'GET', url: '/api/instance' })
  assert.equal(response.statusCode, 401)
  assert.deepEqual(response.json(), { error: 'Authentifizierung erforderlich.' })
})

test('instance status rejects malformed identity values before calling the host helper', async (t) => {
  const app = await build(t)
  const response = await app.inject({
    method: 'GET',
    url: '/api/instance',
    headers: { 'x-authentik-username': '../root;id' }
  })
  assert.equal(response.statusCode, 401)
})
