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

  // QB-10: every failing test (no truncation: the decision compares the full set;
  // only what is displayed is bounded, in the verifier). Identity = file relative
  // to the run root + suite path + name; `path` is null when the reporter could not
  // establish it, and such a test can never be matched as pre-existing.
  const failingTests = fails.filter((e) => !e.todo).map((e) => ({
    file: relFile(e.file), path: validPath(e.path, e.nesting), name: String(e.name), failureType: e.failureType ?? null,
    error: typeof e.error === 'string' ? e.error.slice(0, 500) : '',
  }));
  // QB-15: per test file (relative to the run root), for preservation claims bound to named tests.
  const byFile = {};
  for (const e of tests) {
    const f = relFile(e.file);
    if (!f || e.todo) continue;
    const s = byFile[f] || (byFile[f] = { passed: 0, failed: 0, skipped: 0 });
    if (e.type === 'test:fail') s.failed++; else if (e.skip) s.skipped++; else s.passed++;
  }
  return { ok: true, counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, counts[k]])), collectionFailures, failingTests, byFile };
}

/** A reporter path made relative to the run root (/verify, /scratch, or the host temp dir in tests). */
function relFile(f) {
  if (typeof f !== 'string') return null;
  const m = /^\/(?:verify|scratch)\/(.*)$/.exec(f);
  return m ? m[1] : f.replace(/^.*?\/(test|tests|__tests__|spec)\//, '$1/');
}
const validPath = (p, nesting) => (Array.isArray(p) && p.length === nesting && p.every((x) => typeof x === 'string') ? p.map(String) : null);
/** Full test identity, or null when it cannot be established (never matched). */
const testId = (t) => (typeof t.file === 'string' && t.path ? JSON.stringify([t.file, ...t.path, t.name]) : null);
/** The same failure: same identity, same failure type, same assertion message. */
const sameFailure = (a, b) => a.failureType === b.failureType && a.error === b.error;

/**
 * @param {object|null} v - execution.sandbox.verification
 *   { status, reason, state, exit_code, output, report: string|null, report_error: string|null, base? }
 * @param {{ preexisting?: 'block'|'waive' }} opts - QB-10: failures that are provably
 *   pre-existing only stop blocking PASS when the approved contract says
 *   `test_policy.preexisting_failures: "waive"`; by default they still fail the task.
 * @returns {{ outcome: 'passed'|'failed'|'error'|'not_run', reason: string, runner: string|null,
 *             counts: object|null, exit_code: number|null }}
 */
function classifyTestRun(v, { preexisting: preexistingPolicy = 'block' } = {}) {
  const exit_code = v && Number.isInteger(v.exit_code) ? v.exit_code : null;
  const res = (outcome, reason, extra = {}) => ({ outcome, reason, runner: null, counts: null, exit_code, ...extra });

  if (!v) return res('not_run', 'no_test_evidence');
  if (v.status !== 'ran') return res('not_run', v.reason === 'no_test_command' ? 'no_tests' : (v.reason || 'not_run'), v.detail ? { detail: v.detail } : {});   // QB-20: e.g. why a runner was refused
  if (['timeout', 'oom', 'infra_error', 'cancelled'].includes(v.state)) return res('error', v.state === 'infra_error' ? 'infra' : v.state);
  if (exit_code === null) return res('error', 'no_exit_code');
  if (exit_code === 126 || exit_code === 127) return res('error', 'missing_executable');

  if (typeof v.report !== 'string') return res('error', v.report_error || 'no_machine_readable_report');
  const r = validateNodeReport(v.report);
  if (!r.ok) return res('error', r.reason);
  const c = r.counts;
  const known = { runner: 'node-test', counts: c, byFile: r.byFile };
  if (r.collectionFailures.length) return res('error', 'collection_failure', known);
  if (c.cancelled > 0) return res('error', 'cancelled_tests', known);
  if (c.failed > 0) {
    if (exit_code === 0) return res('error', 'inconsistent_exit', known);
    // QB-10: which failures are new? Compare with the same suite on the base tree.
    const failures = r.failingTests;
    const base = baseFailures(v.base);
    if (!base.ok) return res('failed', 'tests_failed', { ...known, failures, regressions: failures, preexisting: [], baseline: base.reason });
    const { regressions, preexisting } = compareFailures(failures, base.failures);
    if (regressions.length) return res('failed', 'tests_failed', { ...known, failures, regressions, preexisting, baseline: 'compared' });
    return preexistingPolicy === 'waive'
      ? res('preexisting_failures', 'only_preexisting_failures', { ...known, failures, regressions: [], preexisting, baseline: 'compared' })
      : res('failed', 'preexisting_failures_not_waived', { ...known, failures, regressions: [], preexisting, baseline: 'compared' });
  }
  if (exit_code !== 0) return res('error', `exit_${exit_code}_without_test_failures`, known);
  if (c.passed === 0) return res('error', 'zero_tests', known);
  return res('passed', 'tests_passed', known);
}

/**
 * Split candidate failures into regressions and pre-existing (QB-10). Conservative:
 * a failure is pre-existing only if exactly one base failure has the same full
 * identity AND fails the same way; a missing or duplicated identity (on either
 * side) or a changed failure is a regression.
 */
function compareFailures(failures, baseList) {
  const count = (list) => { const m = new Map(); for (const t of list) { const id = testId(t); if (id) m.set(id, (m.get(id) || 0) + 1); } return m; };
  const cand = count(failures);
  const baseCount = count(baseList);
  const baseById = new Map(baseList.filter((t) => testId(t)).map((t) => [testId(t), t]));
  const regressions = [];
  const preexisting = [];
  for (const t of failures) {
    const id = testId(t);
    const b = id && cand.get(id) === 1 && baseCount.get(id) === 1 ? baseById.get(id) : null;
    if (b && sameFailure(t, b)) preexisting.push(t);
    else regressions.push(b ? { ...t, changed_failure: true } : t);
  }
  return { regressions, preexisting };
}

/**
 * The base run's failing tests (QB-10). Held to the same rigor as the candidate's
 * evidence: the base run must have finished normally (not timeout / OOM / infra /
 * cancelled), with a real exit code that agrees with a complete, consistent report,
 * no cancellation and no collection failure. Otherwise nothing is pre-existing.
 */
function baseFailures(b) {
  const no = (reason) => ({ ok: false, reason });
  if (!b) return no('baseline_not_run');
  if (b.error) return no('baseline_error');
  if (['timeout', 'oom', 'cancelled'].includes(b.state)) return no(`baseline_${b.state}`);
  if (b.state === 'infra_error') return no('baseline_infra');
  if (b.state !== 'completed' && b.state !== 'execution_error') return no(`baseline_state_${String(b.state).slice(0, 40)}`);
  if (!Number.isInteger(b.exit_code)) return no('baseline_no_exit_code');
  if (b.exit_code === 126 || b.exit_code === 127) return no('baseline_missing_executable');
  if (typeof b.report !== 'string') return no(`baseline_${b.report_error || 'no_report'}`);
  const r = validateNodeReport(b.report);
  if (!r.ok) return no(`baseline_${r.reason}`);
  if (r.collectionFailures.length || r.counts.cancelled > 0) return no('baseline_unreliable');
  // exit code and report must agree: failures ⇔ exit 1 (node --test), success ⇔ exit 0
  if (r.counts.failed > 0 && b.exit_code === 0) return no('baseline_inconsistent_exit');
  if (r.counts.failed > 0 && b.exit_code !== 1) return no(`baseline_exit_${b.exit_code}`);
  if (r.counts.failed === 0 && b.exit_code !== 0) return no(`baseline_exit_${b.exit_code}_without_test_failures`);
  if ((b.state === 'completed') !== (b.exit_code === 0)) return no('baseline_inconsistent_state');
  return { ok: true, failures: r.failingTests };
}

/** QB-10: validate an approved contract's test_policy. */
function testPolicyErrors(c) {
  const p = c?.test_policy;
  if (p === undefined) return [];
  if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => k !== 'preexisting_failures')
    || !['block', 'waive'].includes(p.preexisting_failures)) {
    return ['test_policy must be { "preexisting_failures": "block" | "waive" }'];
  }
  return [];
}

module.exports = { classifyTestRun, validateNodeReport, compareFailures, testPolicyErrors, FORMAT };
