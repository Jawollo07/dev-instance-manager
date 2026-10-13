'use strict'

module.exports = async function (fastify) {
  fastify.get('/api/health', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return { status: 'ok', service: 'dev-instance-manager' }
  })
}
