/**
 * QB-10: failure routing keeps test failures and repair actions.
 * - a newly failing regression enters a bounded repair with its test evidence;
 * - a test that already fails on the base tree stays visible (not blamed on the change);
 * - unknown ACs cannot hide a definite failure;
 * - infrastructure errors go to environment recovery, not code repair;
 * - an unchanged patch does not restart repairs.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { classifyTestRun, FORMAT } = require('../../verify/tests');
const { aggregate, inputFromReport } = require('../../verify/verdict');
const { routeRepair } = require('../../verify/routing');
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

// qb-node-test-events/1 reports: root '/verify' for the candidate, '/scratch' for the base run.
const L = (o) => JSON.stringify(o) + '\n';
function report(root, tests) {
  const ev = tests.map(([name, ok, error]) => L({ type: ok ? 'test:pass' : 'test:fail', name, nesting: 0, file: `${root}/test/x.test.js`,
    kind: 'test', skip: false, todo: false, failureType: ok ? null : 'testCodeFailure', ...(ok ? {} : { error: error || 'assertion failed' }) }));
  const failed = tests.filter((t) => !t[1]).length;
  return L({ type: 'qb:start', format: FORMAT }) + ev.join('') + L({ type: 'test:summary', file: null,
    counts: { tests: tests.length, passed: tests.length - failed, failed, cancelled: 0, skipped: 0, todo: 0 }, success: failed === 0 }) + L({ type: 'qb:end' });
}
const run = (tests, base) => ({ status: 'ran', state: tests.some((t) => !t[1]) ? 'execution_error' : 'completed', exit_code: tests.some((t) => !t[1]) ? 1 : 0,
  output: '', report: report('/verify', tests), ...(base ? { base } : {}) });
const baseRun = (tests) => ({ state: 'execution_error', exit_code: 1, report: report('/scratch', tests), report_error: null, tree: 'b'.repeat(40) });

describe('base vs candidate test evidence', () => {
  test('a new failure (passes on base) is a regression with its evidence', () => {
    const c = classifyTestRun(run([['doubles', false, 'Expected 4, got 0'], ['strings', true]], baseRun([['doubles', true], ['strings', true]])));
    assert.deepEqual([c.outcome, c.regressions.map((t) => [t.file, t.name, t.error]), c.preexisting], ['failed', [['test/x.test.js', 'doubles', 'Expected 4, got 0']], []]);
  });
  test('a failure that also happens on the base stays visible as pre-existing, not as a regression', () => {
    const c = classifyTestRun(run([['flaky', false], ['doubles', true]], baseRun([['flaky', false], ['doubles', true]])));
    assert.deepEqual([c.outcome, c.regressions, c.preexisting.map((t) => t.name), c.baseline], ['preexisting_failures', [], ['flaky'], 'compared']);
  });
  test('mixed: only the new failure is a regression', () => {
    const c = classifyTestRun(run([['flaky', false], ['doubles', false]], baseRun([['flaky', false], ['doubles', true]])));
    assert.deepEqual([c.outcome, c.regressions.map((t) => t.name), c.preexisting.map((t) => t.name)], ['failed', ['doubles'], ['flaky']]);
  });
  test('no usable base run: every failure counts as a regression (conservative), with the reason', () => {
    for (const [base, why] of [[undefined, 'baseline_not_run'], [{ report: null, report_error: 'no_machine_readable_report' }, 'baseline_no_machine_readable_report'],
      [{ report: 'garbage\n' }, 'baseline_malformed_report']]) {
      const c = classifyTestRun(run([['flaky', false]], base));
      assert.deepEqual([c.outcome, c.regressions.map((t) => t.name), c.baseline], ['failed', ['flaky'], why]);
    }
  });
});

describe('verdict and repair actions', () => {
  const C = (extra = {}) => approve({ id: 'c', goal: 'g', clarifying_question: null, scope: { allowed_changes: ['src/**'] },
    acceptance_criteria: [{ id: 'AC-1', criterion: 'README style', met: null, kind: 'non_behavioral' }], ...extra }, { via: 'test' });
  const EX = (verification) => ({ id: 'e', status: 'completed', diff: 'diff --git a/src/a.js b/src/a.js\n+x', changes: [{ file: 'src/a.js', status: 'M' }], sandbox: { verification } });
  const V = async (c, e, judge = { met: true, evidence: 'ok' }) => { const m = mockFetch(ollamaReply(judge)); try { return await verify(c, null, e, {}); } finally { m.restore(); } };

  test('every AC met but a test newly fails → FAIL with a concrete repair action and its evidence (pre-fix: no hints, loop stopped)', async () => {
    const r = await V(C(), EX(run([['doubles', false, 'Expected 4, got 0']], baseRun([['doubles', true]]))));
    assert.equal(r.verdict, 'fail');
    const h = r.repair_hints.find((x) => x.criterion_id.startsWith('TEST:'));
    assert.match(h.diagnosis, /Test "doubles" \(test\/x\.test\.js\) fails after this change: Expected 4, got 0/);
    assert.equal(routeRepair(r).action, 'repair');
    assert.deepEqual(r.outcomes, { execution: 'completed', policy: 'ok', tests: 'failed', criteria: 'met' });
  });
  test('unknown ACs cannot hide a definite failure', async () => {
    const r = await V(C(), EX(run([['doubles', false]], baseRun([['doubles', true]]))), { met: null, evidence: 'unclear' });
    assert.equal(r.verdict, 'fail');
    assert.equal(r.outcomes.criteria, 'unknown');
  });
  test('only pre-existing failures: they stay listed, are not blamed on the change, and no test repair is invented', async () => {
    const r = await V(C(), EX(run([['flaky', false], ['doubles', true]], baseRun([['flaky', false], ['doubles', true]]))));
    assert.equal(r.verdict, 'pass');
    assert.deepEqual(r.test_outcome.preexisting.map((t) => t.name), ['flaky']);
    assert.ok(!r.repair_hints.some((h) => h.criterion_id.startsWith('TEST:')));
  });
  test('rules 5 is stored and replays; the same evidence under rules 4 replays as it was decided then', async () => {
    const e = EX(run([['flaky', false], ['doubles', true]], baseRun([['flaky', false], ['doubles', true]])));
    const r = await V(C(), e);
    const input = inputFromReport(r, e);
    assert.deepEqual([input.rules, aggregate(input).verdict], [5, 'pass']);
    assert.equal(aggregate({ ...input, rules: 4 }).verdict, 'fail', 'pre-QB-10: any failed count forced FAIL');
  });
});

describe('routing', () => {
  const R = (o) => ({ verdict: 'fail', repair_hints: [{ criterion_id: 'AC-1', diagnosis: 'd', suggested_fix: 'f' }], test_outcome: { outcome: 'failed' }, ...o });
  test('pass → done', () => assert.equal(routeRepair({ verdict: 'pass' }).action, 'done'));
  test('agent execution failure → environment, not code repair', () => assert.equal(routeRepair(R({ verdict: 'error' })).action, 'environment'));
  for (const reason of ['timeout', 'oom', 'infra', 'no_machine_readable_report', 'collection_failure', 'cancelled_tests']) {
    test(`unusable test run (${reason}) → environment, not code repair`, () => {
      const r = routeRepair(R({ verdict: 'unresolved', test_outcome: { outcome: 'error', reason } }));
      assert.equal(r.action, 'environment');
      assert.match(r.reason, new RegExp(reason));
    });
  }
  test('nothing concrete to repair → stop', () => assert.equal(routeRepair(R({ repair_hints: [] })).action, 'stop'));
  test('an unchanged patch does not restart repairs', () => {
    assert.equal(routeRepair(R(), { patch: 'diff A', previousPatch: 'diff A' }).action, 'stop');
    assert.equal(routeRepair(R(), { patch: 'diff B', previousPatch: 'diff A' }).action, 'repair');
  });
});

const MAJOR = Number(process.versions.node.split('.')[0]);
test('live: the reporter records the assertion message of a failing test', { skip: MAJOR < 22 && 'node < 22 has no test:summary' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb10-live-'));
  try {
    fs.mkdirSync(path.join(dir, 'test'));
    fs.writeFileSync(path.join(dir, 'test', 'x.test.js'), "require('node:test')('doubles', () => require('node:assert').strictEqual(0, 4));\n");
    const out = path.join(dir, 'r.ndjson');
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT'));
    const reporter = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-test-reporter.mjs');
    const r = spawnSync(process.execPath, ['--test', 'test/x.test.js'], { cwd: dir, encoding: 'utf8',
      env: { ...env, NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${reporter} --test-reporter-destination=${out}` } });
    const c = classifyTestRun({ status: 'ran', state: 'execution_error', exit_code: r.status, report: fs.readFileSync(out, 'utf8') });
    assert.equal(c.outcome, 'failed');
    assert.match(c.regressions[0].error, /0 !== 4|Expected values to be strictly equal/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
