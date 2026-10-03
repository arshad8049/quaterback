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
 * @param {object}  [evidence.verification] - sandbox verification { status, reason, state } (QB-02)
 * @returns {{ verdict: string, failures: string[] }}
 */
const FAILED_EXECUTION = new Set(['execution_error', 'timeout', 'cancelled', 'failed', 'oom', 'infra_error', 'setup_failed']);
const NEVER_APPROVED   = new Set(['blocked', 'unresolved']);

function aggregate({ hasDiff, criteriaResults, testResults, executionStatus = null, unsupportedChanges = false, verification = null }) {
  const failures = criteriaResults.filter(r => r.met === false).map(r => r.id);
  const unknowns = criteriaResults.filter(r => r.met === null);

  if (FAILED_EXECUTION.has(executionStatus)) return { verdict: 'error', failures };
  if (NEVER_APPROVED.has(executionStatus)) return { verdict: 'unresolved', failures };
  if (executionStatus === 'dry_run' || executionStatus === 'dry-run') return { verdict: 'no-diff', failures };
  if (executionStatus === 'no_change') return { verdict: 'unresolved', failures };

  // Nothing to verify against can never be approved (QB-08).
  if (!criteriaResults.length) return { verdict: 'unresolved', failures };

  let verdict;
  if (!hasDiff)                    verdict = 'no-diff';
  else if (failures.length > 0)    verdict = 'fail';
  else if (unknowns.length > 0)    verdict = 'partial';
  else                             verdict = 'pass';

  // If tests failed, force verdict to fail
  if (testResults && testResults.failed > 0 && verdict === 'pass') {
    verdict = 'fail';
  }

  // A change that could not be fully captured cannot be approved (QB-03).
  if (unsupportedChanges && verdict === 'pass') verdict = 'unresolved';

  // Sandbox verification (QB-02): the tests ran on the disposable copy with the
  // base versions of protected tests. A failing run fails the task; a run that
  // could not happen (dependency change, OOM, timeout, infra) cannot approve it.
  if (verification && (verdict === 'pass' || verdict === 'partial')) {
    if (verification.status === 'ran' && verification.state === 'execution_error') verdict = 'fail';
    else if (verification.status === 'ran' && verification.state !== 'completed') verdict = 'unresolved';
    else if (verification.status === 'not_run' && verification.reason !== 'no_test_command') verdict = 'unresolved';
  }

  return { verdict, failures };
}

/** The aggregate() input that produced a stored report, for the run record. */
function inputFromReport(report, execution) {
  return {
    hasDiff:         Boolean(execution?.diff),
    criteriaResults: report.criteria_results.map(r => ({ id: r.id, met: r.met })),
    testResults:     report.test_results
      ? { passed: report.test_results.passed, failed: report.test_results.failed, skipped: report.test_results.skipped }
      : null,
    executionStatus:    execution?.status ?? null,
    unsupportedChanges: Boolean(execution?.unsupported_changes?.length),
    verification:       execution?.sandbox?.verification
      ? { status: execution.sandbox.verification.status, reason: execution.sandbox.verification.reason ?? null,
          state: execution.sandbox.verification.state ?? null }
      : null,
  };
}

module.exports = { aggregate, inputFromReport, FAILED_EXECUTION };
