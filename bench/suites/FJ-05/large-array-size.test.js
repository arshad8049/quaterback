'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const arr = { type: 'array', items: { type: 'integer' } }
const rejects = (size) => assert.throws(() => build(arr, { largeArraySize: size }), { message: `Unsupported large array size. Expected integer-like, got ${typeof size} with value ${size}` })

test("'20000abc' is rejected", () => rejects('20000abc'))
test("'1.5' is rejected", () => rejects('1.5'))
test("' 100' is rejected", () => rejects(' 100'))
test("'1e3' is rejected", () => rejects('1e3'))
test('-5 is rejected', () => rejects(-5))
test('-5n is rejected', () => rejects(-5n))
test('valid sizes work', () => {
  for (const size of [100, '100', 100n]) assert.equal(build(arr, { largeArraySize: size })([1.5]), '[1]')
  assert.equal(build(arr, { largeArraySize: '2', largeArrayMechanism: 'json-stringify' })([1.5, 2.5]), '[1.5,2.5]')
})
