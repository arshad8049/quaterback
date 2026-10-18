'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const s = build({ type: 'object', properties: { at: { type: 'string', format: 'date-time' } } })

test('0 is the epoch', () => assert.equal(s({ at: 0 }), '{"at":"1970-01-01T00:00:00.000Z"}'))
test('milliseconds, not seconds', () => assert.equal(s({ at: 1704164645000 }), '{"at":"2024-01-02T03:04:05.000Z"}'))
test('the output is valid JSON with a string', () => assert.equal(typeof JSON.parse(s({ at: 86400000 })).at, 'string'))
test('NaN is rejected with the usual error', () => assert.throws(() => s({ at: NaN }), { message: 'The value "NaN" cannot be converted to a date-time.' }))
test('Infinity is rejected with the usual error', () => assert.throws(() => s({ at: Infinity }), { message: 'The value "Infinity" cannot be converted to a date-time.' }))
test('the largest representable timestamp serializes', () => assert.equal(s({ at: 8.64e15 }), '{"at":"+275760-09-13T00:00:00.000Z"}'))
test('a finite timestamp outside the Date range is rejected with the usual error', () => {
  assert.throws(() => s({ at: 8640000000000001 }), (e) => !(e instanceof RangeError) && e.message === 'The value "8640000000000001" cannot be converted to a date-time.')
  assert.throws(() => s({ at: -1e20 }), { message: 'The value "-100000000000000000000" cannot be converted to a date-time.' })
})
test('Date objects and strings are unchanged', () => { assert.equal(s({ at: new Date(0) }), '{"at":"1970-01-01T00:00:00.000Z"}'); assert.equal(s({ at: 'x' }), '{"at":"x"}') })
