'use strict'

const http = require('node:http')
const https = require('node:https')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { readUsers, verifyPassword, currentUser, SLUG_RE } = require('../lib/auth')
const run = promisify(execFile)
const HELPER = process.env.DEVVM_HELPER || '/usr/local/sbin/devvm'
const ORIGIN = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : null
if (process.env.NODE_ENV === 'production' && !ORIGIN) throw new Error('PUBLIC_BASE_URL is required in production')
function originAllowed(req) { if (ORIGIN) return req.headers.origin === undefined ? ['GET', 'HEAD', 'OPTIONS'].includes(req.method) : req.headers.origin === ORIGIN; return process.env.NODE_ENV !== 'production' }

async function identify(slug, header, req) {
  if (!SLUG_RE.test(slug || '')) return null
  const users = await readUsers()

  // The shared login creates an HttpOnly session cookie. Bind that session to
  // exactly one enabled user and that user's slug; never accept a client slug
  // as an identity by itself.
  if (!header && req) {
    const username = currentUser(req)
    return username
      ? users.find(item => item.username === username && item.slug === slug && item.role === 'user' && item.disabled !== true) || null
      : null
  }

  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header || '')
  if (!match) return null
  let decoded
  try { decoded = Buffer.from(match[1], 'base64').toString('utf8') } catch { return null }
  const split = decoded.indexOf(':')
  if (split <= 0) return null
  const username = decoded.slice(0, split)
  const password = decoded.slice(split + 1)
  if (!username || password.length > 1024) return null
  const user = users.find(item => item.username === username && item.slug === slug && item.role === 'user' && item.disabled !== true)
  const valid = await verifyPassword(password, user)
  return valid ? user : null
}

async function status(slug) {
  const result = await run('sudo', ['-n', HELPER, 'status', slug], { timeout: 30000, maxBuffer: 1048576 })
  return JSON.parse(result.stdout)
}

function challenge(reply) {
  reply.header('WWW-Authenticate', 'Basic realm="VS Code Workspace", charset="UTF-8"')
  reply.header('Cache-Control', 'no-store')
  return reply.code(401).send({ error: 'Anmeldung mit Workspace-Zugangsdaten erforderlich.' })
}

function cleanHeaders(headers, host, ip) {
  const out = { ...headers }
  for (const key of Object.keys(out)) {
    const lower = key.toLowerCase()
    if (lower === 'authorization' || lower === 'proxy-authorization' ||
        lower === 'host' || lower.startsWith('x-forwarded-') || lower.startsWith('x-authentik-')) delete out[key]
    if (lower === 'cookie') {
      const filtered = String(out[key]).split(';').map(part => part.trim()).filter(part => !/^dim_session=/i.test(part))
      if (filtered.length) out[key] = filtered.join('; ')
      else delete out[key]
    }
  }
  out.host = host
  out['x-forwarded-for'] = ip
  out['x-forwarded-proto'] = 'https'
  return out
}

// Fixed-origin reverse proxy for Open VSX. It is deliberately not a generic URL proxy.
function proxyOpenVSX(req, reply, slug, publicUrl) {
  const prefix = '/' + slug + '/_dim-proxy/open-vsx'
  const upstreamPath = publicUrl.pathname.slice(prefix.length) || '/'
  if (!upstreamPath.startsWith('/') || upstreamPath.startsWith('//')) {
    return reply.code(400).send({ error: 'Ungültiger Marketplace-Pfad.' })
  }
  const headers = cleanHeaders(req.headers, 'open-vsx.org', req.ip)
  headers.host = 'open-vsx.org'
  headers['accept-encoding'] = 'identity'
  let body
  if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
    body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    headers['content-length'] = String(body.length)
    delete headers['transfer-encoding']
  }
  const upstream = https.request({
    hostname: 'open-vsx.org',
    port: 443,
    path: upstreamPath + publicUrl.search,
    method: req.method,
    headers,
    timeout: 30000
  }, res => {
    const statusCode = res.statusCode || 502
    const outHeaders = { ...res.headers }
    delete outHeaders['content-security-policy']
    if (outHeaders.location) {
      try {
        const location = new URL(outHeaders.location, 'https://open-vsx.org')
        if (location.hostname === 'open-vsx.org' && location.protocol === 'https:') {
          outHeaders.location = 'https://' + (ORIGIN ? new URL(ORIGIN).host : (req.headers.host || 'vs.code.de')) + prefix + location.pathname + location.search + location.hash
        }
      } catch {}
    }
    const contentType = String(outHeaders['content-type'] || '')
    if (!contentType.includes('json')) {
      reply.raw.writeHead(statusCode, outHeaders)
      res.pipe(reply.raw)
      return
    }
    const chunks = []
    let bytes = 0
    res.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 12 * 1024 * 1024) {
        res.destroy(new Error('Marketplace JSON response too large'))
        return
      }
      chunks.push(chunk)
    })
    res.on('end', () => {
      if (reply.raw.destroyed) return
      let text = Buffer.concat(chunks).toString('utf8')
      const publicOrigin = ORIGIN || ('https://' + (req.headers.host || 'vs.code.de'))
      const localBase = publicOrigin + prefix
      text = text.replace(/https?:\/\/open-vsx\.org/gi, localBase)
      delete outHeaders['content-length']
      delete outHeaders['content-encoding']
      outHeaders['content-length'] = Buffer.byteLength(text)
      reply.raw.writeHead(statusCode, outHeaders)
      reply.raw.end(text)
    })
    res.on('error', err => {
      req.log.warn({ err, slug }, 'Open VSX response failed')
      if (!reply.raw.headersSent) reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      reply.raw.end('Marketplace-Proxy fehlgeschlagen.')
    })
  })
  upstream.on('timeout', () => upstream.destroy(new Error('Open VSX request timed out')))
  upstream.on('error', err => {
    req.log.warn({ err, slug }, 'Open VSX upstream failed')
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      reply.raw.end('Marketplace momentan nicht erreichbar.')
    } else reply.raw.destroy(err)
  })
  req.raw.on('aborted', () => upstream.destroy())
  if (body !== undefined) upstream.end(body)
  else req.raw.pipe(upstream)
}

