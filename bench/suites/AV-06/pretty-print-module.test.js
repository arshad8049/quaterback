'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { TimeTree } = require('../../lib/time-tree.js')

const EXPECTED = 'root 20 ms\n├─┬ a 9 ms\n│ ├── b 3 ms\n│ └── c 3 ms\n└── d 1 ms\n'
const sample = () => { const t = new TimeTree(); t.start(null, 'root', 0); const a = t.start('root', 'a', 1); const b = t.start('a', 'b', 2); t.stop(b, 5); const c = t.start('a', 'c', 6); t.stop(c, 9); t.stop(a, 10); const d = t.start('root', 'd', 11); t.stop(d, 12); t.stop('root', 20); return t }

test('the new module renders the known output', () => assert.equal(require('../../lib/pretty-print.js').prettyPrintTimeTree(sample().toJSON()), EXPECTED))
test('TimeTree#prettyPrint is unchanged', () => assert.equal(sample().prettyPrint(), EXPECTED))
test('time-tree.js no longer defines its own copy and uses the module', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../lib/time-tree.js'), 'utf8')
  assert.equal(/function\s+prettyPrintTimeTree\s*\(/.test(src), false)
  assert.match(src, /require\(['"]\.\/pretty-print(\.js)?['"]\)/)
})
test('app.prettyPrint still works', async () => { const app = require('../../index.js')(); app.use(function p (s, o, d) { d() }); await app.ready(); assert.match(app.prettyPrint(), /^root \d+ ms\n└── p \d+ ms\n$/) })
