/**
 * verdict.js — pure verdict aggregation for Layer 4.
 *
 * Kept free of I/O so a stored run can be replayed: feeding the recorded
 * evidence back through aggregate() must reproduce the recorded verdict.
 *
 * Execution state is decided first (QB-22): a crashed, timed-out or
 * cancelled agent is an `error`, never a dry run; an agent that changed
 * nothing is `unresolved` until an independent check shows the requirement
 * was already satisfied (Phase 2).
 *
 * @param {object} evidence
 * @param {boolean} evidence.hasDiff
 * @param {Array}   evidence.criteriaResults - [{ id, met }]
 * @param {object|null} evidence.testResults - { passed, failed, skipped } or null
 * @param {string}  [evidence.executionStatus] - ExecutionResult.status
 * @param {boolean} [evidence.unsupportedChanges] - capture could not represent part of the change
 * @param {object}  [evidence.verification] - sandbox verification { status, reason, state } (QB-02),
 *                    plus { outcome, outcome_reason } from verify/tests.js under rules 2
 * @param {number}  [evidence.rules] - 2 since QB-06, 3 since QB-13 (oracle approval), 4 since QB-09,
 *                    5 since QB-10 (classified tests), 6 since QB-11 (missing material evidence → unresolved)
 *                    (policy), 5 since QB-10 (classified outcome replaces the raw failed count); absent =
 *                    the earlier rules, so stored runs replay exactly as they were decided
 * @param {boolean} [evidence.oracleApproved] - rules 3: the contract was approved by a human, unchanged
 * @returns {{ verdict: string, failures: string[] }}
 */
const FAILED_EXECUTION = new Set(['execution_error', 'timeout', 'cancelled', 'failed', 'oom', 'infra_error', 'setup_failed']);
const NEVER_APPROVED   = new Set(['blocked', 'unresolved']);
const { classifyTestRun } = require('./tests');
// QB-10: only failures that also happen on the base tree remain → not caused by this change (still reported).
const TESTS_OK = new Set(['passed', 'preexisting_failures']);

function aggregate(input) {
  const r = aggregateCore(input);
  const rules = input.rules || 1;
  // Rules 6 (QB-11): a criterion left unknown because material evidence was missing
  // (named in evidence_missing) is not a partial result — the task is unresolved.
  if (rules >= 6 && r.verdict === 'partial' && input.criteriaResults.some(c => c.met === null && c.missing_evidence)) return applyPolicyAndOracle(input, rules, { ...r, verdict: 'unresolved' });
  return applyPolicyAndOracle(input, rules, r);
}

function applyPolicyAndOracle(input, rules, r) {
  // Rules 4 (QB-09): policy. A protected change or a violated constraint fails the task
  // (unless the run already failed to execute); an unauthorized change or an
  // unenforced constraint can never be a PASS.
  if (rules >= 4 && input.policyEffect === 'fail' && ['pass', 'partial', 'unresolved', 'fail'].includes(r.verdict)) return { ...r, verdict: 'fail' };
  if (rules >= 4 && input.policyEffect === 'unresolved' && r.verdict === 'pass') return { ...r, verdict: 'unresolved' };
  // Rules 3 (QB-13): a PASS needs a human-approved, unchanged test oracle (the contract).
  if (rules >= 3 && input.oracleApproved !== true && r.verdict === 'pass') return { ...r, verdict: 'unresolved' };
  return r;
}