function upgradeError(socket, code, reason, extra = '') {
  if (!socket.destroyed) socket.end('HTTP/1.1 ' + code + ' ' + reason + '\r\n' + extra + 'Connection: close\r\nContent-Length: 0\r\n\r\n')
}

module.exports = async function (fastify) {
  async function proxy(req, reply, slug) {
    // These URL prefixes belong to the API/frontend, never to a workspace.
    if (['admin', 'api', 'assets'].includes(slug)) return reply.code(404).send({ error: 'Route nicht gefunden.' })
    let user
    try { user = await identify(slug, req.headers.authorization, req) }
    catch (err) { req.log.error({ err }, 'workspace authentication failed'); return reply.code(503).send({ error: 'Authentifizierung momentan nicht verfügbar.' }) }
    if (!user) {
      // Browser navigation should land on the shared login form instead of
      // triggering the browser's native Basic Auth dialog.
      if (!req.headers.authorization && ['GET', 'HEAD'].includes(req.method)) {
        reply.header('cache-control', 'no-store')
        return reply.redirect('/')
      }
      return challenge(reply)
    }
    if (!originAllowed(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })

    const publicUrl = new URL(req.raw.url, 'http://workspace.invalid')
    // Gallery metadata and downloads are served from this domain and routed only
    // to the fixed Open VSX origin. Requests still require the workspace's Basic Auth.
    if (publicUrl.pathname.startsWith('/' + slug + '/_dim-proxy/open-vsx/')) {
      reply.hijack()
      return proxyOpenVSX(req, reply, slug, publicUrl)
    }

    let vm
    try { vm = await status(slug) }
    catch (err) { req.log.error({ err }, 'workspace status failed'); return reply.code(503).send({ error: 'Workspace-Status nicht verfügbar.' }) }
    if (!vm.exists) return reply.code(404).send({ error: 'Workspace wurde noch nicht erstellt.' })
    if (vm.status !== 'Running' || !vm.ip) return reply.code(409).send({ error: 'Workspace ist gestoppt. Bitte Admin kontaktieren.' })

    if (publicUrl.pathname === '/' + slug) {
      reply.header('Location', '/' + slug + '/' + (publicUrl.search || ''))
      return reply.code(308).send()
    }

    // code-server does not support a general --base-path option. Strip the
    // public workspace prefix before forwarding so code-server receives normal
    // paths such as /, /static/... and /healthz.
    const prefix = '/' + slug
    const upstreamPath = publicUrl.pathname === prefix
      ? '/'
      : publicUrl.pathname.startsWith(prefix + '/')
        ? publicUrl.pathname.slice(prefix.length)
        : null
    if (upstreamPath === null) return reply.code(404).send({ error: 'Workspace-Route nicht gefunden.' })
    const targetPath = upstreamPath + publicUrl.search
    const headers = cleanHeaders(req.headers, vm.ip + ':8080', req.ip)
    let body
    if (req.body !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
      body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
      headers['content-length'] = String(body.length)
      delete headers['transfer-encoding']
    }
    reply.hijack()
    const upstream = http.request({ hostname: vm.ip, port: 8080, path: targetPath, method: req.method, headers })
    upstream.on('response', res => {
      const responseHeaders = { ...res.headers }
      // Never expose the private LXD address in a redirect. code-server may
      // emit an absolute Location based on the upstream Host header.
      if (responseHeaders.location) {
        try {
          const originalLocation = responseHeaders.location
          const location = new URL(originalLocation, 'http://' + vm.ip + ':8080')
          const upstreamHosts = new Set([vm.ip, vm.ip + ':8080', '127.0.0.1:8080', 'localhost:8080'])
          if (upstreamHosts.has(location.host) || location.hostname === vm.ip) {
            const publicOrigin = ORIGIN || ('https://' + (req.headers.host || 'vs.code.de'))
            responseHeaders.location = publicOrigin + prefix + (location.pathname.startsWith('/') ? location.pathname : '/' + location.pathname) + location.search + location.hash
          } else if (originalLocation.startsWith('/') && !originalLocation.startsWith('//')) {
            // Root-relative code-server redirects must stay inside this user's path.
            const publicOrigin = ORIGIN || ('https://' + (req.headers.host || 'vs.code.de'))
            responseHeaders.location = publicOrigin + prefix + location.pathname + location.search + location.hash
          }
        } catch {}
      }
      reply.raw.writeHead(res.statusCode || 502, responseHeaders)
      res.pipe(reply.raw)
    })
    upstream.on('error', err => {
      req.log.warn({ err, slug }, 'workspace upstream failed')
      if (!reply.raw.headersSent) { reply.raw.writeHead(502, { 'content-type': 'text/plain' }); reply.raw.end('Workspace noch nicht bereit.') }
      else reply.raw.destroy(err)
    })
    req.raw.on('aborted', () => upstream.destroy())
    if (body !== undefined) upstream.end(body)
    else req.raw.pipe(upstream)
  }

  fastify.all('/:slug', async (req, reply) => proxy(req, reply, req.params.slug))
  fastify.all('/:slug/*', async (req, reply) => proxy(req, reply, req.params.slug))

  fastify.server.on('upgrade', async (req, socket, head) => {
    let url
    try { url = new URL(req.url, 'http://localhost') } catch { return upgradeError(socket, 400, 'Bad Request') }
    const slug = url.pathname.split('/')[1]
    if (!SLUG_RE.test(slug || '') || ['admin', 'api', 'assets'].includes(slug)) return
    let user
    try { user = await identify(slug, req.headers.authorization) }
    catch (err) { fastify.log.error({ err }, 'workspace websocket auth failed'); return upgradeError(socket, 503, 'Service Unavailable') }
    if (!user) return upgradeError(socket, 401, 'Unauthorized', 'WWW-Authenticate: Basic realm="VS Code Workspace", charset="UTF-8"\r\n')
    if (!ORIGIN || req.headers.origin !== ORIGIN) return upgradeError(socket, 403, 'Forbidden')
    try {
      const vm = await status(slug)
      if (!vm.exists || vm.status !== 'Running' || !vm.ip) return upgradeError(socket, 409, 'Workspace Not Ready')
      const headers = cleanHeaders(req.headers, vm.ip + ':8080', req.socket.remoteAddress || '')
      headers.connection = 'Upgrade'
      headers.upgrade = 'websocket'
      headers['x-forwarded-host'] = req.headers.host || ''
      // Strip the public workspace prefix for code-server's WebSocket endpoint too.
      const prefix = '/' + slug
      const upstreamPath = url.pathname === prefix
        ? '/'
        : url.pathname.startsWith(prefix + '/')
          ? url.pathname.slice(prefix.length)
          : null
      if (upstreamPath === null) return upgradeError(socket, 404, 'Not Found')
      const targetPath = upstreamPath + url.search
      const upstream = http.request({ hostname: vm.ip, port: 8080, path: targetPath, method: 'GET', headers })
      upstream.on('upgrade', (res, remote, remoteHead) => {
        fastify.log.debug({ slug, path: targetPath, statusCode: res.statusCode }, 'workspace websocket upgraded')
        const lines = []
        for (let i = 0; i < res.rawHeaders.length; i += 2) lines.push(res.rawHeaders[i] + ': ' + res.rawHeaders[i + 1])
        socket.write('HTTP/1.1 ' + res.statusCode + ' ' + res.statusMessage + '\r\n' + lines.join('\r\n') + '\r\n\r\n')
        if (head.length) remote.write(head)
        if (remoteHead.length) socket.write(remoteHead)
        socket.pipe(remote); remote.pipe(socket)
        socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy())
      })
      upstream.on('response', res => {
        fastify.log.warn({ slug, path: targetPath, statusCode: res.statusCode }, 'workspace websocket upstream rejected upgrade')
        upgradeError(socket, res.statusCode || 502, 'Upgrade Failed')
        res.resume()
      })
      upstream.on('error', err => { fastify.log.warn({ err, slug }, 'workspace websocket proxy failed'); upgradeError(socket, 502, 'Workspace Unavailable') })
      upstream.end()
    } catch (err) { fastify.log.error({ err }, 'workspace websocket failed'); upgradeError(socket, 503, 'Service Unavailable') }
  })
}
