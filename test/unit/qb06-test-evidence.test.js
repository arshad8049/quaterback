/**
 * QB-06: only a complete, consistent machine-readable report can approve.
 * Evidence = Docker state + exit code + QB's node:test report
 * (sandbox/agent/qb-test-reporter.mjs, qb-node-test-events/1). Console output
 * never decides. Exit 2, timeout, missing executable, collection failure,
 * malformed / incomplete / contradictory reports, cancelled tests and zero tests
 * never pass; a real failing test (fail) is distinguished from a broken run (error).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { classifyTestRun, validateNodeReport, FORMAT } = require('../../verify/tests');
const { aggregate, inputFromReport } = require('../../verify/verdict');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const FIX = path.join(__dirname, '..', 'fixtures', 'node-test-reports');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
const real = (name) => fs.readFileSync(path.join(FIX, `${name}.ndjson`), 'utf8');
const ran = (exit_code, report, extra = {}) =>
  ({ status: 'ran', state: exit_code === 0 ? 'completed' : 'execution_error', exit_code, output: '', report, ...extra });

/** A report in the qb format from events (for malformed / contradictory cases). */
const L = (o) => JSON.stringify(o) + '\n';
const START = L({ type: 'qb:start', format: FORMAT });
const END = L({ type: 'qb:end' });
const T = (type, name, extra = {}) => L({ type, name, nesting: 0, file: `/w/test/${name}.test.js`, kind: 'test', skip: false, todo: false,
  failureType: type === 'test:fail' ? 'testCodeFailure' : null, ...extra });
const SUM = (counts, success, file = null) => L({ type: 'test:summary', file,
  counts: { tests: 0, passed: 0, failed: 0, cancelled: 0, skipped: 0, todo: 0, ...counts }, success });

describe('real node:test reports (node 24, the sandbox runtime)', () => {
  const expect = {
    pass: ['passed', 'tests_passed'], fail: ['failed', 'tests_failed'], timeout: ['error', 'cancelled_tests'],
    skiponly: ['error', 'zero_tests'], loadfail: ['error', 'collection_failure'], nofiles: ['error', 'zero_tests'],
  };
  for (const [name, [outcome, reason]] of Object.entries(expect)) {
    test(`${name} (exit ${MANIFEST[name]}) → ${outcome} / ${reason}`, () => {
      const c = classifyTestRun(ran(MANIFEST[name], real(name)));
      assert.deepEqual([c.outcome, c.reason], [outcome, reason]);
    });
  }
  test('a repo script with its own --test-reporter writes no QB report → error, never pass', () => {
    assert.equal(MANIFEST.ownreporter, 1);
    assert.deepEqual(Object.values(classifyTestRun(ran(1, null))).slice(0, 2), ['error', 'no_machine_readable_report']);
  });
  test('counts come from the validated summary', () => {
    assert.deepEqual(classifyTestRun(ran(0, real('pass'))).counts, { tests: 3, passed: 3, failed: 0, cancelled: 0, skipped: 0, todo: 0 });
  });
});

describe('senior review reproductions (KAN-6 sent back at 90c4921)', () => {
  const CONSOLE = {
    '"Tests: 1 passed, 0 total"': 'Tests: 1 passed, 0 total\n',
    'node TAP with a cancelled test': '# tests 2\n# pass 1\n# fail 0\n# cancelled 1\n# skipped 0\n# todo 0\n',
    'node TAP without a total': '# pass 1\n# fail 0\n',
  };
  for (const [name, output] of Object.entries(CONSOLE)) {
    test(`console only — ${name}, exit 0 → error (console never decides)`, () => {
      assert.equal(classifyTestRun({ status: 'ran', state: 'completed', exit_code: 0, output, report: null }).outcome, 'error');
    });
  }
  const REPORTS = {
    'passed 1 of 0 total':       [START + T('test:pass', 'a') + SUM({ tests: 0, passed: 1 }, true) + END, 'inconsistent_counts'],
    'a cancelled test':          [START + T('test:pass', 'a') + T('test:fail', 'b', { failureType: 'testTimeoutFailure' })
                                   + SUM({ tests: 2, passed: 1, cancelled: 1 }, false) + END, 'cancelled_tests'],
    'summary without a total':   [START + T('test:pass', 'a') + L({ type: 'test:summary', file: null,
                                   counts: { passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, success: true }) + END, 'incomplete_report'],
  };
  for (const [name, [report, reason]] of Object.entries(REPORTS)) {
    test(`report — ${name}, exit 0 → error / ${reason}`, () => {
      assert.deepEqual(Object.values(classifyTestRun(ran(0, report))).slice(0, 2), ['error', reason]);
    });
  }
  test('verify(): all six never PASS with an affirmative judge', async () => {
    const { verify } = require('../../verify/verifier');
    const contract = { id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'add exists', met: null, kind: 'non_behavioral' }], clarifying_question: null };
    const m = mockFetch(ollamaReply({ met: true, evidence: 'a.js adds add' }));
    try {
      for (const v of [...Object.values(CONSOLE).map((output) => ({ status: 'ran', state: 'completed', exit_code: 0, output, report: null })),
        ...Object.values(REPORTS).map(([r]) => ran(0, r))]) {
        const r = await verify(contract, null, { id: 'e', status: 'completed', diff: 'diff --git a/a.js b/a.js\n+function add(){}', sandbox: { verification: v } }, {});
        assert.equal(r.verdict, 'unresolved', JSON.stringify(r.test_outcome));
      }
    } finally { m.restore(); }
  });
});

