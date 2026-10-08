'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const fmt = (format) => build({ type: 'object', properties: { d: { type: 'string', format } } })
const bad = (format) => assert.throws(() => fmt(format)({ d: new Date('nope') }), (e) => !(e instanceof RangeError) && e.message === `The value "Invalid Date" cannot be converted to a ${format}.`)

test('date-time: invalid Date', () => bad('date-time'))
test('date: invalid Date', () => bad('date'))
test('time: invalid Date', () => bad('time'))
test('valid values still serialize', () => {
  assert.equal(fmt('date-time')({ d: new Date('2024-01-02T03:04:05.000Z') }), '{"d":"2024-01-02T03:04:05.000Z"}')
  assert.equal(fmt('date')({ d: '2024-01-02' }), '{"d":"2024-01-02"}')
  assert.equal(fmt('time')({ d: null }), '{"d":""}')
})
