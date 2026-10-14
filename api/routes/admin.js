'use strict'

const { currentUser, readUsers, writeUsers, hashPassword, USERNAME_RE, SLUG_RE } = require('../lib/auth')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const HELPER = process.env.DEVVM_HELPER || '/usr/local/sbin/devvm'
const BACKUP_HELPER = process.env.DEVVM_BACKUP_HELPER || '/usr/local/sbin/backup-devvm'
const { writeAudit, readAudit } = require('../lib/audit')
const ORIGIN = "https://dev.mcjj.de"
if (process.env.NODE_ENV === 'production' && !ORIGIN) throw new Error('PUBLIC_BASE_URL is required in production')

function allowedOrigin(req) { return ORIGIN ? req.headers.origin === ORIGIN : process.env.NODE_ENV !== 'production' }
async function admin(req, reply) {
  const username = await currentUser(req)
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

  // Workspaces are managed independently from user accounts. Deleting a workspace
  // does not delete the user or their credentials.
  fastify.get('/api/admin/workspaces', async (req, reply) => {
    const access = await admin(req, reply)
    if (!access) return
    const users = access.users.filter(user => user.role === 'user')
    reply.header('cache-control', 'no-store')
    return { workspaces: await Promise.all(users.map(async user => ({
      slug: user.slug,
      username: user.username,
      url: '/' + user.slug + '/',
      ...(await getInstance(user))
    }))) }
  })

  fastify.post('/api/admin/workspaces/:slug/:operation', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const { slug, operation } = req.params
    if (!SLUG_RE.test(slug || '') || ['admin', 'api', 'assets'].includes(slug)) return reply.code(400).send({ error: 'Ungültiger Workspace-Slug.' })
    const target = access.users.find(user => user.slug === slug && user.role === 'user')
    if (!target) return reply.code(404).send({ error: 'Keinem Benutzer zugeordneter Workspace nicht gefunden.' })
    if (!['create', 'start', 'stop'].includes(operation)) return reply.code(400).send({ error: 'Ungültige Aktion.' })
    try {
      const instance = await action(operation, slug)
      await writeAudit({ actor: access.actor.username, action: 'workspace.' + operation, target: target.username, status: 'success', details: { slug, independentManagement: true } })
      return { instance }
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'workspace.' + operation, target: target.username, status: 'failed', details: { slug } })
      req.log.error({ err, slug, operation }, 'workspace management action failed')
      return reply.code(502).send({ error: 'Workspace-Aktion fehlgeschlagen.' })
    }
  })

  fastify.delete('/api/admin/workspaces/:slug', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const { slug } = req.params
    const target = access.users.find(user => user.slug === slug && user.role === 'user')
    if (!target) return reply.code(404).send({ error: 'Workspace nicht gefunden.' })
    try {
      await action('delete', slug)
      await writeAudit({ actor: access.actor.username, action: 'workspace.delete', target: target.username, status: 'success', details: { slug, userAccountRetained: true } })
      return { ok: true, userRetained: true }
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'workspace.delete', target: target.username, status: 'failed', details: { slug } })
      req.log.error({ err, slug }, 'workspace delete failed')
      return reply.code(502).send({ error: 'Workspace konnte nicht gelöscht werden. Das Benutzerkonto bleibt unverändert.' })
    }
  })

  fastify.get('/api/admin/audit', async (req, reply) => {
    const access = await admin(req, reply)
    if (!access) return
    const rawLimit = Number(req.query?.limit ?? 50)
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 200)) : 50
    reply.header('cache-control', 'no-store')
    return { events: await readAudit(limit) }
  })

  fastify.post('/api/admin/backups', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    try {
      const result = await run('sudo', ['-n', BACKUP_HELPER], { timeout: 3600000, maxBuffer: 1048576 })
      await writeAudit({ actor: access.actor.username, action: 'backup.create', status: 'success' })
      reply.header('cache-control', 'no-store')
      return { ok: true, output: result.stdout.slice(-8000) }
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'backup.create', status: 'failed' })
      req.log.error({ err }, 'admin backup failed')
      return reply.code(502).send({ error: 'Backup fehlgeschlagen. Ist der root-eigene Backup-Helper installiert und in sudoers freigegeben?' })
    }
  })

  // Run an explicitly supplied shell command as the unprivileged coder user in each running user workspace.
  fastify.post('/api/admin/commands', {
    bodyLimit: 8192,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['command'],
        properties: { command: { type: 'string', minLength: 1, maxLength: 4096 } }
      }
    }
  }, async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const access = await admin(req, reply)
    if (!access) return
    const command = req.body.command.trim()
    if (!command) return reply.code(400).send({ error: 'Bitte einen Befehl eingeben.' })
    const targets = access.users.filter(user => user.role === 'user')
    await writeAudit({ actor: access.actor.username, action: 'workspace.command.broadcast', status: 'started', details: { targetCount: targets.length, commandLength: command.length } })
    req.log.info({ actor: access.actor.username, targetCount: targets.length, commandLength: command.length }, 'admin broadcast command requested')
    reply.header('cache-control', 'no-store')
    const results = await Promise.all(targets.map(async user => {
      const instance = await getInstance(user)
      if (!instance.exists) return { username: user.username, slug: user.slug, status: 'skipped', reason: 'Instanz existiert nicht.' }
      if (instance.status !== 'Running') return { username: user.username, slug: user.slug, status: 'skipped', reason: 'Instanz läuft nicht.' }
      try {
        const result = await run('sudo', ['-n', HELPER, 'exec', user.slug, command], { timeout: 65000, maxBuffer: 65536 })
        const parsed = JSON.parse(result.stdout)
        return { username: user.username, slug: user.slug, status: parsed.exitCode === 0 ? 'success' : 'failed', exitCode: parsed.exitCode, stdout: parsed.stdout, stderr: parsed.stderr }
      } catch (err) {
        req.log.warn({ err, slug: user.slug }, 'admin broadcast command failed')
        return { username: user.username, slug: user.slug, status: 'failed', reason: 'Befehl konnte nicht ausgeführt werden.' }
      }
    }))
    await writeAudit({ actor: access.actor.username, action: 'workspace.command.broadcast', status: 'finished', details: { targetCount: results.length, succeeded: results.filter(x => x.status === 'success').length, failed: results.filter(x => x.status === 'failed').length, skipped: results.filter(x => x.status === 'skipped').length } })
    return { command, results }
  })

  fastify.get('/api/admin/users', async (req, reply) => {
    const access = await admin(req, reply)
    if (!access) return
    reply.header('cache-control', 'no-store')
    const users = await Promise.all(access.users.map(async user => ({
      ...publicUser(user),
      instance: await getInstance(user)
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
          password: { type: 'string', minLength: 12, maxLength: 1024 },
          role: { type: 'string', enum: ['user', 'admin'] }
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
    const role = req.body.role || 'user'
    if (role === 'user' && access.users.filter(user => user.role === 'user').length >= 8) return reply.code(409).send({ error: 'Maximal acht Benutzer-Workspaces erlaubt.' })
    try {
      const password = await hashPassword(req.body.password)
      const user = { username, slug, role, disabled: false, ...password, createdAt: new Date().toISOString() }
      await writeUsers([...access.users, user])
      let instance = null
      if (role === 'user') instance = await action('create', slug)
      await writeAudit({ actor: access.actor.username, action: 'user.create', target: username, status: 'success', details: { slug, role } })
      return reply.code(201).send({ user: publicUser(user), instance })
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'user.create', target: username, status: 'failed', details: { slug } })
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
          password: { type: 'string', minLength: 12, maxLength: 1024 },
          role: { type: 'string', enum: ['user', 'admin'] }
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
    if (req.body.role !== undefined && req.body.role !== target.role) {
      if (target.role === 'admin' && req.body.role === 'user' && access.users.filter(user => user.role === 'admin' && user.disabled !== true).length <= 1) return reply.code(409).send({ error: 'Der letzte aktive Admin kann nicht herabgestuft werden.' })
      if (req.body.role === 'user' && target.role === 'admin') {
        if (access.users.filter(user => user.role === 'user').length >= 8) return reply.code(409).send({ error: 'Maximal acht Benutzer-Workspaces erlaubt.' })
        const instance = await getInstance(target)
        if (!instance.exists) {
          try { await action('create', target.slug) } catch (err) { req.log.error({ err }, 'workspace provision during role change failed'); return reply.code(502).send({ error: 'Workspace konnte beim Rollenwechsel nicht erstellt werden.' }) }
        }
      }
      target.role = req.body.role
    }
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
    await writeAudit({ actor: access.actor.username, action: req.body.password !== undefined ? 'user.password.reset' : req.body.role !== undefined ? 'user.role.change' : 'user.access.change', target: target.username, status: 'success', details: req.body.disabled === undefined ? {} : { disabled: target.disabled } })
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
      await writeAudit({ actor: access.actor.username, action: 'user.delete', target: target.username, status: 'success', details: { slug: target.slug } })
      return { ok: true }
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'user.delete', target: target.username, status: 'failed', details: { slug: target.slug } })
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
    try {
      const instance = await action(operation, target.slug)
      await writeAudit({ actor: access.actor.username, action: 'workspace.' + operation, target: target.username, status: 'success', details: { slug: target.slug } })
      return { instance }
    } catch (err) {
      await writeAudit({ actor: access.actor.username, action: 'workspace.' + operation, target: target.username, status: 'failed', details: { slug: target.slug } })
      req.log.error({ err }, 'admin instance action failed')
      return reply.code(502).send({ error: 'Instanzaktion fehlgeschlagen.' })
    }
  })
}
