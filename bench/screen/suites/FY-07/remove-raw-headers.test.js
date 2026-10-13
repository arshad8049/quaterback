'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

test('reply.removeHeader removes raw headers', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  const seen = {}
  fastify.get('/headers', function (req, reply) {
    reply.raw.setHeader('X-Foo', 'raw')
    seen.before = [reply.getHeader('x-foo'), reply.getHeaders()['x-foo'], reply.hasHeader('x-foo')]
    seen.returned = reply.removeHeader('x-FoO') === reply
    seen.after = [reply.getHeader('x-foo'), Object.hasOwn(reply.getHeaders(), 'x-foo'), reply.hasHeader('x-foo')]
    seen.again = reply.removeHeader('X-FOO') === reply
    reply.send()
  })
  const url = await fastify.listen({ port: 0, host: '127.0.0.1' })
  const response = await fetch(`${url}/headers`)
  t.assert.deepStrictEqual(seen.before, ['raw', 'raw', true])
  t.assert.strictEqual(seen.returned, true)
  t.assert.deepStrictEqual(seen.after, [undefined, false, false])
  t.assert.strictEqual(seen.again, true)
  t.assert.strictEqual(response.headers.get('x-foo'), null)
})

test('reply.removeHeader removes layered headers', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  const seen = {}
  fastify.get('/headers', function (req, reply) {
    reply.raw.setHeader('x-foo', 'raw')
    reply.header('x-foo', 'fastify')
    seen.before = reply.getHeader('x-foo')
    reply.removeHeader('x-foo')
    seen.after = [reply.getHeader('x-foo'), Object.hasOwn(reply.getHeaders(), 'x-foo'), reply.hasHeader('x-foo')]
    reply.send()
  })
  const url = await fastify.listen({ port: 0, host: '127.0.0.1' })
  const response = await fetch(`${url}/headers`)
  t.assert.strictEqual(seen.before, 'fastify')
  t.assert.deepStrictEqual(seen.after, [undefined, false, false])
  t.assert.strictEqual(response.headers.get('x-foo'), null)
})

test('reply.removeHeader does not throw after the headers are sent', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  let threw = null
  fastify.get('/headers', function (req, reply) {
    reply.hijack()
    reply.raw.setHeader('x-foo', 'raw')
    reply.raw.flushHeaders()
    try { reply.removeHeader('x-foo'); threw = false } catch (e) { threw = e }
    reply.raw.end()
  })
  const url = await fastify.listen({ port: 0, host: '127.0.0.1' })
  const response = await fetch(`${url}/headers`)
  t.assert.strictEqual(threw, false)
  t.assert.strictEqual(response.headers.get('x-foo'), 'raw')
})
