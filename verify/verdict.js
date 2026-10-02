/**
 * verdict.js — pure verdict aggregation for Layer 4.
 *
 * Kept free of I/O so a stored run can be replayed: feeding the recorded
 * evidence back through aggregate() must reproduce the recorded verdict.
 *
 * @param {object} evidence
 * @param {boolean} evidence.hasDiff
 * @param {Array}   evidence.criteriaResults - [{ id, met }]
 * @param {object|null} evidence.testResults - { passed, failed, skipped } or null
 * @returns {{ verdict: string, failures: string[] }}
 */
function aggregate({ hasDiff, criteriaResults, testResults }) {
  const failures = criteriaResults.filter(r => r.met === false).map(r => r.id);
  const unknowns = criteriaResults.filter(r => r.met === null);

  let verdict;
  if (!hasDiff)                    verdict = 'no-diff';
  else if (failures.length > 0)    verdict = 'fail';
  else if (unknowns.length > 0)    verdict = 'partial';
  else                             verdict = 'pass';

  // If tests failed, force verdict to fail
  if (testResults && testResults.failed > 0 && verdict === 'pass') {
    verdict = 'fail';
  }

  return { verdict, failures };
}

/** The aggregate() input that produced a stored report, for the run record. */
function inputFromReport(report, hasDiff) {
  return {
    hasDiff:         Boolean(hasDiff),
    criteriaResults: report.criteria_results.map(r => ({ id: r.id, met: r.met })),
    testResults:     report.test_results
      ? { passed: report.test_results.passed, failed: report.test_results.failed, skipped: report.test_results.skipped }
      : null,
  };
}

module.exports = { aggregate, inputFromReport };
