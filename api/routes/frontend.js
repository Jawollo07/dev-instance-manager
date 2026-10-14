'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')

const WEB_DIST = path.resolve(process.env.DIM_WEB_DIST || path.join(__dirname, '../../web/dist'))
const ADMIN_HTML = path.join(WEB_DIST, 'admin.html')
const ASSETS_DIR = path.join(WEB_DIST, 'assets')

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
}

async function sendAdmin(req, reply) {
  try {
    const html = await fs.readFile(ADMIN_HTML)
    reply.header('cache-control', 'no-store')
    reply.type('text/html; charset=utf-8')
    return reply.send(html)
  } catch (err) {
    req.log.error({ err, file: ADMIN_HTML }, 'admin frontend unavailable')
    return reply.code(503).type('text/plain; charset=utf-8').send(
      'Admin-Frontend nicht gebaut. Bitte zuerst das Web-Frontend mit „pnpm --dir web build“ bauen.'
    )
  }
}

module.exports = async function (fastify) {
  // The API process is the public entry point: it serves the built admin UI itself.
  fastify.get('/admin', sendAdmin)
  fastify.get('/admin/', sendAdmin)
  fastify.get('/admin/*', sendAdmin)

  fastify.get('/assets/*', async (req, reply) => {
    const relative = req.params['*'] || ''
    const file = path.resolve(ASSETS_DIR, relative)
    if (file !== ASSETS_DIR && !file.startsWith(ASSETS_DIR + path.sep)) {
      return reply.code(400).send({ error: 'Ungültiger Asset-Pfad.' })
    }

    try {
      const data = await fs.readFile(file)
      const extension = path.extname(file).toLowerCase()
      reply.type(CONTENT_TYPES[extension] || 'application/octet-stream')
      if (/[.-][a-f0-9]{8,}[.-]/i.test(path.basename(file))) {
        reply.header('cache-control', 'public, max-age=31536000, immutable')
      } else {
        reply.header('cache-control', 'no-store')
      }
      return reply.send(data)
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') return reply.code(404).send({ error: 'Asset nicht gefunden.' })
      req.log.error({ err, file }, 'frontend asset read failed')
      return reply.code(500).send({ error: 'Frontend-Asset konnte nicht gelesen werden.' })
    }
  })
}
