'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const pw = require('../../index.js')
process.removeAllListeners('warning')
process.on('warning', () => {})

const base = { name: 'W', code: 'C', message: 'm' }
const throwsMsg = (opts, msg) => assert.throws(() => pw.createWarning({ ...base, ...opts }), (e) => e instanceof Error && e.message === msg)

test('a numeric code is rejected with a clear message', () => throwsMsg({ code: 123 }, 'Warning code must be a string'))
test('an object name is rejected', () => throwsMsg({ name: {} }, 'Warning name must be a string'))
test('a numeric message is rejected', () => throwsMsg({ message: 42 }, 'Warning message must be a string'))
test('an array code is rejected', () => throwsMsg({ code: ['X'] }, 'Warning code must be a string'))
test('a zero code is not empty: it is not a string', () => throwsMsg({ code: 0 }, 'Warning code must be a string'))
test('a false message is not empty: it is not a string', () => throwsMsg({ message: false }, 'Warning message must be a string'))
test('a null name still reports emptiness', () => throwsMsg({ name: null }, 'Warning name must not be empty'))
test('an empty code still reports emptiness', () => throwsMsg({ code: '' }, 'Warning code must not be empty'))
test('a missing name still reports emptiness', () => throwsMsg({ name: undefined }, 'Warning name must not be empty'))
test('valid input still works and upper-cases the code', () => { const w = pw.createWarning({ name: 'W', code: 'abc_1', message: 'm' }); assert.equal(w.code, 'ABC_1') })
