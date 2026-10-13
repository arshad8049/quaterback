'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

const post = (fastify, payload) => fastify.inject({ method: 'POST', url: '/', payload, headers: { 'content-type': 'application/json' } })
const echo = (request, reply) => reply.send({ body: request.body, type: typeof request.body })

test('a root integer coerced by Ajv reaches the handler as a number', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', { schema: { body: { type: 'integer', minimum: 1, maximum: 10 } } }, echo)
  const res = await post(fastify, '"10"')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { body: 10, type: 'number' })
})

test('a root boolean coerced by Ajv reaches the handler as a boolean', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', { schema: { body: { type: 'boolean' } } }, echo)
  const res = await post(fastify, '"true"')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { body: true, type: 'boolean' })
})

test('an out-of-range root value is still rejected', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', { schema: { body: { type: 'integer', minimum: 1, maximum: 10 } } }, echo)
  t.assert.strictEqual((await post(fastify, '"0"')).statusCode, 400)
})

test('a custom validatorCompiler keeps working', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', {
    schema: { body: { type: 'object' } },
    validatorCompiler: () => (data) => (data && data.ok === true ? { value: data } : { error: new Error('not ok') })
  }, echo)
  t.assert.deepStrictEqual((await post(fastify, '{"ok":true}')).json(), { body: { ok: true }, type: 'object' })
  t.assert.strictEqual((await post(fastify, '{"ok":false}')).statusCode, 400)
})
