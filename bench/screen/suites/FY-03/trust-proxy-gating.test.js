'use strict'

const { test } = require('node:test')
const Request = require('../../lib/request')

const make = (trustProxy, headers, remoteAddress = '127.0.0.1') => {
  const R = Request.buildRequest(Request, trustProxy)
  return new R('id', {}, { method: 'GET', url: '/', socket: { remoteAddress }, headers }, '', {}, {})
}
const spoof = { host: 'localhost:3000', 'x-forwarded-for': '1.1.1.1', 'x-forwarded-host': 'evil.com', 'x-forwarded-proto': 'https' }

test('an untrusted connection cannot spoof host, hostname or protocol', (t) => {
  const r = make('10.0.0.1', spoof)
  t.assert.strictEqual(r.host, 'localhost:3000')
  t.assert.strictEqual(r.hostname, 'localhost')
  t.assert.strictEqual(r.protocol, 'http')
})

test('a trusted connection uses X-Forwarded-Host and X-Forwarded-Proto', (t) => {
  const r = make((addr) => addr === '127.0.0.1', { host: 'localhost:3000', 'x-forwarded-for': '1.1.1.1', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' })
  t.assert.strictEqual(r.host, 'example.com')
  t.assert.strictEqual(r.protocol, 'https')
})

test('a trusted connection without X-Forwarded-For still has its forwarded host and protocol honoured', (t) => {
  const r = make((addr) => addr === '127.0.0.1', { host: 'localhost:3000', 'x-forwarded-host': 'example.com', 'x-forwarded-proto': 'https' })
  t.assert.strictEqual(r.host, 'example.com')
  t.assert.strictEqual(r.protocol, 'https')
})

test('trustProxy: true trusts every connection', (t) => {
  const r = make(true, { host: 'localhost:3000', 'x-forwarded-host': 'example.com' })
  t.assert.strictEqual(r.host, 'example.com')
})
