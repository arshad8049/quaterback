'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => res.end(JSON.stringify({ url: req.url, headers: req.headers }))

const run = async (c) => JSON.parse((await c).payload)
test('headers accumulate', async () => { const h = (await run(inject(echo).get('/').headers({ 'x-a': '1' }).headers({ 'x-b': '2' }))).headers; assert.equal(h['x-a'], '1'); assert.equal(h['x-b'], '2') })
test('later values win', async () => assert.equal((await run(inject(echo).get('/').headers({ 'x-a': '1' }).headers({ 'x-a': '2' }))).headers['x-a'], '2'))
test('initial options merge with chained headers', async () => { const h = (await run(inject(echo, { url: '/', headers: { 'x-a': '1' } }).headers({ 'x-b': '2' }))).headers; assert.deepEqual([h['x-a'], h['x-b']], ['1', '2']) })
test('query objects merge', async () => assert.equal((await run(inject(echo).get('/').query({ a: 1 }).query({ b: 2 }))).url, '/?a=1&b=2'))
test('a string query replaces', async () => assert.equal((await run(inject(echo).get('/').query({ a: 1 }).query('b=2'))).url, '/?b=2'))
test('cookies merge', async () => assert.equal((await run(inject(echo).get('/').cookies({ a: '1' }).cookies({ b: '2' }))).headers.cookie, 'a=1; b=2'))
test("the caller's object is not modified", async () => { const mine = { 'x-a': '1' }; await run(inject(echo, { url: '/', headers: mine }).headers({ 'x-b': '2' })); assert.deepEqual(mine, { 'x-a': '1' }) })
