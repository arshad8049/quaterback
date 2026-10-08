'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const peer = (req, res) => res.end(JSON.stringify({ ip: req.socket.remoteAddress, host: req.headers.host }))
const send = async (opts) => (await inject(echo, opts)).json()

test('remoteAddress sets the socket address', async () => assert.equal((await inject(peer).get('/').remoteAddress('10.0.0.1')).json().ip, '10.0.0.1'))
test('authority sets the host header', async () => assert.equal((await inject(peer).get('/').authority('example.test')).json().host, 'example.test'))
test('they chain with the other setters', async () => { const r = (await inject(peer).get('/').remoteAddress('10.0.0.2').authority('a.test').headers({ x: '1' })).json(); assert.deepEqual(r, { ip: '10.0.0.2', host: 'a.test' }) })
test('remoteAddress after invocation throws', async () => { const c = inject(peer).get('/'); await c; assert.throws(() => c.remoteAddress('1.1.1.1'), { message: 'The dispatch function has already been invoked' }) })
test('authority after invocation throws', async () => { const c = inject(peer).get('/'); await c; assert.throws(() => c.authority('x'), { message: 'The dispatch function has already been invoked' }) })
