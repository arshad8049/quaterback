'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { TimeTree } = require('../../lib/time-tree.js')
const Module = require('node:module')
const ROOT = path.join(__dirname, '../..')
const ownModules = () => Object.keys(require.cache).filter((k) => k.startsWith(ROOT + path.sep) && !k.includes(`${path.sep}node_modules${path.sep}`) && !k.startsWith(__dirname))
/** Load `target` fresh with the given package modules replaced by stubs, then restore the cache. */
function loadWith (stubs, target) {
  const saved = new Map(ownModules().map((k) => [k, require.cache[k]]))
  for (const k of saved.keys()) delete require.cache[k]
  for (const [rel, exports] of Object.entries(stubs)) { const f = require.resolve(path.join(ROOT, rel)); const m = new Module(f); m.filename = f; m.loaded = true; m.exports = exports; require.cache[f] = m }
  try { return require(path.join(ROOT, target)) } finally { for (const k of ownModules()) delete require.cache[k]; for (const [k, m] of saved) require.cache[k] = m }
}
/** A definition of `name` (declaration, function expression or arrow), not an import of it. */
const defines = (src, name) => new RegExp(`function\\s+${name}\\b|\\b${name}\\s*=\\s*(async\\s+)?(function\\b|\\(|[A-Za-z_$][\\w$]*\\s*=>)|\\b${name}\\s*\\([^)]*\\)\\s*\\{`).test(src.replace(/require\\([^)]*\\)/g, ''))

const EXPECTED = 'root 20 ms\n├─┬ a 9 ms\n│ ├── b 3 ms\n│ └── c 3 ms\n└── d 1 ms\n'
const sample = () => { const t = new TimeTree(); t.start(null, 'root', 0); const a = t.start('root', 'a', 1); const b = t.start('a', 'b', 2); t.stop(b, 5); const c = t.start('a', 'c', 6); t.stop(c, 9); t.stop(a, 10); const d = t.start('root', 'd', 11); t.stop(d, 12); t.stop('root', 20); return t }

test('the new module renders the known output', () => assert.equal(require('../../lib/pretty-print.js').prettyPrintTimeTree(sample().toJSON()), EXPECTED))
test('TimeTree#prettyPrint is unchanged', () => assert.equal(sample().prettyPrint(), EXPECTED))
test('TimeTree renders through lib/pretty-print', () => {
  const { TimeTree: Stubbed } = loadWith({ 'lib/pretty-print.js': { prettyPrintTimeTree: () => 'FROM-MODULE' } }, 'lib/time-tree.js')
  const t = new Stubbed(); t.start(null, 'root', 0); t.stop('root', 1)
  assert.equal(t.prettyPrint(), 'FROM-MODULE')
})
test('time-tree.js no longer defines its own copy', () => assert.equal(defines(fs.readFileSync(path.join(ROOT, 'lib/time-tree.js'), 'utf8'), 'prettyPrintTimeTree'), false))
test('app.prettyPrint still works', async () => { const app = require('../../index.js')(); app.use(function p (s, o, d) { d() }); await app.ready(); assert.match(app.prettyPrint(), /^root \d+ ms\n└── p \d+ ms\n$/) })
