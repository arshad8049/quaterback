/**
 * verify/tests.js — classify the sandbox test run (QB-06).
 *
 * The verification stage (lib/sandbox/stages.js ⑤) runs the base `npm test` on a
 * disposable copy of the candidate and records state, exit code, duration and
 * the output tail. This turns that evidence into exactly one outcome:
 *
 *   passed   exit 0, a recognised runner summary, at least one test, none failed
 *   failed   a recognised summary reports failing tests and the run exited nonzero
 *            (a real test failure: the task FAILS)
 *   error    the run cannot be trusted: timeout, OOM, infrastructure, missing
 *            executable (126/127), collection failure, unrecognised report, zero
 *            tests, a nonzero exit with no reported failures, or a summary that
 *            contradicts the exit code (cannot approve; not a test failure)
 *   not_run  no test run happened (no test command, dependency change, no
 *            sandbox verification at all) — cannot approve
 *
 * Runner adapters read each runner's machine-printed summary line (node:test
 * TAP and spec, jest, vitest, mocha). Output that matches none is "unrecognised",
 * never a pass.
 */

/** Parse a known runner summary. Returns { runner, total, passed, failed, skipped } or null. */
function parseSummary(out) {
  const num = (re) => { const m = re.exec(out); return m ? Number(m[1]) : null; };

  // jest: "Tests:       1 failed, 2 passed, 3 total"
  const jest = /^Tests:\s+(.*\btotal)\s*$/m.exec(out);
  if (jest) {
    const part = (k) => { const m = new RegExp(`(\\d+) ${k}`).exec(jest[1]); return m ? Number(m[1]) : 0; };
    return { runner: 'jest', total: part('total'), passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo') };
  }
  // vitest: "      Tests  1 failed | 2 passed (3)"
  const vitest = /^\s*Tests\s+(.*)\((\d+)\)\s*$/m.exec(out);
  if (vitest) {
    const part = (k) => { const m = new RegExp(`(\\d+) ${k}`).exec(vitest[1]); return m ? Number(m[1]) : 0; };
    return { runner: 'vitest', total: Number(vitest[2]), passed: part('passed'), failed: part('failed'), skipped: part('skipped') + part('todo') };
  }
  // node:test — TAP ("# pass N") or spec ("ℹ pass N")
  const node = (k) => num(new RegExp(`^(?:#|ℹ) ${k} (\\d+)\\s*$`, 'm'));
  if (node('pass') !== null && node('fail') !== null) {
    const skipped = (node('skipped') || 0) + (node('todo') || 0);
    const passed = node('pass'), failed = node('fail');
    return { runner: 'node-test', total: node('tests') ?? passed + failed + skipped, passed, failed, skipped };
  }
  // mocha: "  3 passing (8ms)" / "  1 failing" / "  2 pending"
  const passing = num(/^\s*(\d+) passing\b/m);
  if (passing !== null) {
    const failed = num(/^\s*(\d+) failing\b/m) || 0, skipped = num(/^\s*(\d+) pending\b/m) || 0;
    return { runner: 'mocha', total: passing + failed + skipped, passed: passing, failed, skipped };
  }
  return null;
}

// The test files could not be loaded or found: not a test result.
const COLLECTION_FAILURE = [
  /Test suite failed to run/,          // jest
  /No test files found/i,              // mocha, vitest
  /Cannot find module/,                // node / CommonJS
  /ERR_MODULE_NOT_FOUND/,              // node / ESM
  /^SyntaxError:/m,
];

/**
 * @param {object|null} v - execution.sandbox.verification
 * @returns {{ outcome: 'passed'|'failed'|'error'|'not_run', reason: string, runner: string|null,
 *             counts: object|null, exit_code: number|null }}
 */
function classifyTestRun(v) {
  const res = (outcome, reason, extra = {}) =>
    ({ outcome, reason, runner: null, counts: null, exit_code: v && Number.isInteger(v.exit_code) ? v.exit_code : null, ...extra });

  if (!v) return res('not_run', 'no_test_evidence');
  if (v.status !== 'ran') return res('not_run', v.reason === 'no_test_command' ? 'no_tests' : (v.reason || 'not_run'));
  if (['timeout', 'oom', 'infra_error', 'cancelled'].includes(v.state)) return res('error', v.state === 'infra_error' ? 'infra' : v.state);

  const code = Number.isInteger(v.exit_code) ? v.exit_code : null;
  if (code === null) return res('error', 'no_exit_code');
  if (code === 126 || code === 127) return res('error', 'missing_executable');

  const out = typeof v.output === 'string' ? v.output : '';
  if (COLLECTION_FAILURE.some((re) => re.test(out))) return res('error', 'collection_failure');

  const s = parseSummary(out);
  const counted = s && { runner: s.runner, counts: { total: s.total, passed: s.passed, failed: s.failed, skipped: s.skipped } };
  if (code === 0) {
    if (!s) return res('error', 'unrecognized_report');
    if (s.failed > 0) return res('error', 'inconsistent_report', counted);
    if (s.passed + s.failed === 0) return res('error', 'zero_tests', counted);
    return res('passed', 'tests_passed', counted);
  }
  if (s && s.failed > 0) return res('failed', 'tests_failed', counted);
  return res('error', `exit_${code}_without_test_failures`, counted || {});
}

module.exports = { classifyTestRun, parseSummary };
