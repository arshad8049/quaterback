'use strict'

const { test } = require('node:test')
const Fastify = require('../..')

test('removing every trailer behaves like no trailer was registered', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  let called = false
  fastify.get('/', function (request, reply) {
    reply.trailer('ETag', function () { called = true })
    reply.removeTrailer('ETag')
    reply.send('hello')
  })
  const res = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.payload, 'hello')
  t.assert.strictEqual(res.headers.trailer, undefined)
  t.assert.strictEqual(res.headers['transfer-encoding'], undefined)
  t.assert.strictEqual(res.headers['content-length'], '5')
  t.assert.strictEqual(res.trailers.etag, undefined)
  t.assert.strictEqual(called, false)
})

test('removing some trailers keeps trailer mode for the remaining ones', async (t) => {
  const fastify = Fastify()
  t.after(() => fastify.close())
  let called = false
  fastify.get('/', function (request, reply) {
    reply.trailer('ETag', function () { called = true })
    reply.trailer('Content-MD5', function (reply, payload, done) { done(null, 'custom-md5') })
    reply.removeTrailer('ETag')
    reply.send('hello')
  })
  const res = await fastify.inject({ method: 'GET', url: '/' })
  t.assert.strictEqual(res.statusCode, 200)
  t.assert.strictEqual(res.headers.trailer, 'content-md5')
  t.assert.strictEqual(res.headers['transfer-encoding'], 'chunked')
  t.assert.strictEqual(res.headers['content-length'], undefined)
  t.assert.strictEqual(res.trailers['content-md5'], 'custom-md5')
  t.assert.strictEqual(called, false)
})
