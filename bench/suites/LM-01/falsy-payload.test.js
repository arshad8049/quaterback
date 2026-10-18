'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()

test('payload 0 is sent as JSON', async () => { const r = await send({ method: 'POST', url: '/', payload: 0 }); assert.equal(r.body, '0'); assert.equal(r.headers['content-type'], 'application/json'); assert.equal(r.headers['content-length'], '1') })
test('payload false is sent as JSON', async () => { const r = await send({ method: 'POST', url: '/', payload: false }); assert.equal(r.body, 'false'); assert.equal(r.headers['content-type'], 'application/json') })
test('body 0 is sent when there is no payload', async () => { const r = await send({ method: 'POST', url: '/', body: 0 }); assert.equal(r.body, '0') })
test('payload null sends nothing', async () => { const r = await send({ method: 'POST', url: '/', payload: null }); assert.equal(r.body, ''); assert.equal(r.headers['content-type'], undefined) })
test('payload 1 and objects are unchanged', async () => { assert.equal((await send({ method: 'POST', url: '/', payload: 1 })).body, '1'); assert.equal((await send({ method: 'POST', url: '/', payload: { a: 1 } })).body, '{"a":1}') })
test('string payloads are unchanged', async () => { const r = await send({ method: 'POST', url: '/', payload: 'hi' }); assert.equal(r.body, 'hi'); assert.equal(r.headers['content-type'], undefined) })
