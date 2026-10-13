'use strict'

const { test } = require('node:test')
const Request = require('../../lib/request')

const make = (remoteAddress, headers) => {
  const TpRequest = Request.buildRequest(Request, 1)
  return new TpRequest('id', 'params', { method: 'GET', url: '/', socket: { remoteAddress }, headers }, 'query', 'log')
}

test('trustProxy: 1 with an undefined socket address takes ip and host from the forwarded headers', (t) => {
  const r = make(undefined, { 'x-forwarded-for': '2.2.2.2, 1.1.1.1', 'x-forwarded-host': 'fastify.test', 'x-forwarded-proto': 'https' })
  t.assert.strictEqual(r.ip, '1.1.1.1')
  t.assert.strictEqual(r.host, 'fastify.test')
})

test('trustProxy: 1 with a null socket address takes ip from X-Forwarded-For', (t) => {
  const r = make(null, { 'x-forwarded-for': '2.2.2.2, 1.1.1.1', 'x-forwarded-host': 'fastify.test' })
  t.assert.strictEqual(r.ip, '1.1.1.1')
})
