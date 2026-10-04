/**
 * QB-15: voting and preservation rules are calibrated.
 * - an unchanged patch does not become approved by repeated resampling alone
 *   (judgments are cached by the content-addressed evidence, QB-11);
 * - preservation claims are bounded to named tests (decided by the sandbox test
 *   report) — never "null, therefore preserved";
 * - false acceptance, false rejection and abstention are measured separately
 *   against independently labeled patches, for one judge vs majority-of-3 at
 *   their real call cost.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { verify } = require('../../verify/verifier');
const { aggregate } = require('../../verify/verdict');
const { approve, contractState } = require('../../intent/contract-state');
const { score, calibrate } = require('../../verify/calibration');
const { FORMAT } = require('../../verify/tests');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const PASS_REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,0 +1,1 @@\n+Run qb --verbose to print every stage.\n';
const contract = (acs) => approve({ id: 'c', goal: 'g', clarifying_question: null, scope: { allowed_changes: ['**'] }, acceptance_criteria: acs }, { via: 'test' });
const exec = (verification = { status: 'ran', state: 'completed', exit_code: 0, output: '', report: PASS_REPORT }) =>
  ({ id: 'e', status: 'completed', diff: DIFF, changes: [{ file: 'README.md', status: 'M' }], sandbox: { verification } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qb15-cache-'));

/** A judge that is unsure on the first 3 calls and positive afterwards — resampling would flip it. */
function flippingJudge() {
  let n = 0;
  return mockFetch(() => (++n <= 3 ? ollamaReply({ met: null, evidence: 'cannot tell' }) : ollamaReply({ met: true, evidence: 'README documents --verbose' })));
}

describe('an unchanged patch is not approved by resampling alone', () => {
  const C = contract([{ id: 'AC-1', criterion: 'README documents the --verbose flag', met: null, kind: 'non_behavioral' }]);

  test('re-verifying the same patch reuses the cached judgment: still not PASS (pre-fix: the 2nd run resampled into PASS)', async () => {
    const dir = tmp();
    const m = flippingJudge();
    try {
      const r1 = await verify(C, null, exec(), { judgeCache: dir });
      const r2 = await verify(C, null, exec(), { judgeCache: dir });
      assert.notEqual(r1.verdict, 'pass');
      assert.notEqual(r2.verdict, 'pass', 'resampling the same evidence must not flip the verdict');
      assert.deepEqual([r1.criteria_results[0].judgment_cache, r2.criteria_results[0].judgment_cache], ['miss', 'hit']);
      assert.equal(m.calls.length, 3, 'the second verification made no judge calls');
    } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('a changed patch (new evidence IDs) is judged afresh', async () => {
    const dir = tmp();
    const m = flippingJudge();
    try {
      await verify(C, null, exec(), { judgeCache: dir });
      const changed = { ...exec(), diff: DIFF.replace('every stage', 'each stage') };
      const r = await verify(C, null, changed, { judgeCache: dir });
      assert.equal(r.criteria_results[0].judgment_cache, 'miss');
      assert.equal(r.verdict, 'pass');
    } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('a judge outage is not cached (infrastructure, not a judgment); a corrupt cache entry is ignored', async () => {
    const dir = tmp();
    const down = mockFetch(() => { throw new Error('ECONNREFUSED'); });
    try { await verify(C, null, exec(), { judgeCache: dir }); } finally { down.restore(); }
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length, 0);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'README documents --verbose' }));
    try {
      await verify(C, null, exec(), { judgeCache: dir });
      for (const f of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, f), '{"met": "yes"');
      const r = await verify(C, null, exec(), { judgeCache: dir });
      assert.equal(r.criteria_results[0].judgment_cache, 'miss');
    } finally { m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// A node:test report with named test files (qb-node-test-events/1).
const L = (o) => JSON.stringify(o) + '\n';
function report(tests) {
  const ev = tests.map(([file, name, ok]) => L({ type: ok ? 'test:pass' : 'test:fail', name, nesting: 0, path: [], file: `/verify/${file}`, kind: 'test',
    skip: false, todo: false, failureType: ok ? null : 'testCodeFailure', ...(ok ? {} : { error: 'boom' }) }));
  const failed = tests.filter((t) => !t[2]).length;
  return L({ type: 'qb:start', format: FORMAT }) + ev.join('') + L({ type: 'test:summary', file: null,
    counts: { tests: tests.length, passed: tests.length - failed, failed, cancelled: 0, skipped: 0, todo: 0 }, success: failed === 0 }) + L({ type: 'qb:end' });
}
const ran = (tests) => ({ status: 'ran', state: tests.some((t) => !t[2]) ? 'execution_error' : 'completed', exit_code: tests.some((t) => !t[2]) ? 1 : 0, output: '', report: report(tests) });

describe('preservation claims are bounded to named tests', () => {
  const PRES = (extra = {}) => ({ id: 'AC-2', criterion: 'Existing parser tests remain unchanged and pass', met: null, kind: 'behavioral', ...extra });
  const DOC = { id: 'AC-1', criterion: 'README documents the --verbose flag', met: null, kind: 'non_behavioral' };

  test('an unbound preservation criterion makes the contract invalid (pre-fix: finalized, then null forever)', () => {
    const s = contractState({ id: 'c', goal: 'g', clarifying_question: null, acceptance_criteria: [PRES()] });
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join(' | '), /AC-2 is a preservation criterion: name the tests it preserves \(preserves\.tests\)/);
  });
  test('malformed bindings are rejected', () => {
    for (const p of [{ tests: [] }, { tests: ['/abs.js'] }, { tests: ['../x.js'] }, { tests: 'test/a.js' }, { tests: ['test/a.js'], extra: 1 }]) {
      assert.equal(contractState({ id: 'c', goal: 'g', clarifying_question: null, acceptance_criteria: [PRES({ preserves: p })] }).state, 'invalid', JSON.stringify(p));
    }
  });
  test('named tests all ran and passed → met (decided by the test report, not the judge)', async () => {
    const C = contract([DOC, PRES({ preserves: { tests: ['test/parser.test.js'] } })]);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'README documents --verbose' }));
    try {
      const r = await verify(C, null, exec(ran([['test/parser.test.js', 'parses', true], ['test/other.test.js', 'x', true]])));
      const c = r.criteria_results.find((x) => x.id === 'AC-2');
      assert.deepEqual([c.met, c.method], [true, 'test-runner']);
      assert.match(c.evidence, /test\/parser\.test\.js: 1 passed, 0 failed/);
      assert.equal(r.verdict, 'pass');
    } finally { m.restore(); }
  });
  test('a named test failing, or a named test file that did not run → not met', async () => {
    const C = contract([DOC, PRES({ preserves: { tests: ['test/parser.test.js'] } })]);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'README documents --verbose' }));
    try {
      const failing = await verify(C, null, exec(ran([['test/parser.test.js', 'parses', false]])));
      assert.equal(failing.criteria_results.find((x) => x.id === 'AC-2').met, false);
      const absent = await verify(C, null, exec(ran([['test/other.test.js', 'x', true]])));
      const c = absent.criteria_results.find((x) => x.id === 'AC-2');
      assert.equal(c.met, false);
      assert.match(c.evidence, /test\/parser\.test\.js did not run/);
      assert.equal(absent.verdict, 'fail');
    } finally { m.restore(); }
  });
  test('an unusable test run decides nothing: unresolved, never preserved', async () => {
    const C = contract([DOC, PRES({ preserves: { tests: ['test/parser.test.js'] } })]);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'README documents --verbose' }));
    try {
      const r = await verify(C, null, exec({ status: 'ran', state: 'timeout', exit_code: 137, output: '', report: null }));
      assert.equal(r.criteria_results.find((x) => x.id === 'AC-2').met, null);
      assert.notEqual(r.verdict, 'pass');
    } finally { m.restore(); }
  });
  test('no rule treats null as proof of preservation', () => {
    const v = { status: 'ran', state: 'completed', exit_code: 0, outcome: 'passed', outcome_reason: 'tests_passed' };
    const r = aggregate({ rules: 6, oracleApproved: true, policyEffect: 'ok', hasDiff: true, executionStatus: 'completed', verification: v,
      criteriaResults: [{ id: 'AC-1', met: true }, { id: 'AC-2', met: null }], testResults: { passed: 1, failed: 0, skipped: 0 } });
    assert.notEqual(r.verdict, 'pass');
    const { readFileSync } = fs;
    assert.match(readFileSync(path.join(__dirname, '..', '..', 'run', 'store.js'), 'utf8'), /case 'partial':\s+return 'UNRESOLVED'/);
  });
});

