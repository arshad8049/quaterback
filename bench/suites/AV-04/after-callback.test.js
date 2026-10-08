'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const avvio = require('../../index.js')

const check = (value, kind) => assert.throws(() => avvio().after(value), (e) => e.code === 'AVV_ERR_CALLBACK_NOT_FN' && e.message === `Callback for 'after' hook is not a function. Received: '${kind}'`)
test("after('x') throws synchronously", () => check('x', 'string'))
test('after(42) names the type', () => check(42, 'number'))
test('after({}) names the type', () => check({}, 'object'))
test('after() still returns a promise', async () => { const app = avvio(); app.use(function a (s, o, d) { d() }); const p = app.after(); assert.equal(typeof p.then, 'function'); await p })
test('after(fn) still runs fn', async () => { const app = avvio(); let ran = false; app.after((err, done) => { ran = !err; done() }); await app.ready(); assert.equal(ran, true) })
