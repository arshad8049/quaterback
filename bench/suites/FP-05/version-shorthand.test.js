'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fp = require('../../index.js')
const NAME = Symbol.for('fastify.display-name')
const META = Symbol.for('plugin-meta')

test('a version string is accepted', () => assert.doesNotThrow(() => fp(function a () {}, '5.x')))
test('it sets the fastify range', () => assert.equal(fp(function b () {}, '5.x')[META].fastify, '5.x'))
test('the plugin is auto-named', () => assert.match(fp(function c () {}, '>=4')[NAME], /^c-auto-\d+$/))
