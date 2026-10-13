'use strict'

module.exports = async function (fastify) {
  fastify.get('/api/health', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } }
  }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return { status: 'ok', service: 'dev-instance-manager' }
  })
}
