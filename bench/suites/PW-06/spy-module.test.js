'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pw = require('../../index.js')
process.removeAllListeners('warning')
process.on('warning', () => {})

let n = 0
const w = () => pw.createWarning({ name: 'W', code: `SP_${++n}`, message: 'm %s' })
test('lib/spy exports the same spyWarning', () => assert.equal(require('../../lib/spy.js').spyWarning, pw.spyWarning))
test('index.js no longer defines spyWarning', () => assert.equal(/function\s+spyWarning\s*\(/.test(fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8')), false))
test('calls and callCount', () => { const x = w(); const s = pw.spyWarning(x); x('a'); x('b'); assert.equal(s.callCount(), 2); assert.deepEqual(s.calls.map((c) => c.arguments), [['a'], ['b']]); assert.deepEqual(s.calls.map((c) => c.result), [true, false]) })
test('reset clears calls and emitted', () => { const x = w(); const s = pw.spyWarning(x); x('a'); s.reset(); assert.equal(s.callCount(), 0); assert.equal(x.emitted, false) })
test('restore detaches the spy', () => { const x = w(); const s = pw.spyWarning(x); s.restore(); x('a'); assert.equal(s.callCount(), 0); assert.notEqual(pw.spyWarning(x), s) })
test('spying twice returns the same data', () => { const x = w(); assert.equal(pw.spyWarning(x), pw.spyWarning(x)) })
