'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const pw = require('../../index.js')
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
process.removeAllListeners('warning')
process.on('warning', () => {})

let n = 0
const w = () => pw.createWarning({ name: 'W', code: `SP_${++n}`, message: 'm %s' })
test('lib/spy exports the same spyWarning', () => assert.equal(require('../../lib/spy.js').spyWarning, pw.spyWarning))
test('index.js re-exports spyWarning from lib/spy', () => {
  const stub = () => 'stub'
  assert.equal(loadWith({ 'lib/spy.js': { spyWarning: stub } }, 'index.js').spyWarning, stub)
})
test('index.js no longer defines spyWarning', () => assert.equal(defines(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'), 'spyWarning'), false))
test('lib/symbols.js holds the shared symbols that createWarning and the spy both use', () => {
  const real = require('../../lib/symbols.js')
  const keys = Object.keys(real)
  assert.ok(keys.length > 0 && keys.every((k) => typeof real[k] === 'symbol'), 'lib/symbols.js exports symbols')
  const fresh = Object.fromEntries(keys.map((k) => [k, Symbol(`test.${k}`)]))
  const freshPw = loadWith({ 'lib/symbols.js': fresh }, 'index.js')
  const x = freshPw.createWarning({ name: 'W', code: `SYM_${++n}`, message: 'm' })
  const own = Object.getOwnPropertySymbols(x)
  for (const k of keys) assert.ok(own.includes(fresh[k]), `createWarning uses ${k} from lib/symbols.js`)
  const s = freshPw.spyWarning(x); x('a')
  assert.equal(s.callCount(), 1, 'the spy (lib/spy.js) uses the same symbols')
})
test('calls and callCount', () => { const x = w(); const s = pw.spyWarning(x); x('a'); x('b'); assert.equal(s.callCount(), 2); assert.deepEqual(s.calls.map((c) => c.arguments), [['a'], ['b']]); assert.deepEqual(s.calls.map((c) => c.result), [true, false]) })
test('reset clears calls and emitted', () => { const x = w(); const s = pw.spyWarning(x); x('a'); s.reset(); assert.equal(s.callCount(), 0); assert.equal(x.emitted, false) })
test('restore detaches the spy', () => { const x = w(); const s = pw.spyWarning(x); s.restore(); x('a'); assert.equal(s.callCount(), 0); assert.notEqual(pw.spyWarning(x), s) })
test('spying twice returns the same data', () => { const x = w(); assert.equal(pw.spyWarning(x), pw.spyWarning(x)) })
