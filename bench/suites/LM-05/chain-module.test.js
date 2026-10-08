'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const inject = require('../../index.js')
const echo = (req, res) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: req.url, headers: req.headers, body: b })) }) }
const send = async (opts) => (await inject(echo, opts)).json()
const fs = require('node:fs')
const path = require('node:path')
const { Chain } = require('../../lib/chain.js')
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

test('lib/chain exports Chain and inject returns it', () => { assert.equal(typeof Chain, 'function'); const c = inject(echo, { url: '/', autoStart: false }); assert.ok(c instanceof Chain) })
test('inject builds its chain from lib/chain', () => {
  class StubChain { constructor (...args) { this.args = args } }
  const fresh = loadWith({ 'lib/chain.js': { Chain: StubChain } }, 'index.js')
  assert.ok(fresh(echo, { url: '/', autoStart: false }) instanceof StubChain)
})
test('index.js no longer defines Chain', () => assert.equal(defines(fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8'), 'Chain'), false))
test('setters and await work', async () => { const r = (await inject(echo).post('/p').headers({ 'x-a': '1' }).query({ q: 2 }).payload({ v: 1 })).json(); assert.equal(r.url, '/p?q=2'); assert.equal(r.headers['x-a'], '1'); assert.equal(r.body, '{"v":1}') })
test('end(callback) works', (t, done) => { inject(echo).get('/cb').end((err, res) => { assert.ifError(err); assert.equal(res.json().url, '/cb'); done() }) })
test('autostart runs the request', async () => { const r = await new Promise((resolve) => inject((req, res) => { resolve(req.url); res.end() }, '/auto')); assert.equal(r, '/auto') })
test('re-invoking throws the same error', async () => { const c = inject(echo).get('/'); await c; assert.throws(() => c.get('/again'), { message: 'The dispatch function has already been invoked' }); assert.throws(() => c.end(), { message: 'The dispatch function has already been invoked' }) })
