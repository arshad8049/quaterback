'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

const route = {
  schema: { body: { type: 'object', properties: { name: { type: 'string' } } } },
  validatorCompiler: () => function () { throw new Error('Custom validation failed') },
  handler (request, reply) { reply.send({ success: true }) }
}

for (const [kind, hook] of [
  ['async', async () => { await Promise.resolve('ok') }],
  ['sync', (request, reply, next) => { next() }]
]) {
  test(`${kind} preValidation: a throwing validator reaches the error handler as an internal error`, async (t) => {
    const fastify = Fastify()
    t.after(() => fastify.close())
    let seen = null
    fastify.setErrorHandler((error, request, reply) => {
      seen = error
      reply.status(500).send({ error: error.message })
    })
    fastify.addHook('preValidation', hook)
    fastify.post('/', route)
    const res = await fastify.inject({ method: 'POST', url: '/', payload: { name: 'test' } })
    t.assert.ok(seen instanceof Error)
    t.assert.strictEqual(seen.message, 'Custom validation failed')
    t.assert.strictEqual(seen.statusCode, 500)
    t.assert.strictEqual(res.statusCode, 500)
    t.assert.deepStrictEqual(res.json(), { error: 'Custom validation failed' })
  })
}

test('without a custom error handler the default 500 response carries the message', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.addHook('preValidation', async () => {})
  fastify.post('/', route)
  const res = await fastify.inject({ method: 'POST', url: '/', payload: { name: 'test' } })
  t.assert.strictEqual(res.statusCode, 500)
  t.assert.strictEqual(res.json().message, 'Custom validation failed')
})
