'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

const strict = { type: 'object', required: ['public'], additionalProperties: false, properties: { public: { type: 'string' } } }

async function reply (t, status, contentType) {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.get('/', { schema: { response: { [status]: { content: { 'application/json': { schema: strict } } } } } }, (req, reply) => {
    reply.header('Content-Type', contentType)
    reply.send({ public: 'ok', secret: 'SHOULD_BE_STRIPPED' })
  })
  return fastify.inject('/')
}

for (const ct of ['application/json ; charset=utf-8', 'application/json\t; charset=utf-8', 'application/json ;']) {
  test(`the 200 response schema applies for Content-Type ${JSON.stringify(ct)}`, async (t) => {
    const res = await reply(t, 200, ct)
    t.assert.strictEqual(res.statusCode, 200)
    t.assert.deepStrictEqual(res.json(), { public: 'ok' })
  })
}

test('a default response schema applies with whitespace before the parameters', async (t) => {
  const res = await reply(t, 'default', 'application/json ; charset=utf-8')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { public: 'ok' })
})
