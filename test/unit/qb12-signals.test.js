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
