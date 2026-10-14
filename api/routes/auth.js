'use strict'

const { readUsers, verifyPassword, createSession, currentUser, destroySession, setSessionCookie, clearSessionCookie } = require('../lib/auth')

const ORIGIN = process.env.PUBLIC_BASE_URL ? new URL(process.env.PUBLIC_BASE_URL).origin : null
if (process.env.NODE_ENV === 'production' && !ORIGIN) throw new Error('PUBLIC_BASE_URL is required in production')

function allowedOrigin(req) {
  return ORIGIN ? req.headers.origin === ORIGIN : process.env.NODE_ENV !== 'production'
}

function destinationFor(user) {
  return user.role === 'admin' ? '/admin' : '/' + encodeURIComponent(user.slug) + '/'
}

module.exports = async function (fastify) {
  fastify.post('/api/auth/login', {
    bodyLimit: 2048,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 64 },
          password: { type: 'string', minLength: 1, maxLength: 1024 }
        }
      }
    }
  }, async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    const username = req.body.username.trim()
    if (!/^[a-zA-Z0-9@._+-]{1,64}$/.test(username)) {
      return reply.code(401).send({ error: 'Benutzername oder Passwort ungültig.' })
    }
    try {
      const users = await readUsers()
      const user = users.find(candidate => candidate.username === username)
      const valid = await verifyPassword(req.body.password, user)
      if (!valid) {
        await new Promise(resolve => setTimeout(resolve, 250))
        return reply.code(401).send({ error: 'Benutzername oder Passwort ungültig.' })
      }
      setSessionCookie(reply, createSession(user.username))
      reply.header('cache-control', 'no-store')
      return { user: user.username, role: user.role, redirectTo: destinationFor(user) }
    } catch (err) {
      req.log.error({ err }, 'login failed')
      return reply.code(503).send({ error: 'Anmeldung momentan nicht möglich.' })
    }
  })

  fastify.get('/api/auth/me', async (req, reply) => {
    const username = currentUser(req)
    reply.header('cache-control', 'no-store')
    if (!username) return reply.code(401).send({ error: 'Bitte anmelden.' })
    try {
      const user = (await readUsers()).find(candidate => candidate.username === username && candidate.disabled !== true)
      if (!user) {
        destroySession(req)
        clearSessionCookie(reply)
        return reply.code(401).send({ error: 'Bitte erneut anmelden.' })
      }
      return { user: user.username, role: user.role, redirectTo: destinationFor(user) }
    } catch (err) {
      req.log.error({ err }, 'session lookup failed')
      return reply.code(503).send({ error: 'Sitzung momentan nicht verfügbar.' })
    }
  })

  fastify.post('/api/auth/logout', async (req, reply) => {
    if (!allowedOrigin(req)) return reply.code(403).send({ error: 'Ungültiger Origin.' })
    destroySession(req)
    clearSessionCookie(reply)
    reply.header('cache-control', 'no-store')
    return { ok: true }
  })
}
