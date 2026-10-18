'use strict'

const { test } = require('node:test')
const Fastify = require('../..')
const errors = require('../../lib/errors')

test('FST_ERR_ROUTE_LOG_LEVEL_INVALID is a 500 TypeError with the documented template', (t) => {
  const E = errors.FST_ERR_ROUTE_LOG_LEVEL_INVALID
  t.assert.strictEqual(typeof E, 'function')
  const error = new E()
  t.assert.strictEqual(error.name, 'FastifyError')
  t.assert.strictEqual(error.code, 'FST_ERR_ROUTE_LOG_LEVEL_INVALID')
  t.assert.strictEqual(error.message, "Log level for '%s:%s' route must be a valid logger level. Received: '%s'")
  t.assert.strictEqual(error.statusCode, 500)
  t.assert.ok(error instanceof TypeError)
})

test('registering a route with an unknown logLevel throws', (t) => {
  const fastify = Fastify({ logger: true })
  t.after(() => fastify.close())
  t.assert.throws(() => fastify.get('/log', { logLevel: 'invalid' }, (req, reply) => reply.send({})), (err) => {
    t.assert.strictEqual(err.code, 'FST_ERR_ROUTE_LOG_LEVEL_INVALID')
    t.assert.strictEqual(err.statusCode, 500)
    t.assert.strictEqual(err.message, "Log level for 'GET:/log' route must be a valid logger level. Received: 'invalid'")
    return true
  })
})

test('a non-string logLevel throws', (t) => {
  const fastify = Fastify({ logger: true })
  t.after(() => fastify.close())
  t.assert.throws(() => fastify.get('/n', { logLevel: 42 }, (req, reply) => reply.send({})), (err) => err.code === 'FST_ERR_ROUTE_LOG_LEVEL_INVALID')
})

test('a null logLevel and a valid level register normally', async (t) => {
  const fastify = Fastify({ logger: true })
  t.after(() => fastify.close())
  fastify.get('/null', { logLevel: null }, (req, reply) => reply.send({ hello: 'null' }))
  fastify.get('/debug', { logLevel: 'debug' }, (req, reply) => reply.send({ hello: 'debug' }))
  t.assert.deepStrictEqual((await fastify.inject({ method: 'GET', url: '/null' })).json(), { hello: 'null' })
  t.assert.deepStrictEqual((await fastify.inject({ method: 'GET', url: '/debug' })).json(), { hello: 'debug' })
})
