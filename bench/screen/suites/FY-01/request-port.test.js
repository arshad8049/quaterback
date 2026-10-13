'use strict'

const { test } = require('node:test')
const Request = require('../../lib/request')

const portOf = (headers) => new Request(1, {}, { headers }, '', {}, {}).port

test('a Host header with a trailing port gives that port as a number', (t) => {
  t.assert.strictEqual(portOf({ host: 'example.com:80' }), 80)
  t.assert.strictEqual(portOf({ host: 'example.com:443' }), 443)
  t.assert.strictEqual(portOf({ host: 'localhost:3000' }), 3000)
  t.assert.strictEqual(portOf({ host: '[::1]:80' }), 80)
  t.assert.strictEqual(portOf({ host: '[::1]:443' }), 443)
})

test('a Host header without a port gives null', (t) => {
  t.assert.strictEqual(portOf({ host: '[::1]' }), null)
  t.assert.strictEqual(portOf({ host: '127.0.0.1' }), null)
  t.assert.strictEqual(portOf({ host: 'example.com' }), null)
})

test('without a Host header the :authority header is used; with neither, null', (t) => {
  t.assert.strictEqual(portOf({ ':authority': '1.2.3.4:80' }), 80)
  t.assert.strictEqual(portOf({}), null)
})
