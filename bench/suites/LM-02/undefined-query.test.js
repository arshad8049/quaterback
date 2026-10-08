'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()

const url = async (opts) => (await send(opts)).url
test('undefined values are omitted', async () => assert.equal(await url({ url: '/', query: { a: undefined, b: 1 } }), '/?b=1'))
test('undefined array elements are skipped', async () => assert.equal(await url({ url: '/', query: { c: [1, undefined, 2] } }), '/?c=1&c=2'))
test('an undefined value leaves an existing url parameter alone', async () => assert.equal(await url({ url: '/?a=keep', query: { a: undefined } }), '/?a=keep'))
test('null, 0 and empty string are still serialized', async () => assert.equal(await url({ url: '/', query: { n: null, z: 0, e: '' } }), '/?n=null&z=0&e='))
test('string queries are unchanged', async () => assert.equal(await url({ url: '/', query: 'a=1&b=2' }), '/?a=1&b=2'))