describe('calibration: false acceptance, false rejection and abstention are measured separately', () => {
  const ITEMS = [
    { id: 'p1', label: 'met' }, { id: 'p2', label: 'met' }, { id: 'p3', label: 'met' },
    { id: 'n1', label: 'not_met' }, { id: 'n2', label: 'not_met' }, { id: 'n3', label: 'not_met' },
  ];
  test('score(): each kind of error is counted on its own, with rates over the right denominator', () => {
    const s = score([
      { id: 'p1', label: 'met', vote: true }, { id: 'p2', label: 'met', vote: false }, { id: 'p3', label: 'met', vote: null },
      { id: 'n1', label: 'not_met', vote: true }, { id: 'n2', label: 'not_met', vote: false }, { id: 'n3', label: 'not_met', vote: null },
    ]);
    assert.deepEqual({ fa: s.false_accept, fr: s.false_reject, ab: s.abstain, ok: s.correct }, { fa: 1, fr: 1, ab: 2, ok: 2 });
    assert.deepEqual([s.false_accept_rate, s.false_reject_rate, s.abstention_rate], [1 / 3, 1 / 3, 2 / 6]);
  });
  test('calibrate(): one judge vs majority-of-3 from the same sampled calls, with their real call cost', async () => {
    // votes per item (3 independent samples): the majority fixes one sampled false acceptance
    const VOTES = { p1: [true, true, true], p2: [null, true, true], p3: [false, true, true], n1: [true, false, false], n2: [false, false, false], n3: [null, null, false] };
    const report = await calibrate(ITEMS, { votes: 3, sample: async (item, i) => VOTES[item.id][i] });
    const one = report.strategies.find((s) => s.name === 'single');
    const maj = report.strategies.find((s) => s.name === 'majority-3');
    assert.deepEqual([one.calls_per_item, maj.calls_per_item], [1, 3]);
    assert.deepEqual([one.false_accept, one.false_reject, one.abstain], [1, 1, 2]);
    assert.deepEqual([maj.false_accept, maj.false_reject, maj.abstain], [0, 0, 1]);
    assert.ok(typeof report.equal_cost === 'string' && report.equal_cost.length > 0);
  });
});
