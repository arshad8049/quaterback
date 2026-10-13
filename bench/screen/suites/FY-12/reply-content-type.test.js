'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

async function send (t, contentType) {
  const fastify = Fastify()
  t.after(() => fastify.close())
  fastify.get('/', (req, reply) => { reply.header('content-type', contentType).send({ hello: 'world' }) })
  return fastify.inject('/')
}

test('an upper-case CHARSET parameter is recognised (no second charset)', async (t) => {
  const res = await send(t, 'application/json; CHARSET=utf-8')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers['content-type'], 'application/json; CHARSET=utf-8')
})

test('a mixed-case JSON media type is treated as JSON', async (t) => {
  const res = await send(t, 'ApPlIcAtIoN/JsOn; ChArSeT=utf-8')
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.deepStrictEqual(res.json(), { hello: 'world' })
  t.assert.strictEqual(res.headers['content-type'], 'ApPlIcAtIoN/JsOn; ChArSeT=utf-8')
})

test('a JSON type without a charset parameter gets charset=utf-8', async (t) => {
  t.assert.strictEqual((await send(t, 'application/json; version="2"')).headers['content-type'], 'application/json; version="2"; charset=utf-8')
  t.assert.strictEqual((await send(t, 'application/vnd.api+json')).headers['content-type'], 'application/vnd.api+json; charset=utf-8')
  t.assert.strictEqual((await send(t, 'application/json;')).headers['content-type'], 'application/json; charset=utf-8')
})

test('a parameter whose name only contains "charset" is not a charset', async (t) => {
  const ct = (await send(t, 'application/json; x-charset-hint=a')).headers['content-type']
  t.assert.match(ct, /x-charset-hint=/)
  t.assert.match(ct, /; charset=utf-8$/)
})
