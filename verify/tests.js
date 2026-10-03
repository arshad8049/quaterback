/**
 * verify/tests.js — classify the sandbox test run (QB-06).
 *
 * Evidence comes from sandbox stage ⑤ (lib/sandbox/stages.js), which runs the
 * base `npm test` on a disposable copy of the candidate:
 *   - Docker's container state: Status, ExitCode, OOMKilled, plus QB's own
 *     deadline/cancel bookkeeping (state: timeout / oom / infra_error / …).
 *     Docker reports no terminating signal, and none is inferred from the exit
 *     code: 137 is recorded as exit 137, not as SIGKILL;
 *   - the machine-readable report written by QB's node:test reporter
 *     (sandbox/agent/qb-test-reporter.mjs, format qb-node-test-events/1),
 *     injected through NODE_OPTIONS. Console output is kept as evidence for
 *     people but never decides an outcome.
 *
 * Outcomes:
 *   passed   exit 0, a complete and consistent report, at least one test passed,
 *            none failed or cancelled
 *   failed   the report shows failing tests and the run exited nonzero (a real
 *            test failure: the task FAILS)
 *   error    the run cannot be trusted: no report (unsupported runner, or the
 *            repo's own reporter flags), malformed / incomplete / inconsistent
 *            report, cancelled tests (incl. test timeouts), collection failure,
 *            zero tests, timeout, OOM, infrastructure, missing executable
 *            (126/127), or an exit code that contradicts the report
 *   not_run  no test run happened — cannot approve
 *
 * Supported runner: node:test (Node's built-in runner, `node --test`). Other
 * runners produce no QB report and are therefore `error`, never a pass.
 */

const FORMAT = 'qb-node-test-events/1';
const COUNT_KEYS = ['tests', 'passed', 'failed', 'cancelled', 'skipped', 'todo'];

/**
 * Validate a qb-node-test-events/1 report. Never fills in missing evidence.
 * @returns {{ ok: true, counts, collectionFailures: string[] } | { ok: false, reason: string }}
 */
function validateNodeReport(text) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof text !== 'string' || !text.endsWith('\n')) return bad('incomplete_report');
  const events = [];
  for (const line of text.slice(0, -1).split('\n')) {
    let e;
    try { e = JSON.parse(line); } catch { return bad('malformed_report'); }
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.type !== 'string') return bad('malformed_report');
    events.push(e);
  }
  if (events[0]?.type !== 'qb:start' || events[0].format !== FORMAT) return bad('malformed_report');
  if (events.at(-1)?.type !== 'qb:end') return bad('incomplete_report');
  if (events.filter((e) => e.type === 'qb:start' || e.type === 'qb:end').length !== 2) return bad('malformed_report');

  const summaries = events.filter((e) => e.type === 'test:summary');
  const runLevel = summaries.filter((e) => e.file === null);
  if (runLevel.length !== 1) return bad(runLevel.length ? 'ambiguous_report' : 'incomplete_report');
  const { counts, success } = runLevel[0];
  if (!counts || typeof counts !== 'object') return bad('incomplete_report');
  for (const k of COUNT_KEYS) if (!Number.isInteger(counts[k]) || counts[k] < 0) return bad('incomplete_report');
  if (typeof success !== 'boolean') return bad('incomplete_report');

  const sum = counts.passed + counts.failed + counts.cancelled + counts.skipped + counts.todo;
  if (counts.tests !== sum) return bad('inconsistent_counts');
  if (success !== (counts.failed === 0 && counts.cancelled === 0)) return bad('inconsistent_counts');

  // Per-file summaries, when present, must add up to the run-level summary.
  const perFile = summaries.filter((e) => e.file !== null);
  if (perFile.length) {
    for (const k of COUNT_KEYS) {
      const t = perFile.reduce((n, e) => n + (Number.isInteger(e.counts?.[k]) ? e.counts[k] : NaN), 0);
      if (t !== counts[k]) return bad('inconsistent_counts');
    }
  }

  // Every test reported individually must match the summary.
  const tests = events.filter((e) => (e.type === 'test:pass' || e.type === 'test:fail') && e.kind === 'test');
  const passes = tests.filter((e) => e.type === 'test:pass');
  const fails = tests.filter((e) => e.type === 'test:fail');
  if (tests.length !== counts.tests
    || passes.filter((e) => !e.skip && !e.todo).length !== counts.passed
    || passes.filter((e) => e.skip).length !== counts.skipped
    || tests.filter((e) => e.todo).length !== counts.todo
    || fails.filter((e) => !e.todo).length !== counts.failed + counts.cancelled) {
    return bad('inconsistent_counts');
  }

  // A test file that failed to load is reported as a top-level failing "test"
  // named after the file itself: a collection failure, not a test result.
  const collectionFailures = fails
    .filter((e) => e.nesting === 0 && typeof e.file === 'string' && /\.(c|m)?[jt]s$/.test(e.name) && e.file.endsWith(`/${e.name}`))
    .map((e) => e.name);

  return { ok: true, counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, counts[k]])), collectionFailures };
}

/**
 * @param {object|null} v - execution.sandbox.verification
 *   { status, reason, state, exit_code, output, report: string|null, report_error: string|null }
 * @returns {{ outcome: 'passed'|'failed'|'error'|'not_run', reason: string, runner: string|null,
 *             counts: object|null, exit_code: number|null }}
 */
function classifyTestRun(v) {
  const exit_code = v && Number.isInteger(v.exit_code) ? v.exit_code : null;
  const res = (outcome, reason, extra = {}) => ({ outcome, reason, runner: null, counts: null, exit_code, ...extra });

  if (!v) return res('not_run', 'no_test_evidence');
  if (v.status !== 'ran') return res('not_run', v.reason === 'no_test_command' ? 'no_tests' : (v.reason || 'not_run'));
  if (['timeout', 'oom', 'infra_error', 'cancelled'].includes(v.state)) return res('error', v.state === 'infra_error' ? 'infra' : v.state);
  if (exit_code === null) return res('error', 'no_exit_code');
  if (exit_code === 126 || exit_code === 127) return res('error', 'missing_executable');

  if (typeof v.report !== 'string') return res('error', v.report_error || 'no_machine_readable_report');
  const r = validateNodeReport(v.report);
  if (!r.ok) return res('error', r.reason);
  const c = r.counts;
  const known = { runner: 'node-test', counts: c };
  if (r.collectionFailures.length) return res('error', 'collection_failure', known);
  if (c.cancelled > 0) return res('error', 'cancelled_tests', known);
  if (c.failed > 0) return exit_code !== 0 ? res('failed', 'tests_failed', known) : res('error', 'inconsistent_exit', known);
  if (exit_code !== 0) return res('error', `exit_${exit_code}_without_test_failures`, known);
  if (c.passed === 0) return res('error', 'zero_tests', known);
  return res('passed', 'tests_passed', known);
}

module.exports = { classifyTestRun, validateNodeReport, FORMAT };
