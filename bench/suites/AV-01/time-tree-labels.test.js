'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { TimeTree } = require('../../lib/time-tree.js')

const twoSiblings = () => { const t = new TimeTree(); t.start(null, 'root'); const a1 = t.start('root', 'p'); const a2 = t.start('root', 'p'); return { t, a1, a2 } }
const childrenOf = (t, id) => t.tableId.get(id)?.nodes ?? t.root.nodes.find((n) => n.id === id).nodes

test('stop the first same-label node: a child goes under the second', () => {
  const { t, a1, a2 } = twoSiblings(); t.stop(a1); t.start('p', 'child')
  assert.equal(t.root.nodes[1].id, a2); assert.deepEqual(t.root.nodes[1].nodes.map((n) => n.label), ['child']); assert.equal(t.root.nodes[0].nodes.length, 0)
})
test('stop the second same-label node: a child goes under the first', () => {
  const { t, a1 } = twoSiblings(); t.stop(t.root.nodes[1].id); t.start('p', 'child')
  assert.equal(t.root.nodes[0].id, a1); assert.deepEqual(t.root.nodes[0].nodes.map((n) => n.label), ['child']); assert.equal(t.root.nodes[1].nodes.length, 0)
})
test('with both running, a child goes under the most recently started', () => {
  const { t, a2 } = twoSiblings(); t.start('p', 'child')
  assert.equal(t.root.nodes[1].id, a2); assert.deepEqual(t.root.nodes[1].nodes.map((n) => n.label), ['child']); assert.equal(t.root.nodes[0].nodes.length, 0)
})
test('stopping an unknown id is a no-op', () => {
  const { t, a2 } = twoSiblings(); t.stop('nope'); t.start('p', 'child')
  assert.equal(t.root.nodes[1].id, a2); assert.deepEqual(t.root.nodes[1].nodes.map((n) => n.label), ['child'])
})
test('a single node still works', () => { const t = new TimeTree(); t.start(null, 'root'); const a = t.start('root', 'a'); t.start('a', 'b'); t.stop(a); assert.equal(t.root.nodes[0].nodes[0].label, 'b') })
