/**
 * QB-06: test evidence is classified, not guessed. Exit 2, timeout, missing
 * executable, collection failure, malformed report and zero tests never pass;
 * a real failing test (fail) is distinguished from a broken run (error).
 * No test evidence at all cannot approve a task either.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyTestRun } = require('../../verify/tests');
const { aggregate, inputFromReport } = require('../../verify/verdict');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const ran = (exit_code, output, state = exit_code === 0 ? 'completed' : 'execution_error') =>
  ({ status: 'ran', state, exit_code, output });
const NODE_SPEC = (p, f) => `▶ suite\n  ✔ a\nℹ tests ${p + f}\nℹ suites 1\nℹ pass ${p}\nℹ fail ${f}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 12\n`;
const NODE_TAP = (p, f) => `TAP version 13\nok 1 - a\n1..${p + f}\n# tests ${p + f}\n# pass ${p}\n# fail ${f}\n# skipped 0\n# todo 0\n`;

const CASES = [
  // [name, verification, outcome, reason]
  ['node spec, all pass',            ran(0, NODE_SPEC(3, 0)),                                  'passed', 'tests_passed'],
  ['node TAP, all pass',             ran(0, NODE_TAP(2, 0)),                                   'passed', 'tests_passed'],
  ['jest pass',                      ran(0, 'Tests:       3 passed, 3 total\n'),               'passed', 'tests_passed'],
  ['mocha pass',                     ran(0, '  3 passing (8ms)\n'),                            'passed', 'tests_passed'],
  ['vitest pass',                    ran(0, '      Tests  3 passed (3)\n'),                    'passed', 'tests_passed'],
  ['node spec, real failure',        ran(1, NODE_SPEC(2, 1)),                                  'failed', 'tests_failed'],
  ['jest real failure',              ran(1, 'Tests:       1 failed, 2 passed, 3 total\n'),     'failed', 'tests_failed'],
  ['mocha real failures (exit = n)', ran(2, '  1 passing\n  2 failing\n'),                     'failed', 'tests_failed'],
  ['vitest real failure',            ran(1, '      Tests  1 failed | 2 passed (3)\n'),         'failed', 'tests_failed'],
  ['exit 2 with no failures',        ran(2, ''),                                               'error',  'exit_2_without_test_failures'],
  ['exit 2 with a clean summary',    ran(2, NODE_SPEC(3, 0)),                                  'error',  'exit_2_without_test_failures'],
  ['timeout',                        ran(null, NODE_SPEC(1, 0), 'timeout'),                    'error',  'timeout'],
  ['oom',                            ran(137, '', 'oom'),                                      'error',  'oom'],
  ['missing executable (127)',       ran(127, 'sh: 1: jest: not found\n'),                     'error',  'missing_executable'],
  ['not executable (126)',           ran(126, 'sh: 1: ./t: Permission denied\n'),              'error',  'missing_executable'],
  ['jest collection failure',        ran(1, ' FAIL  t.test.js\n  ● Test suite failed to run\n\nTests:       0 total\n'), 'error', 'collection_failure'],
  ['node module not found',          ran(1, `Error: Cannot find module './x'\n${NODE_SPEC(0, 1)}`), 'error', 'collection_failure'],
  ['mocha no test files',            ran(1, 'Error: No test files found: "test"\n'),           'error',  'collection_failure'],
  ['malformed report, exit 0',       ran(0, 'all good!\n'),                                    'error',  'unrecognized_report'],
  ['malformed report, exit 1',       ran(1, 'something broke\n'),                              'error',  'exit_1_without_test_failures'],
  ['zero tests, exit 0',             ran(0, NODE_SPEC(0, 0)),                                  'error',  'zero_tests'],
  ['failures reported, exit 0',      ran(0, NODE_SPEC(1, 1)),                                  'error',  'inconsistent_report'],
  ['no test command',                { status: 'not_run', reason: 'no_test_command' },         'not_run', 'no_tests'],
  ['dependency change',              { status: 'not_run', reason: 'dependency_change_required' }, 'not_run', 'dependency_change_required'],
  ['no sandbox verification',        null,                                                     'not_run', 'no_test_evidence'],
];

describe('classifyTestRun', () => {
  for (const [name, v, outcome, reason] of CASES) {
    test(`${name} → ${outcome} (${reason})`, () => {
      const c = classifyTestRun(v);
      assert.deepEqual([c.outcome, c.reason], [outcome, reason]);
    });
  }
  test('counts and runner are reported', () => {
    assert.deepEqual(classifyTestRun(ran(1, 'Tests:       1 failed, 2 passed, 3 total\n')).counts,
      { total: 3, passed: 2, failed: 1, skipped: 0 });
    assert.equal(classifyTestRun(ran(0, NODE_SPEC(3, 0))).runner, 'node-test');
  });
});

describe('aggregate (rules 2): only passed test evidence can approve', () => {
  const met = [{ id: 'AC-1', met: true }];
  const agg = (v) => aggregate({ rules: 2, hasDiff: true, criteriaResults: met, testResults: null,
    verification: v && { ...v, ...classifyTestRun(v) } }).verdict;
  test('passed → pass', () => assert.equal(agg(ran(0, NODE_SPEC(3, 0))), 'pass'));
  test('a real failing test → fail', () => assert.equal(agg(ran(1, NODE_SPEC(2, 1))), 'fail'));
  for (const [name, v, outcome] of CASES.filter((c) => c[2] === 'error' || c[2] === 'not_run')) {
    test(`${name} (${outcome}) → unresolved, never pass`, () => assert.equal(agg(v), 'unresolved'));
  }
  test('legacy inputs (no rules field) replay with the old rules', () => {
    assert.equal(aggregate({ hasDiff: true, criteriaResults: met, testResults: null, verification: null }).verdict, 'pass');
  });
  test('new run records store rules 2 and the classified outcome', () => {
    const input = inputFromReport({ criteria_results: [{ id: 'AC-1', met: true }], test_results: null },
      { status: 'completed', diff: 'd', sandbox: { verification: ran(2, '') } });
    assert.equal(input.rules, 2);
    assert.deepEqual([input.verification.outcome, input.verification.outcome_reason], ['error', 'exit_2_without_test_failures']);
    assert.equal(aggregate(input).verdict, 'unresolved');
  });
});

describe('verify(): end to end with an affirmative judge', () => {
  const contract = { id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'add() is defined', met: null }], clarifying_question: null };
  const run = async (verification) => {
    const { verify } = require('../../verify/verifier');
    const m = mockFetch(ollamaReply({ met: true, evidence: 'a.js defines add' }));
    try {
      return await verify(contract, null, { id: 'e', status: 'completed', diff: 'diff --git a/a.js b/a.js\n+function add() {}',
        sandbox: verification === undefined ? undefined : { verification } }, { repoPath: null });
    } finally { m.restore(); }
  };
  test('exit 2 in the sandbox → unresolved with the reason in the report', async () => {
    const r = await run(ran(2, ''));
    assert.equal(r.verdict, 'unresolved');
    assert.deepEqual([r.test_outcome.outcome, r.test_outcome.reason, r.test_outcome.exit_code], ['error', 'exit_2_without_test_failures', 2]);
  });
  test('a real failing test → fail', async () => assert.equal((await run(ran(1, NODE_SPEC(2, 1)))).verdict, 'fail'));
  test('passing tests → pass, and the judge fields survive the report schema', async () => {
    const r = await run(ran(0, NODE_SPEC(3, 0)));
    assert.equal(r.verdict, 'pass');
    assert.equal(r.criteria_results[0].judgment_status, 'ok');
    assert.deepEqual(r.criteria_results[0].vote_status, ['ok', 'ok', 'ok']);
  });
  test('no sandbox verification at all → unresolved', async () => assert.equal((await run(undefined)).verdict, 'unresolved'));
});
