'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const arr = { type: 'array', items: { type: 'integer' } }
const stringifying = () => build(arr, { largeArraySize: 2, largeArrayMechanism: 'json-stringify' })

test('a later build without options uses the defaults', () => { stringifying(); assert.equal(build(arr)([1.5, 2.5, 3.5]), '[1,2,3]') })
test('a later build setting only the mechanism gets the default size', () => { stringifying(); assert.equal(build(arr, { largeArrayMechanism: 'json-stringify' })([1.5, 2.5, 3.5]), '[1,2,3]') })
test('a later build setting only the size gets the default mechanism', () => { stringifying(); const big = new Array(20001).fill(1.5); assert.equal(build(arr, { largeArraySize: 10 })(big), '[' + new Array(20001).fill(1).join(',') + ']') })
test('a default build after a size-only build is unaffected for large arrays', () => { build(arr, { largeArraySize: 2, largeArrayMechanism: 'json-stringify' }); const big = new Array(20001).fill(1.5); assert.equal(build(arr)(big), '[' + new Array(20001).fill(1).join(',') + ']') })
test('the json-stringify serializer keeps its behaviour', () => { const s = stringifying(); build(arr); assert.equal(s([1.5, 2.5, 3.5]), '[1.5,2.5,3.5]') })
