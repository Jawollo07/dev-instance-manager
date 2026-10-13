'use strict'

const { currentUser, readUsers, writeUsers, hashPassword, USERNAME_RE, SLUG_RE } = require('../lib/auth')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const HELPER = process.env.DEVVM_HELPER || '/usr/local/sbin/devvm'
const BACKUP_HELPER = process.env.DEVVM_BACKUP_HELPER || '/usr/local/sbin/backup-devvm'
const ORIGIN = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : null
if (process.env.NODE_ENV === 'production' && !ORIGIN) throw new Error('PUBLIC_BASE_URL is required in production')

function allowedOrigin(req) { return ORIGIN ? req.headers.origin === ORIGIN : process.env.NODE_ENV !== 'production' }
async function admin(req, reply) {
  const username = currentUser(req)
  if (!username) { reply.code(401).send({ error: 'Bitte anmelden.' }); return null }
  const users = await readUsers()
  const actor = users.find(user => user.username === username && user.disabled !== true)
  if (!actor || actor.role !== 'admin') { reply.code(403).send({ error: 'Admin-Berechtigung erforderlich.' }); return null }
  return { actor, users }
}
async function action(name, slug) {
  const result = await run('sudo', ['-n', HELPER, name, slug], { timeout: name === 'create' ? 900000 : 60000, maxBuffer: 1048576 })
  return JSON.parse(result.stdout)
}
function publicUser(user) {
  return { username: user.username, slug: user.slug, role: user.role, disabled: user.disabled === true }
}
async function getInstance(user) {
  try { return await action('status', user.slug) }
  catch { return { exists: false, status: 'Unknown', ip: null, error: 'Status nicht verfügbar' } }
}

module.exports = async function (fastify) {
  fastify.post('/api/admin/backups', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    try {
      const result = await run('sudo', ['-n', BACKUP_HELPER], { timeout: 1800000, maxBuffer: 1048576 })
      reply.header('cache-control', 'no-store')
      return { ok: true, output: result.stdout.slice(-8000) }
    } catch (err) {
      req.log.error({ err }, 'admin backup failed')
      return reply.code(502).send({ error: 'Backup fehlgeschlagen. Ist der root-eigene Backup-Helper installiert und in sudoers freigegeben?' })
    }
  })

  fastify.get('/api/admin/users', async (req, reply) => {
    const access = await admin(req, reply)
    if (!access) return
    reply.header('cache-control', 'no-store')
    const users = await Promise.all(access.users.map(async user => ({
      ...publicUser(user),
      instance: user.role === 'user' ? await getInstance(user) : null
    })))
    return { users }
  })

  fastify.post('/api/admin/users', {
    bodyLimit: 4096,
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        required: ['username', 'slug', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          slug: { type: 'string', minLength: 1, maxLength: 32 },
          password: { type: 'string', minLength: 12, maxLength: 1024 }
        }
      }
    }
  }, async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const username = req.body.username.trim()
    const slug = req.body.slug.trim().toLowerCase()
    if (!USERNAME_RE.test(username) || !SLUG_RE.test(slug) || ['admin', 'api', 'assets'].includes(slug)) return reply.code(400).send({ error: 'Benutzername oder URL-Slug ungültig oder reserviert.' })
    if (access.users.some(user => user.username.toLowerCase() === username.toLowerCase())) return reply.code(409).send({ error: 'Benutzername bereits vergeben.' })
    if (access.users.some(user => user.slug === slug)) return reply.code(409).send({ error: 'URL-Slug bereits vergeben.' })
    if (access.users.filter(user => user.role === 'user').length >= 8) return reply.code(409).send({ error: 'Maximal acht Benutzer-Workspaces erlaubt.' })
    try {
      const password = await hashPassword(req.body.password)
      const user = { username, slug, role: 'user', disabled: false, ...password, createdAt: new Date().toISOString() }
      await writeUsers([...access.users, user])
      const instance = await action('create', slug)
      return reply.code(201).send({ user: publicUser(user), instance })
    } catch (err) {
      req.log.error({ err }, 'user create failed')
      return reply.code(502).send({ error: 'Benutzer angelegt, Workspace konnte aber nicht erstellt werden. Bitte Instanzstatus prüfen.' })
    }
  })

  fastify.patch('/api/admin/users/:username', {
    bodyLimit: 2048,
    schema: {
      params: { type: 'object', required: ['username'], properties: { username: { type: 'string', maxLength: 64 } } },
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          disabled: { type: 'boolean' },
          password: { type: 'string', minLength: 12, maxLength: 1024 }
        },
        minProperties: 1
      }
    }
  }, async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const index = access.users.findIndex(user => user.username === req.params.username)
    if (index < 0) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' })
    const target = { ...access.users[index] }
    if (req.body.disabled !== undefined) {
      if (target.role === 'admin' && req.body.disabled && access.users.filter(user => user.role === 'admin' && user.disabled !== true).length <= 1) {
        return reply.code(409).send({ error: 'Der letzte aktive Admin kann nicht gesperrt werden.' })
      }
      target.disabled = req.body.disabled
    }
    if (req.body.password !== undefined) Object.assign(target, await hashPassword(req.body.password))
    const users = [...access.users]
    users[index] = target
    await writeUsers(users)
    return { user: publicUser(target) }
  })

  fastify.delete('/api/admin/users/:username', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const target = access.users.find(user => user.username === req.params.username)
    if (!target) return reply.code(404).send({ error: 'Benutzer nicht gefunden.' })
    if (target.role === 'admin') return reply.code(409).send({ error: 'Admin-Konten können hier nicht gelöscht werden.' })
    try {
      await action('delete', target.slug)
      await writeUsers(access.users.filter(user => user.username !== target.username))
      return { ok: true }
    } catch (err) {
      req.log.error({ err }, 'user delete failed')
      return reply.code(502).send({ error: 'Workspace konnte nicht sicher gelöscht werden; Benutzer wurde beibehalten.' })
    }
  })

  fastify.post('/api/admin/users/:username/instance/:operation', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const target = access.users.find(user => user.username === req.params.username && user.role === 'user')
    if (!target) return reply.code(404).send({ error: 'Workspace-Benutzer nicht gefunden.' })
    const operation = req.params.operation
    if (!['create', 'start', 'stop'].includes(operation)) return reply.code(400).send({ error: 'Ungültige Aktion.' })
    try { return { instance: await action(operation, target.slug) } }
    catch (err) { req.log.error({ err }, 'admin instance action failed'); return reply.code(502).send({ error: 'Instanzaktion fehlgeschlagen.' }) }
  })
}
