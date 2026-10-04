/**
 * QB-12: keyword/symbol signals are search hints with provenance, never facts.
 * Comments, strings, deleted code, multiline exports, unrelated returns and
 * pre-existing functions are classified correctly; absence from the diff is
 * never evidence of absence; heuristic signals alone cannot satisfy a
 * behavioural criterion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { scanDiff } = require('../../verify/checker');
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const CONTRACT = { goal: 'Add clamp()', acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp() is exported and returns the bounded value' }] };
const H = (lines, file = 'src/u.js') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${lines.join('\n')}\n`;
const clamp = (d) => scanDiff(d, CONTRACT).symbols.clamp;

describe('symbol hints: correct classifications', () => {
  test('a comment mentioning the name is not a definition', () => {
    assert.deepEqual(clamp(H(['+// TODO: implement clamp() later', ' const x = 1;'])),
      { defined: 'not_in_diff', exported: 'not_in_diff', returns: 'unknown' });
  });
  test('a commented-out export is not an export', () => {
    const s = clamp(H(['+function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }', '+// module.exports = { clamp };']));
    assert.equal(s.defined, 'confirmed_added');
    assert.equal(s.exported, 'not_in_diff');
  });
  test('a string containing the name is not a definition', () => {
    assert.equal(clamp(H(['+const msg = "clamp() is exported";'])).defined, 'not_in_diff');
  });
  test('deleted lines are never read', () => {
    const s = clamp(H(['-function clamp(n, a, b) { return n; }', '-module.exports = { clamp };', ' const y = 2;']));
    assert.deepEqual([s.defined, s.exported], ['not_in_diff', 'not_in_diff']);
  });
  test('a multiline module.exports is an export', () => {
    const s = clamp(H(['+function clamp(n, a, b) {', '+  return Math.min(Math.max(n, a), b);', '+}', '+module.exports = {', '+  clamp,', '+};']));
    assert.deepEqual(s, { defined: 'confirmed_added', exported: 'confirmed_added', returns: 'yes', file: 'src/u.js' });
  });
  test('a return in another function does not count as this one returning', () => {
    const s = clamp(H(['+function clamp(n, a, b) { Math.min(n, a); }', '+function other() { return 1; }']));
    assert.equal(s.returns, 'no');
  });
  test('a pre-existing function in unchanged context is classified as pre-existing', () => {
    const s = clamp(H([' function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }', '+const z = 3;', ' module.exports = { clamp };']));
    assert.deepEqual([s.defined, s.exported], ['confirmed_unchanged', 'confirmed_unchanged']);
  });
  test('a function only in unchanged code (not in the diff) is UNKNOWN, never reported absent', () => {
    const s = clamp(H(['+const unrelated = 1;']));
    assert.equal(s.defined, 'not_in_diff');
    assert.notEqual(s.defined, false);
  });
  test('an unparseable hunk yields a labelled heuristic hint, never a confirmation', () => {
    const s = clamp(H(['+  clamp(x, 0, 1);', '+} else {']));
    assert.equal(s.defined, 'hint');
  });
  test('arrow functions, exports.x and ESM exports are understood', () => {
    assert.deepEqual(clamp(H(['+exports.clamp = (n, a, b) => Math.min(Math.max(n, a), b);'])).exported, 'confirmed_added');
    const esm = clamp(H(['+export const clamp = (n, a, b) => Math.min(Math.max(n, a), b);'], 'src/u.mjs'));
    assert.deepEqual([esm.defined, esm.exported, esm.returns], ['confirmed_added', 'confirmed_added', 'yes']);
  });
});

describe('keyword hints', () => {
  test('only added lines are searched', () => {
    const k = scanDiff(H(['-  // the bounded value is exported', '+const q = 1;']), CONTRACT).keywords;
    assert.ok(k.not_found.includes('bounded'));
    assert.ok(!k.found.includes('bounded'));
  });
});

describe('the judge prompt labels hints as hints', () => {
  test('no "confirmed"/"Deterministic" claims; absence is labelled as not evidence', async () => {
    const { judgeAll } = require('../../verify/judge');
    const diff = H(['+const unrelated = 1;']);
    const m = mockFetch(ollamaReply({ met: null, evidence: 'unclear' }));
    try {
      await judgeAll(CONTRACT.acceptance_criteria, diff, scanDiff(diff, CONTRACT));
      const body = JSON.parse(m.calls[0].init.body);
      const user = body.messages.find((x) => x.role === 'user').content;
      assert.match(user, /## Search hints \(computed by QB from the diff — hints, not facts\)/);
      assert.match(user, /NOT evidence that it is missing/);
      assert.doesNotMatch(user, /Deterministic checks|confirmed in added lines|NOT found in diff/);
      assert.doesNotMatch(body.messages[0].content, /"NOT found in diff"/);
    } finally { m.restore(); }
  });
});

describe('heuristic signals alone cannot satisfy a behavioural criterion', () => {
  test('approved contract, scope covers the file, behavioural AC with no check, affirmative judge → not pass', async () => {
    const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
    const contract = approve({ id: 'c', goal: 'Add clamp()', clarifying_question: null, scope: { allowed_changes: ['src/**'] },
      acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp() is exported and returns the bounded value', met: null, kind: 'behavioral' }] }, { via: 'test' });
    const diff = H(['+function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }', '+module.exports = { clamp };']);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'clamp is defined and exported' }));
    try {
      const r = await verify(contract, null, { id: 'e', status: 'completed', diff, changes: [{ file: 'src/u.js', status: 'M' }],
        sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT } } }, {});
      assert.notEqual(r.verdict, 'pass');
      assert.equal(r.criteria_results[0].check_status, 'unresolved');
    } finally { m.restore(); }
  });
});

// ─── Re-review (senior, 2686f90): exports must resolve scope and the exported name ───

const ALIAS = { goal: 'Add clamp() and other()', acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp() is exported as other()' }] };
const sym = (d, c = ALIAS) => scanDiff(d, c).symbols;
const CONFIRMED = /^confirmed_/;
// A hunk that starts at post-image line `start` (not the top of the file).
const HAt = (start, lines, file = 'src/u.js') => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -${start},3 +${start},3 @@\n${lines.join('\n')}\n`;

describe('CommonJS exports resolve module/exports in scope', () => {
  test('a parameter named exports is not the module (senior reproduction)', () => {
    const s = clamp(H(['+function wrapper(exports) { exports.clamp = () => 1; }']));
    assert.doesNotMatch(s.exported, CONFIRMED);
    assert.doesNotMatch(s.defined, CONFIRMED);
  });
  test('a local named module is not the module', () => {
    const s = clamp(H(['+const module = { exports: {} };', '+module.exports.clamp = (n) => n;']));
    assert.doesNotMatch(s.exported, CONFIRMED);
  });
  test('const exports = {} at the top is not the module', () => {
    assert.doesNotMatch(clamp(H(['+const exports = {};', '+exports.clamp = (n) => n;'])).exported, CONFIRMED);
  });
  test('a catch parameter and a hoisted var shadow exports', () => {
    assert.doesNotMatch(clamp(H(['+try { f(); } catch (exports) { exports.clamp = (n) => n; }'])).exported, CONFIRMED);
    assert.doesNotMatch(clamp(H(['+function w() { exports.clamp = (n) => n; var exports = {}; }'])).exported, CONFIRMED);
  });
  test('exports rebound to a fresh object is not the module', () => {
    assert.doesNotMatch(clamp(H(['+exports = {};', '+exports.clamp = (n) => n;'])).exported, CONFIRMED);
  });
  test('an export inside a function in the hunk only runs if called: hint, never confirmed', () => {
    assert.equal(clamp(H(['+function init() { exports.clamp = (n) => n; }'])).exported, 'hint');
  });
  test('the unshadowed module still counts', () => {
    assert.equal(clamp(H(['+module.exports.clamp = (n) => n;'])).exported, 'confirmed_added');
    assert.equal(clamp(H(['+exports.clamp = (n) => n;'])).exported, 'confirmed_added');
    assert.equal(clamp(H(['+exports = module.exports = { clamp: (n) => n };'])).exported, 'confirmed_added');
  });
});

describe('hunk-only context: an unseen enclosing scope downgrades to hint', () => {
  test('an indented export in a hunk that starts mid-file may be inside an unseen function', () => {
    assert.equal(clamp(HAt(40, ['   if (ready) {', '+    exports.clamp = (n) => n;', '   }'])).exported, 'hint');
  });
  test('a top-level (unindented) export mid-file is still confirmed', () => {
    assert.equal(clamp(HAt(40, [' const a = 1;', '+exports.clamp = (n) => n;'])).exported, 'confirmed_added');
  });
});

describe('exported names are distinguished from local bindings', () => {
  test('ESM alias: clamp is the local binding, other is the exported name (senior reproduction)', () => {
    const s = sym(H(['+export { clamp as other };', '+function clamp() { return 1; }'], 'src/u.mjs'));
    assert.equal(s.clamp.defined, 'confirmed_added');
    assert.doesNotMatch(s.clamp.exported, CONFIRMED);
    assert.deepEqual(s.clamp.exported_as, { other: 'confirmed_added' });
    assert.equal(s.other.exported, 'confirmed_added');
    assert.equal(s.other.local, 'clamp');
    assert.doesNotMatch(s.other.defined, CONFIRMED);
  });
  test('CommonJS alias: exports.other = clamp', () => {
    const s = sym(H(['+function clamp() { return 1; }', '+exports.other = clamp;']));
    assert.doesNotMatch(s.clamp.exported, CONFIRMED);
    assert.deepEqual(s.clamp.exported_as, { other: 'confirmed_added' });
    assert.equal(s.other.exported, 'confirmed_added');
    assert.equal(s.other.local, 'clamp');
  });
  test('CommonJS alias: module.exports = { other: clamp }', () => {
    const s = sym(H(['+function clamp() { return 1; }', '+module.exports = { other: clamp };']));
    assert.doesNotMatch(s.clamp.exported, CONFIRMED);
    assert.deepEqual(s.clamp.exported_as, { other: 'confirmed_added' });
    assert.equal(s.other.local, 'clamp');
  });
  test('export default and module.exports = name export the module, not the name', () => {
    const d = clamp(H(['+export default function clamp() { return 1; }'], 'src/u.mjs'));
    assert.equal(d.defined, 'confirmed_added');
    assert.doesNotMatch(d.exported, CONFIRMED);
    assert.deepEqual(d.exported_as, { default: 'confirmed_added' });
    const m = clamp(H(['+function clamp() { return 1; }', '+module.exports = clamp;']));
    assert.doesNotMatch(m.exported, CONFIRMED);
    assert.deepEqual(m.exported_as, { 'module.exports': 'confirmed_added' });
  });
  test('a re-export names its source and is not a local definition', () => {
    const s = clamp(H(['+export { clamp } from "./c.js";'], 'src/u.mjs'));
    assert.equal(s.exported, 'confirmed_added');
    assert.equal(s.from, './c.js');
    assert.equal(s.defined, 'not_in_diff');
  });
});

describe('the judge sees the exported name apart from the local binding', () => {
  test('an aliased export is rendered as an alias, not as an export of clamp', async () => {
    const { judgeAll } = require('../../verify/judge');
    const diff = H(['+export { clamp as other };', '+function clamp() { return 1; }'], 'src/u.mjs');
    const m = mockFetch(ollamaReply({ met: null, evidence: 'unclear' }));
    try {
      await judgeAll(ALIAS.acceptance_criteria, diff, scanDiff(diff, ALIAS));
      const user = JSON.parse(m.calls[0].init.body).messages.find((x) => x.role === 'user').content;
      assert.match(user, /clamp: definition in added code \(parsed\); export by the name "clamp" not in the changed hunks/);
      assert.match(user, /this local binding is exported under the name "other" \(added code\)/);
      assert.match(user, /other: .*that export is bound to the local "clamp"/);
    } finally { m.restore(); }
  });
});

describe('computed keys are not literal names', () => {
  test('exports[clamp] and { [clamp]: … } do not export a name "clamp"', () => {
    assert.doesNotMatch(clamp(H(['+const clamp = "other";', '+exports[clamp] = () => 1;'])).exported, CONFIRMED);
    assert.doesNotMatch(clamp(H(['+const clamp = "other";', '+module.exports = { [clamp]: () => 1 };'])).exported, CONFIRMED);
    assert.doesNotMatch(clamp(H(['+const clamp = "other";', '+module.exports = { [clamp]() { return 1; } };'])).defined, CONFIRMED);
  });
  test('a string-literal key is resolved: exports["clamp"]', () => {
    assert.equal(clamp(H(['+exports["clamp"] = (n) => n;'])).exported, 'confirmed_added');
  });
});
