'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()

const cookieOf = async (opts) => (await send({ url: '/', ...opts })).headers.cookie
test('header first, then cookies', async () => assert.equal(await cookieOf({ headers: { cookie: 'a=1' }, cookies: { b: '2' } }), 'a=1; b=2'))
test('cookies alone', async () => assert.equal(await cookieOf({ cookies: { b: '2', c: '3' } }), 'b=2; c=3'))
test('header alone', async () => assert.equal(await cookieOf({ headers: { cookie: 'a=1' } }), 'a=1'))
