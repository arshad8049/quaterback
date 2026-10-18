'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const pw = require('../../index.js')
process.removeAllListeners('warning')
process.on('warning', () => {})

const w = pw.createWarning({ name: 'W', code: 'IW_1', message: 'm' })
const d = pw.createDeprecation({ code: 'IW_2', message: 'm' })

test('a created warning is a warning', () => assert.equal(pw.isWarning(w), true))
test('a created deprecation is a warning', () => assert.equal(pw.isWarning(d), true))
test('a plain function is not', () => assert.equal(pw.isWarning(function W () {}), false))
test('an object copying the public properties is not', () => assert.equal(pw.isWarning({ name: 'W', code: 'IW_1', message: 'm', emitted: false }), false))
test('a function with copied properties is not', () => assert.equal(pw.isWarning(Object.assign(() => {}, { code: 'IW_1', message: 'm', emitted: false })), false))
test('null and undefined are not, and do not throw', () => { assert.equal(pw.isWarning(null), false); assert.equal(pw.isWarning(undefined), false) })
test('exported on every namespace', () => { assert.equal(pw.default.isWarning, pw.isWarning); assert.equal(pw.processWarning.isWarning, pw.isWarning) })
