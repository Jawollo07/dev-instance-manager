'use strict'

module.exports = async function (fastify) {
  // Keep the API process as the only public application entry point.
  fastify.get('/', async (_request, reply) => reply.redirect('/admin'))
}
