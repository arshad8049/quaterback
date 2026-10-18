'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const avvio = require('../../index.js')

test('a registered plugin is found after ready', async () => { const app = avvio(); app.use(function foo (s, o, d) { d() }); await app.ready(); assert.equal(app.hasPlugin('foo'), true) })
test('it is found as soon as it is registered', () => { const app = avvio({}, { autostart: false }); app.use(function early (s, o, d) { d() }); assert.equal(app.hasPlugin('early'), true) })
test('nested plugins are found', async () => { const app = avvio(); app.use(function outer (s, o, d) { s.use(function inner (i, o2, d2) { d2() }); d() }); await app.ready(); assert.equal(app.hasPlugin('inner'), true) })
test('options.name is used', async () => { const app = avvio(); app.use((s, o, d) => d(), { name: 'named-by-option' }); await app.ready(); assert.equal(app.hasPlugin('named-by-option'), true) })
test('unknown names are false', async () => { const app = avvio(); app.use(function foo (s, o, d) { d() }); await app.ready(); assert.equal(app.hasPlugin('bar'), false) })
test('it returns booleans', async () => { const app = avvio(); await app.ready(); assert.equal(typeof app.hasPlugin('x'), 'boolean') })
