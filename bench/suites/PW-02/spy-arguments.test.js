'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const pw = require('../../index.js')
process.removeAllListeners('warning')
process.on('warning', () => {})

let n = 0
const spied = () => { const w = pw.createWarning({ name: 'W', code: `S_${++n}`, message: 'm %s %s %s', unlimited: true }); return [w, pw.spyWarning(w)] }
const argsOf = (...a) => { const [w, spy] = spied(); w(...a); return spy.calls[0].arguments }

test("w('a', 0) keeps the 0", () => assert.deepEqual(argsOf('a', 0), ['a', 0]))
test('w(0) keeps the 0', () => assert.deepEqual(argsOf(0), [0]))
test("w('') keeps the empty string", () => assert.deepEqual(argsOf(''), ['']))
test('w(false) keeps false', () => assert.deepEqual(argsOf(false), [false]))
test('w(null) keeps null', () => assert.deepEqual(argsOf(null), [null]))
test('w() records no arguments', () => assert.deepEqual(argsOf(), []))
test("w('a', undefined, 'c') keeps the hole in position", () => assert.deepEqual(argsOf('a', undefined, 'c'), ['a', undefined, 'c']))
test('truthy arguments are recorded as before', () => assert.deepEqual(argsOf('x', 'y', 'z'), ['x', 'y', 'z']))
test('callCount still counts every call', () => { const [w, spy] = spied(); w(0); w(); w(false); assert.equal(spy.callCount(), 3) })
