'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

const asyncSchema = { $async: true, type: 'object', additionalProperties: true, properties: { hello: { type: 'string' } } }
const post = (fastify, body) => fastify.inject({ method: 'POST', url: '/', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const asyncApp = (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', { schema: { body: asyncSchema }, handler: async (request) => request.body })
  return fastify
}

test('a value key in the body does not replace the body (async schema)', async (t) => {
  const res = await post(asyncApp(t), { hello: 'world', value: { hello: 'evil' } })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world', value: { hello: 'evil' } })
})

test('an error key in the body is not a validation failure (async schema)', async (t) => {
  const res = await post(asyncApp(t), { hello: 'world', error: 'boom' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world', error: 'boom' })
})

test('an invalid body is still rejected (async schema)', async (t) => {
  t.assert.strictEqual((await post(asyncApp(t), { hello: { not: 'a string' } })).statusCode, 400)
})

test('the synchronous custom-compiler contract is unchanged', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.post('/', {
    schema: { body: { type: 'object' } },
    validatorCompiler: () => (data) => (data.ok === true ? { value: { replaced: true } } : { error: new Error('nope') }),
    handler: async (request) => request.body
  })
  t.assert.deepStrictEqual((await post(fastify, { ok: true })).json(), { replaced: true })
  t.assert.strictEqual((await post(fastify, { ok: false })).statusCode, 400)
})
