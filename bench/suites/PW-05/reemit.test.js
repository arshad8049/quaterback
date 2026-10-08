'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const pw = require('../../index.js')
process.removeAllListeners('warning')
process.on('warning', () => {})

let n = 0
const once = () => pw.createWarning({ name: 'W', code: `RE_${++n}`, message: 'm' })
const count = (w) => { let k = 0; const on = (e) => { if (e.code === w.code) k++ }; process.on('warning', on); return () => { process.removeListener('warning', on); return k } }

test('once-only: first call true, later calls false', () => { const w = once(); assert.equal(w(), true); assert.equal(w(), false); assert.equal(w(), false) })
test('emitted = false allows exactly one more emission', () => { const w = once(); w(); w.emitted = false; assert.equal(w(), true); assert.equal(w(), false) })
test('a second reset works too', () => { const w = once(); w(); w.emitted = false; w(); w.emitted = false; assert.equal(w(), true) })
test('emissions actually reach process warnings', async () => {
  const w = once(); const done = count(w)
  w(); w(); w.emitted = false; w(); w()
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r))
  assert.equal(done(), 2)
})
test('unlimited warnings still emit every time', () => { const w = pw.createWarning({ name: 'W', code: `RE_${++n}`, message: 'm', unlimited: true }); assert.equal(w(), true); assert.equal(w(), true) })
