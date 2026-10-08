'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()
const fs = require('node:fs')
const path = require('node:path')
const { Chain } = require('../../lib/chain.js')

test('lib/chain exports Chain and inject returns it', () => { assert.equal(typeof Chain, 'function'); const c = inject(echo, { url: '/', autoStart: false }); assert.ok(c instanceof Chain) })
test('index.js no longer defines Chain', () => assert.equal(/function\s+Chain\s*\(/.test(fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8')), false))
test('setters and await work', async () => { const r = (await inject(echo).post('/p').headers({ 'x-a': '1' }).query({ q: 2 }).payload({ v: 1 })).json(); assert.equal(r.url, '/p?q=2'); assert.equal(r.headers['x-a'], '1'); assert.equal(r.body, '{"v":1}') })
test('end(callback) works', (t, done) => { inject(echo).get('/cb').end((err, res) => { assert.ifError(err); assert.equal(res.json().url, '/cb'); done() }) })
test('autostart runs the request', async () => { const r = await new Promise((resolve) => inject((req, res) => { resolve(req.url); res.end() }, '/auto')); assert.equal(r, '/auto') })
test('re-invoking throws the same error', async () => { const c = inject(echo).get('/'); await c; assert.throws(() => c.get('/again'), { message: 'The dispatch function has already been invoked' }); assert.throws(() => c.end(), { message: 'The dispatch function has already been invoked' }) })
