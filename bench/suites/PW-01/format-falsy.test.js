'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { createWarning } = require('../../index.js')

let n = 0
const make = (message) => createWarning({ name: 'W', code: `C_${++n}`, message, unlimited: true })
const emitted = (w, ...args) => new Promise((resolve) => {
  process.once('warning', (e) => resolve(e.message))
  w(...args)
})

test('format(0) interpolates 0', () => assert.equal(make('count=%d').format(0), 'count=0'))
test("format('') interpolates the empty string", () => assert.equal(make('v=[%s]').format(''), 'v=[]'))
test('format(false) interpolates false', () => assert.equal(make('v=%s').format(false), 'v=false'))
test('format(null) interpolates null', () => assert.equal(make('v=%s').format(null), 'v=null'))
test('a falsy second argument is interpolated', () => assert.equal(make('%s and %d').format('x', 0), 'x and 0'))
test('falsy second and third arguments are interpolated', () => assert.equal(make('%d/%d/%d').format(1, 0, 0), '1/0/0'))
test('no arguments: the message is unchanged', () => assert.equal(make('plain %s').format(), 'plain %s'))
test('trailing undefined is not supplied', () => { assert.equal(make('plain %s').format(undefined), 'plain %s'); assert.equal(make('a=%s b=%s').format(0, undefined), 'a=0 b=%s') })
test('an undefined before a supplied argument is interpolated', () => assert.equal(make('%s,%s,%s').format('x', undefined, 'z'), 'x,undefined,z'))
test('truthy arguments interpolate as before', () => assert.equal(make('%s-%s').format('a', 'b'), 'a-b'))
test('the emitted message interpolates 0 and has no trailing undefined', async () => {
  assert.equal(await emitted(make('count=%d'), 0), 'count=0')
})
test('the emitted message with two arguments, one falsy', async () => {
  assert.equal(await emitted(make('%s=%s'), 'k', ''), 'k=')
})
