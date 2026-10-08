'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const avvio = require('../../index.js')
const { TimeTree } = require('../../lib/time-tree.js')

const sample = () => { const t = new TimeTree(); t.start(null, 'root', 0); const a = t.start('root', 'a', 1); const b = t.start('a', 'b', 2); t.stop(b, 5); t.stop(a, 10); t.stop('root', 20); return t }
const booted = async () => { const app = avvio(); app.use(function outer (s, o, done) { s.use(function inner (i, o2, d) { d() }); done() }); await app.ready(); return app }

test('same data', () => { const j = sample().toJSON(); assert.equal(j.label, 'root'); assert.equal(j.nodes[0].nodes[0].label, 'b'); assert.equal(j.nodes[0].diff, 9) })
test('TimeTree: editing a nested node does not leak', () => { const t = sample(); const j = t.toJSON(); j.nodes[0].nodes[0].label = 'HACKED'; j.nodes[0].nodes.push({ label: 'x', nodes: [] }); assert.equal(t.toJSON().nodes[0].nodes.length, 1); assert.equal(t.toJSON().nodes[0].nodes[0].label, 'b') })
test('TimeTree: pushing at the top level does not leak', () => { const t = sample(); t.toJSON().nodes.push({ label: 'x', nodes: [] }); assert.equal(t.toJSON().nodes.length, 1) })
test('app.toJSON: nested edits do not change prettyPrint', async () => {
  const app = await booted(); const before = app.prettyPrint().replace(/\d+ ms/g, 'N ms')
  const j = app.toJSON(); j.nodes[0].label = 'HACKED'; j.nodes[0].nodes.length = 0
  assert.equal(app.prettyPrint().replace(/\d+ ms/g, 'N ms'), before)
})
test('an empty tree gives {}', () => assert.deepEqual(new TimeTree().toJSON(), {}))
