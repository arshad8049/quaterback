/**
 * QB-19: symbol extraction indexes valid exports correctly.
 * Through the real context builder (no LLM) on a fixture repository:
 * - single and trailing CJS exports, aliases, methods, ESM exports;
 * - duplicate names in two files stay distinct (qualified IDs, no overwrite);
 * - a name mentioned in a comment is never the symbol location;
 * - exports after byte 8,000 are indexed; files over the index cap are recorded, never silent.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { buildContext } = require('../../context/builder');
const { ContextPackageSchema } = require('../../context/schema');
const { buildBriefing } = require('../../agent/briefing');
const { makeRepo } = require('../helpers/tmprepo');

const pad = (n) => Array.from({ length: n }, (_, i) => `// filler line ${i} ${'x'.repeat(60)}`).join('\n');

const FILES = {
  // the card's repro: module.exports = { alpha, beta } returned only alpha
  'src/pair.js': "function alpha() { return 1; }\nfunction beta() { return 2; }\nmodule.exports = { alpha, beta };\n",
  // single export with no delimiter
  'src/single.js': "function solo() { return 1; }\nmodule.exports = { solo };\n",
  // trailing export object, with a trailing comma, after everything else
  'src/trailing.js': "function first() {}\nfunction second() {}\n\nmodule.exports = {\n  first,\n  second,\n};\n",
  // alias: public name differs from the local binding
  'src/alias.js': "function internalFormat(n) { return String(n); }\nmodule.exports = { publicFormat: internalFormat };\n",
  // a class with methods
  'src/store.js': "class Store {\n  constructor() { this.items = []; }\n  add(x) { this.items.push(x); }\n  size() { return this.items.length; }\n}\nmodule.exports = { Store };\n",
  // duplicate names across files
  'src/parse-a.js': "function parse(s) { return s.trim(); }\nmodule.exports = { parse };\n",
  'src/parse-b.js': "exports.parse = function parse(s) { return s.split(','); };\n",
  // a comment mentions the name before the declaration
  'src/commented.js': "// computeTotal is defined below; computeTotal returns a number\n/* computeTotal */\nconst unrelated = 1;\nfunction computeTotal(xs) { return xs.reduce((a, b) => a + b, 0); }\nmodule.exports = { computeTotal, unrelated };\n",
  // an export after byte 8,000
  'src/late.js': `${pad(140)}\nfunction lateExport() { return 'late'; }\nmodule.exports = { lateExport };\n`,
  // ESM
  'src/esm.mjs': "export function esmOne() {}\nexport const esmTwo = () => 2;\nconst hidden = 3;\nexport { hidden as revealed };\nexport default function esmDefault() {}\n",
};

let repo;
let pkg;
const CONTRACT = { id: 'c', goal: 'Improve alpha beta solo first second publicformat store parse computetotal lateexport esmone pair single trailing alias commented late', required_behavior: [], relevant_context: [] };

before(async () => {
  repo = makeRepo(FILES);
  pkg = await buildContext(CONTRACT, repo.dir, { noLlm: true });
});
after(() => repo.cleanup());

const sym = (id) => (pkg.symbols_index || []).find((s) => s.id === id);
const filesSymbols = (p) => (pkg.relevant_files.find((f) => f.path === p) || {}).symbols || [];

describe('exports are indexed by parser', () => {
  test('module.exports = { alpha, beta } indexes BOTH (pre-fix: only alpha)', () => {
    assert.deepEqual(filesSymbols('src/pair.js').sort(), ['alpha', 'beta']);
    assert.ok(sym('src/pair.js#alpha') && sym('src/pair.js#beta'));
  });
  test('a single export and a trailing (multi-line, trailing-comma) export object', () => {
    assert.deepEqual(filesSymbols('src/single.js'), ['solo']);
    assert.deepEqual(filesSymbols('src/trailing.js').sort(), ['first', 'second']);
  });
  test('an alias is exported under its public name and resolves to the local declaration', () => {
    const s = sym('src/alias.js#publicFormat');
    assert.ok(s, JSON.stringify(pkg.symbols_index));
    assert.equal(s.local, 'internalFormat');
    assert.equal(s.span.start.line, 1);
  });
  test('class methods are qualified by their class', () => {
    assert.ok(sym('src/store.js#Store'));
    assert.deepEqual([sym('src/store.js#Store.add').span.start.line, sym('src/store.js#Store.size').span.start.line], [3, 4]);
    assert.equal(sym('src/store.js#Store.add').kind, 'method');
  });
  test('ESM: named, const, aliased and default exports', () => {
    assert.deepEqual(filesSymbols('src/esm.mjs').sort(), ['default', 'esmOne', 'esmTwo', 'revealed']);
    assert.equal(sym('src/esm.mjs#revealed').local, 'hidden');
    assert.equal(sym('src/esm.mjs#revealed').span.start.line, 3);
  });
});

describe('locations are real declarations, never comments; names never overwrite', () => {
  test('duplicate names in two files get two qualified IDs (pre-fix: the second overwrote the first)', () => {
    assert.equal(pkg.symbol_map['src/parse-a.js#parse'], 'src/parse-a.js:1');
    assert.equal(pkg.symbol_map['src/parse-b.js#parse'], 'src/parse-b.js:1');
  });
  test('a name mentioned in a comment is not the location (pre-fix: the comment line)', () => {
    assert.equal(pkg.symbol_map['src/commented.js#computeTotal'], 'src/commented.js:4');
    const s = sym('src/commented.js#computeTotal');
    assert.deepEqual([s.kind, s.span.start.line, s.span.end.line], ['function', 4, 4]);
  });
  test('an export after byte 8,000 is indexed with its real span (pre-fix: truncated away)', () => {
    assert.deepEqual(filesSymbols('src/late.js'), ['lateExport']);
    assert.equal(sym('src/late.js#lateExport').span.start.line, 141);
  });
});

describe('limits are explicit; the package stays valid', () => {
  test('a file over the index cap is recorded as such, not silently dropped or truncated', async () => {
    const big = makeRepo({ 'src/huge.js': `${pad(9000)}\nfunction hugeTail() {}\nmodule.exports = { hugeTail };\n` });
    try {
      const p = await buildContext({ id: 'c', goal: 'huge tail', required_behavior: [], relevant_context: [] }, big.dir, { noLlm: true });
      const lim = p.index_limits.files.find((f) => f.path === 'src/huge.js');
      assert.ok(lim, JSON.stringify(p.index_limits));
      assert.equal(lim.status, 'too_large');
      assert.ok(p.index_limits.max_index_bytes > 8000);
    } finally { big.cleanup(); }
  });
  test('prompt content is a bounded snippet, flagged when cut', () => {
    const late = pkg.relevant_files.find((f) => f.path === 'src/late.js');
    assert.equal(late.content_truncated, true);
    assert.ok(late.content.length <= 8100);
  });
  test('the package validates and the agent briefing renders qualified symbols', () => {
    ContextPackageSchema.parse(pkg);
    const b = buildBriefing({ id: 'c', goal: 'g', required_behavior: [], constraints: [], acceptance_criteria: [] }, pkg, { attempt: 1, repairHints: [] });
    assert.match(b, /src\/parse-a\.js#parse/);
    assert.match(b, /src\/parse-b\.js#parse/);
  });
});
