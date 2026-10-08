'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const build = require('../../index.js')

const s = build({ type: 'object', properties: { n: { type: 'integer' } } })
test('10n', () => assert.equal(s({ n: 10n }), '{"n":10}'))
test('2n ** 64n is exact', () => assert.equal(s({ n: 2n ** 64n }), '{"n":18446744073709551616}'))
test('negative BigInt', () => assert.equal(s({ n: -5n }), '{"n":-5}'))
test('numbers unchanged', () => assert.equal(s({ n: 7 }), '{"n":7}'))