function aggregateCore({ hasDiff, criteriaResults, testResults, executionStatus = null, unsupportedChanges = false, verification = null, rules = 1 }) {
  const failures = criteriaResults.filter(r => r.met === false).map(r => r.id);
  const unknowns = criteriaResults.filter(r => r.met === null);

  if (FAILED_EXECUTION.has(executionStatus)) return { verdict: 'error', failures };
  if (NEVER_APPROVED.has(executionStatus)) return { verdict: 'unresolved', failures };
  if (executionStatus === 'dry_run' || executionStatus === 'dry-run') return { verdict: 'no-diff', failures };
  // QB-22 (rules 2): no change passes only when the requirement is independently
  // verified — every criterion met in the current files AND the sandbox tests
  // passed on the unchanged tree. An unmet criterion or failing tests: fail.
  if (executionStatus === 'no_change' && rules >= 2) {
    const outcome = verification ? verification.outcome : 'not_run';
    if (failures.length || outcome === 'failed') return { verdict: 'fail', failures };
    const allMet = criteriaResults.length > 0 && criteriaResults.every(r => r.met === true);
    return { verdict: allMet && TESTS_OK.has(outcome) ? 'pass' : 'unresolved', failures };
  }
  if (executionStatus === 'no_change') return { verdict: 'unresolved', failures };

  // Nothing to verify against can never be approved (QB-08).
  if (!criteriaResults.length) return { verdict: 'unresolved', failures };

  let verdict;
  if (!hasDiff)                    verdict = 'no-diff';
  else if (failures.length > 0)    verdict = 'fail';
  else if (unknowns.length > 0)    verdict = 'partial';
  else                             verdict = 'pass';

  // If tests failed, force verdict to fail
  // Before rules 5 any failed count forced FAIL; since QB-10 the classified outcome decides
  // (failures that also happen on the base tree are pre-existing, not this change's).
  if (rules < 5 && testResults && testResults.failed > 0 && verdict === 'pass') {
    verdict = 'fail';
  }

  // A change that could not be fully captured cannot be approved (QB-03).
  if (unsupportedChanges && verdict === 'pass') verdict = 'unresolved';

  // Rules 2 (QB-06): only classified, passing test evidence can approve. A real
  // failing test fails the task; a broken run (error) or no run cannot approve it.
  if (rules >= 2) {
    const outcome = verification ? verification.outcome : 'not_run';
    // A definite test regression fails the task even when criteria are unknown (partial).
    if (verdict === 'pass' || verdict === 'partial') {
      if (outcome === 'failed') verdict = 'fail';
      else if (!TESTS_OK.has(outcome) && verdict === 'pass') verdict = 'unresolved';
    }
    return { verdict, failures };
  }

  // Rules 1 — sandbox verification (QB-02): the tests ran on the disposable copy with the
  // base versions of protected tests. A failing run fails the task; a run that
  // could not happen (dependency change, OOM, timeout, infra) cannot approve it.
  if (verification && (verdict === 'pass' || verdict === 'partial')) {
    if (verification.status === 'ran' && verification.state === 'execution_error') verdict = 'fail';
    else if (verification.status === 'ran' && verification.state !== 'completed') verdict = 'unresolved';
    else if (verification.status === 'not_run' && verification.reason !== 'no_test_command') verdict = 'unresolved';
  }

  return { verdict, failures };
}

/** The aggregate() verification input for an execution (rules 2: with the classified outcome). */
function verificationInput(execution, testOpts = {}) {
  const v = execution?.sandbox?.verification || null;
  const c = classifyTestRun(v, testOpts);
  return {
    status: v ? v.status : 'not_run', reason: v ? v.reason ?? null : 'no_test_evidence', state: v ? v.state ?? null : null,
    exit_code: c.exit_code, outcome: c.outcome, outcome_reason: c.reason,
  };
}

/** The aggregate() input that produced a stored report, for the run record. */
function inputFromReport(report, execution) {
  return {
    rules:           6,
    oracleApproved:  report.oracle ? report.oracle.approved === true : false,
    policyEffect:    report.policy ? report.policy.effect : 'ok',
    hasDiff:         Boolean(execution?.diff),
    criteriaResults: report.criteria_results.map(r => ({ id: r.id, met: r.met, ...(r.evidence_missing?.length ? { missing_evidence: true } : {}) })),
    testResults:     report.test_results
      ? { passed: report.test_results.passed, failed: report.test_results.failed, skipped: report.test_results.skipped }
      : null,
    executionStatus:    execution?.status ?? null,
    unsupportedChanges: Boolean(execution?.unsupported_changes?.length),
    verification:       verificationInput(execution, { preexisting: report.test_outcome?.preexisting_policy === 'waive' ? 'waive' : 'block' }),
  };
}

module.exports = { aggregate, inputFromReport, verificationInput, FAILED_EXECUTION };
