'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fp = require('../../index.js')
const NAME = Symbol.for('fastify.display-name')
const META = Symbol.for('plugin-meta')

test('the caller options object is not modified', () => { const opts = {}; fp(function alpha () {}, opts); assert.deepEqual(opts, {}) })
test('a shared options object does not leak names', () => { const opts = {}; fp(function alpha () {}, opts); const b = fp(function beta () {}, opts); assert.match(b[NAME], /^beta-auto-\d+$/) })
test('metadata is a copy', () => { const opts = { name: 'x' }; const f = fp(function f () {}, opts); opts.name = 'changed'; opts.extra = 1; assert.equal(f[META].name, 'x'); assert.equal(f[META].extra, undefined) })
test('auto-named metadata survives', () => { const f = fp(function gamma () {}); assert.match(f[META].name, /^gamma-auto-\d+$/) })
test('explicit names still work', () => { const f = fp(function h () {}, { name: 'my-plugin' }); assert.equal(f[NAME], 'my-plugin'); assert.equal(f.myPlugin, f) })