describe('report contract: incomplete, malformed or contradictory evidence is rejected', () => {
  const ok = START + T('test:pass', 'a') + SUM({ tests: 1, passed: 1 }, true) + END;
  const CASES = {
    'truncated (no qb:end)':             [ok.replace(END, ''), 'incomplete_report'],
    'truncated mid-line':                [ok.slice(0, -10), 'incomplete_report'],
    'no qb:start':                       [ok.replace(START, ''), 'malformed_report'],
    'wrong format version':              [ok.replace(FORMAT, 'qb-node-test-events/9'), 'malformed_report'],
    'a non-JSON line':                   [START + 'ℹ pass 1\n' + SUM({ tests: 1, passed: 1 }, true) + END, 'malformed_report'],
    'an array line':                     [START + '[1]\n' + SUM({ tests: 1, passed: 1 }, true) + END, 'malformed_report'],
    'no run-level summary':              [START + T('test:pass', 'a') + END, 'incomplete_report'],
    'two run-level summaries':           [START + T('test:pass', 'a') + SUM({ tests: 1, passed: 1 }, true) + SUM({ tests: 1, passed: 1 }, true) + END, 'ambiguous_report'],
    'negative count':                    [START + SUM({ tests: -1, passed: -1 }, true) + END, 'incomplete_report'],
    'success contradicts failures':      [START + T('test:fail', 'a') + SUM({ tests: 1, failed: 1 }, true) + END, 'inconsistent_counts'],
    'events contradict the summary':     [START + T('test:fail', 'a') + SUM({ tests: 1, passed: 1 }, true) + END, 'inconsistent_counts'],
    'fewer events than tests':           [START + T('test:pass', 'a') + SUM({ tests: 2, passed: 2 }, true) + END, 'inconsistent_counts'],
    'per-file sums disagree':            [START + T('test:pass', 'a') + SUM({ tests: 1, passed: 1 }, true, '/w/a.js') + SUM({ tests: 1, passed: 1 }, true, '/w/b.js')
                                           + SUM({ tests: 1, passed: 1 }, true) + END, 'inconsistent_counts'],
    'data after qb:end':                 [ok + SUM({ tests: 1, passed: 1 }, true), 'incomplete_report'],
  };
  for (const [name, [report, reason]] of Object.entries(CASES)) {
    test(`${name} → ${reason}`, () => {
      assert.deepEqual(validateNodeReport(report), { ok: false, reason });
      assert.equal(classifyTestRun(ran(0, report)).outcome, 'error');
    });
  }
  test('a complete, consistent report validates', () => assert.equal(validateNodeReport(ok).ok, true));
});

