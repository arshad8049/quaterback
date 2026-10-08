'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fp = require('../../index.js')
const NAME = Symbol.for('fastify.display-name')
const META = Symbol.for('plugin-meta')

test('reports the attached options', () => { const m = fp.getPluginMeta(fp(function f () {}, { name: 'a', fastify: '5.x' })); assert.equal(m.name, 'a'); assert.equal(m.fastify, '5.x') })
test('auto names are reported', () => assert.match(fp.getPluginMeta(fp(function auto () {})).name, /^auto-auto-\d+$/))
test('the result is a copy', () => { const f = fp(function f () {}, { name: 'b' }); fp.getPluginMeta(f).name = 'HACK'; assert.equal(fp.getPluginMeta(f).name, 'b'); assert.equal(f[META].name, 'b') })
test('unwrapped functions give undefined', () => assert.equal(fp.getPluginMeta(function plain () {}), undefined))
test('null, undefined and objects give undefined', () => { assert.equal(fp.getPluginMeta(null), undefined); assert.equal(fp.getPluginMeta(undefined), undefined); assert.equal(fp.getPluginMeta({}), undefined) })
