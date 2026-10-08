'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const avvio = require('../../index.js')

const check = (value, kind) => assert.throws(() => avvio().use(value), (e) => e.code === 'AVV_ERR_PLUGIN_NOT_VALID' && e.message === `Plugin must be a function or a promise. Received: '${kind}'`)
test('an array is reported as array', () => check([], 'array'))
test('an array of plugins is reported as array', () => check([function a (s, o, d) { d() }], 'array'))
test('null is reported as null', () => check(null, 'null'))
test('a number is reported as number', () => check(42, 'number'))
test('functions and promises are still accepted', async () => { const app = avvio(); app.use(function f (s, o, d) { d() }); app.use(Promise.resolve(function g (s, o, d) { d() })); await app.ready() })
