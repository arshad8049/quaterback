'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const s = (v) => build({ type: 'array', items: { type: 'integer' } }, { rounding: 'halfEven' })(v)
test('the option is accepted', () => assert.equal(typeof build({ type: 'integer' }, { rounding: 'halfEven' }), 'function'))
test('positive halves go to even', () => assert.equal(s([0.5, 1.5, 2.5, 3.5, 4.5]), '[0,2,2,4,4]'))
test('negative halves go to even', () => assert.equal(s([-0.5, -1.5, -2.5, -3.5]), '[0,-2,-2,-4]'))
test('non-halves round to nearest', () => assert.equal(s([2.4, 2.6, -2.4, -2.6]), '[2,3,-2,-3]'))
test('integers are unchanged', () => assert.equal(s([7, -7, 0]), '[7,-7,0]'))
test('unknown methods still throw', () => assert.throws(() => build({ type: 'integer' }, { rounding: 'bankers' }), { message: 'Unsupported integer rounding method bankers' }))
test('round is unchanged', () => assert.equal(build({ type: 'array', items: { type: 'integer' } }, { rounding: 'round' })([2.5, -2.5]), '[3,-2]'))
