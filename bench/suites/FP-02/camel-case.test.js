'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fp = require('../../index.js')
const NAME = Symbol.for('fastify.display-name')
const META = Symbol.for('plugin-meta')
const toCamelCase = require('../../lib/toCamelCase.js')
const cases = { '@scope/my-plugin': 'scopeMyPlugin', 'my--plugin': 'myPlugin', 'plugin-': 'plugin', '@a/b/c-d': 'aBCD', 'fooBar-baz': 'fooBarBaz', my_plugin: 'my_plugin', simple: 'simple' }
for (const [input, out] of Object.entries(cases)) test(`${input} → ${out}`, () => assert.equal(toCamelCase(input), out))
test('the alias on the plugin follows the rule', () => { const f = fp(function f () {}, { name: 'my--plugin' }); assert.equal(f.myPlugin, f) })