describe('process evidence', () => {
  const C = [
    ['exit 2 with a passing report',       ran(2, real('pass')),                           'error', 'exit_2_without_test_failures'],
    ['failures but exit 0',                ran(0, real('fail')),                           'error', 'inconsistent_exit'],
    ['timeout (deadline kill)',            ran(null, real('pass'), { state: 'timeout' }),  'error', 'timeout'],
    ['oom',                                ran(137, null, { state: 'oom' }),               'error', 'oom'],
    ['missing executable (127)',           ran(127, null),                                 'error', 'missing_executable'],
    ['not executable (126)',               ran(126, null),                                 'error', 'missing_executable'],
    ['report too large to read',           ran(0, null, { report_error: 'report_too_large' }), 'error', 'report_too_large'],
    ['no test command',                    { status: 'not_run', reason: 'no_test_command' }, 'not_run', 'no_tests'],
    ['dependency change',                  { status: 'not_run', reason: 'dependency_change_required' }, 'not_run', 'dependency_change_required'],
    ['no sandbox verification',            null,                                           'not_run', 'no_test_evidence'],
  ];
  for (const [name, v, outcome, reason] of C) {
    test(`${name} → ${outcome} / ${reason}`, () => {
      const c = classifyTestRun(v);
      assert.deepEqual([c.outcome, c.reason], [outcome, reason]);
    });
  }
  test('exit 137 is recorded as an exit code, not inferred as a signal', () => {
    const c = classifyTestRun(ran(137, null, { state: 'oom' }));
    assert.equal(c.exit_code, 137);
    assert.equal('signal' in c, false);
  });
});

describe('aggregate (rules 2) and verify()', () => {
  const met = [{ id: 'AC-1', met: true }];
  const agg = (v) => aggregate({ rules: 2, hasDiff: true, criteriaResults: met, testResults: null,
    verification: v && { ...v, outcome: classifyTestRun(v).outcome } }).verdict;
  test('passed → pass', () => assert.equal(agg(ran(0, real('pass'))), 'pass'));
  test('a real failing test → fail', () => assert.equal(agg(ran(1, real('fail'))), 'fail'));
  test('a broken run → unresolved', () => assert.equal(agg(ran(1, real('loadfail'))), 'unresolved'));
  test('no evidence → unresolved', () => assert.equal(agg(null), 'unresolved'));
  test('legacy inputs (no rules field) replay with the old rules', () => {
    assert.equal(aggregate({ hasDiff: true, criteriaResults: met, testResults: null, verification: null }).verdict, 'pass');
  });
  test('run records store rules 2 and the classified outcome', () => {
    const input = inputFromReport({ criteria_results: [{ id: 'AC-1', met: true }], test_results: null },
      { status: 'completed', diff: 'd', sandbox: { verification: ran(2, real('pass')) } });
    assert.equal(input.rules, 2);
    assert.deepEqual([input.verification.outcome, input.verification.outcome_reason], ['error', 'exit_2_without_test_failures']);
  });
  test('verify(): passing report → pass; judge fields survive the report schema', async () => {
    const { verify } = require('../../verify/verifier');
    const m = mockFetch(ollamaReply({ met: true, evidence: 'a.js defines add' }));
    try {
      const r = await verify({ id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'add() is defined', met: null, kind: 'non_behavioral' }], clarifying_question: null },
        null, { id: 'e', status: 'completed', diff: 'diff --git a/a.js b/a.js\n+function add() {}', sandbox: { verification: ran(0, real('pass')) } }, {});
      assert.equal(r.verdict, 'pass');
      assert.deepEqual([r.test_outcome.outcome, r.test_outcome.runner], ['passed', 'node-test']);
      assert.equal(r.criteria_results[0].judgment_status, 'ok');
    } finally { m.restore(); }
  });
});

// The format contract against the live runner, where the host Node has
// test:summary (22+; CI runs 22 and 24). The sandbox itself runs Node 24.
const MAJOR = Number(process.versions.node.split('.')[0]);
describe('live: the real reporter on this Node', { skip: MAJOR < 22 && `node ${process.version} has no test:summary event` }, () => {
  const REPORTER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-test-reporter.mjs');
  const live = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb06-live-'));
    try {
      fs.mkdirSync(path.join(dir, 'test'));
      fs.writeFileSync(path.join(dir, 'test', 'x.test.js'), body);
      const out = path.join(dir, 'r.ndjson');
      const r = spawnSync(process.execPath, ['--test', 'test/x.test.js'], { cwd: dir, encoding: 'utf8',
        // NODE_TEST_CONTEXT (set by the outer test runner) would make the nested run
        // report to its parent instead of to reporters; the sandbox never has it.
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')),
          NODE_OPTIONS: `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER} --test-reporter-destination=${out}` } });
      return classifyTestRun(ran(r.status, fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  test('passing → passed', () => assert.equal(live("require('node:test')('a', () => {});").outcome, 'passed'));
  test('failing → failed', () => assert.equal(live("require('node:test')('a', () => { throw new Error('x'); });").outcome, 'failed'));
  test('timed out → error / cancelled_tests', () => assert.equal(live("require('node:test')('a', { timeout: 20 }, () => new Promise(r => setTimeout(r, 300)));").reason, 'cancelled_tests'));
});
