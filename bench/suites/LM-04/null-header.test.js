'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()

const fails = (headers, message) => assert.rejects(async () => inject(echo, { url: '/', headers }), { message })
test('null is rejected', () => fails({ 'x-a': null }, 'invalid value "null" for header x-a'))
test('undefined keeps its message', () => fails({ 'x-a': undefined }, 'invalid value "undefined" for header x-a'))
test('falsy non-null values are still sent', async () => { const h = (await send({ url: '/', headers: { 'x-z': 0, 'x-f': false, 'x-e': '' } })).headers; assert.equal(h['x-z'], '0'); assert.equal(h['x-f'], 'false'); assert.equal(h['x-e'], '') })
