'use strict'
const { currentUser } = require('../lib/auth')
const http = require('node:http')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const run = promisify(execFile)
const HELPER = process.env.DEVVM_HELPER || '/usr/local/sbin/devvm'
const ORIGIN = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : null
if (process.env.NODE_ENV === 'production' && !ORIGIN) throw new Error('PUBLIC_BASE_URL is required in production')

function allowedOrigin(req) { return ORIGIN ? req.headers.origin === ORIGIN : process.env.NODE_ENV !== 'production' }
function requireUser(req, reply) {\n  const user = currentUser(req)\n  if (!user) { reply.code(401).send({ error: 'Bitte anmelden.' }); return null }\n  return user\n}\nasync function action(name, user) {
  const result = await run('sudo', ['-n', HELPER, name, user], { timeout: name === 'create' ? 900000 : 30000, maxBuffer: 1048576 })
  return JSON.parse(result.stdout)
}
function headersFor(headers, host, ip) {
  const out = { ...headers }
  for (const key of Object.keys(out)) {
    const k = key.toLowerCase()
    if (k === 'cookie' || k === 'authorization' || k === 'proxy-authorization' || k.startsWith('x-authentik-') || k.startsWith('x-forwarded-')) delete out[key]
  }
  out.host = host
  out['x-forwarded-for'] = ip
  return out
}
function upgradeError(socket, code, reason) {
  if (!socket.destroyed) socket.end('HTTP/1.1 ' + code + ' ' + reason + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
}

module.exports = async function (fastify) {
  fastify.get('/api/instance', async (req, reply) => {
    const user = requireUser(req, reply)
    if (!user) return
    try { return { user, instance: await action('status', user) } }
    catch (err) { req.log.error({ err }, 'status failed'); return reply.code(503).send({ error: 'Instanzstatus nicht verfügbar.' }) }
  })
  for (const name of ['create', 'start', 'stop']) {
    fastify.post('/api/instance/' + name, async (req, reply) => {
      const user = requireUser(req, reply)
      if (!user) return
      if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
      try { return reply.code(name === 'create' ? 202 : 200).send({ instance: await action(name, user) }) }
      catch (err) { req.log.error({ err }, 'instance action failed'); return reply.code(502).send({ error: 'Aktion fehlgeschlagen: ' + name }) }
    })
  }

  async function workspace(req, reply) {
    const user = requireUser(req, reply)
    if (!user) return
    if (req.headers.origin && !allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    let vm
    try { vm = await action('status', user) }
    catch (err) { req.log.error({ err }, 'workspace status failed'); return reply.code(503).send({ error: 'Workspace nicht erreichbar.' }) }
    if (!vm.exists) return reply.code(404).send({ error: 'Workspace noch nicht erstellt.' })
    if (vm.status !== 'Running' || !vm.ip) return reply.code(409).send({ error: 'Workspace zuerst starten.' })

    const proxyHeaders = headersFor(req.headers, vm.ip + ':8080', req.ip)
    let body
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      proxyHeaders['content-length'] = String(body.length)
      delete proxyHeaders['transfer-encoding']
    }
    // Hijack before returning so Fastify does not auto-send an empty response.
    reply.hijack()
    const upstream = http.request({ hostname: vm.ip, port: 8080, path: req.raw.url, method: req.method, headers: proxyHeaders })
    upstream.on('response', (res) => { reply.raw.writeHead(res.statusCode || 502, res.headers); res.pipe(reply.raw) })
    upstream.on('error', (err) => {
      req.log.warn({ err }, 'workspace upstream failed')
      if (!reply.raw.headersSent) { reply.raw.writeHead(502, { 'content-type': 'text/plain' }); reply.raw.end('Workspace noch nicht bereit.') }
      else reply.raw.destroy(err)
    })
    req.raw.on('aborted', () => upstream.destroy())
    if (body !== undefined) upstream.end(body)
    else req.raw.pipe(upstream)
    return
  }
  fastify.all('/workspace', workspace)
  fastify.all('/workspace/*', workspace)

  fastify.server.on('upgrade', async (req, socket, head) => {
    let path
    try { path = new URL(req.url, 'http://localhost').pathname } catch { return upgradeError(socket, 400, 'Bad Request') }
    if (path !== '/workspace' && !path.startsWith('/workspace/')) return
    const user = currentUser(req)
    if (!user) return upgradeError(socket, 401, 'Unauthorized')
    if (ORIGIN && req.headers.origin !== ORIGIN) return upgradeError(socket, 403, 'Forbidden')
    try {
      const vm = await action('status', user)
      if (!vm.exists || vm.status !== 'Running' || !vm.ip) return upgradeError(socket, 409, 'Workspace Not Ready')
      const upstream = http.request({ hostname: vm.ip, port: 8080, path: req.url, method: 'GET', headers: headersFor(req.headers, vm.ip + ':8080', req.socket.remoteAddress || '') })
      upstream.on('upgrade', (res, remote, remoteHead) => {
        const lines = []
        for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(res.rawHeaders[i] + ': ' + res.rawHeaders[i + 1])
        socket.write('HTTP/1.1 ' + res.statusCode + ' ' + res.statusMessage + '\r\n' + lines.join('\r\n') + '\r\n\r\n')
        if (head.length) remote.write(head)
        if (remoteHead.length) socket.write(remoteHead)
        socket.pipe(remote); remote.pipe(socket)
        socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy())
      })
      upstream.on('response', (res) => { upgradeError(socket, res.statusCode || 502, 'Upgrade Failed'); res.resume() })
      upstream.on('error', (err) => { fastify.log.warn({ err }, 'websocket proxy failed'); upgradeError(socket, 502, 'Workspace Unavailable') })
      upstream.end()
    } catch (err) { fastify.log.error({ err }, 'websocket status failed'); upgradeError(socket, 503, 'Workspace Unavailable') }
  })
}
