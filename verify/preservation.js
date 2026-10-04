/**
 * verify/preservation.js — preservation claims are bounded to named tests (QB-15).
 *
 * "Existing tests remain unchanged", "no regressions", "backward compatible": a
 * claim that something is NOT broken cannot be read from a diff. It used to be set
 * to null by the judge — avoiding a false repair, but never verifying anything.
 *
 * Now a preservation criterion must name what it preserves:
 *   preserves: { tests: ["test/parser.test.js", …] }   repository-relative test files
 * (interfaces are preserved with executable checks bound to the criterion, QB-16).
 * It is decided by the sandbox's classified test report, never by the judge:
 *   met     every named file ran, with ≥ 1 passing test and no failing test,
 *           and the criterion's checks (if any) passed
 *   false   a named test failed, or a named file did not run at all
 *   null    the test run is unusable (timeout, OOM, no report, …): unresolved —
 *           null is never proof of preservation
 * An unbound preservation criterion makes the contract invalid (contractState).
 */

const PRESERVATION_PATTERNS = [
  /existing\s+\w*\s*(functionality|behavior|behaviour|code|tests?)\s+(remains?\s+)?unchanged/i,
  /remains?\s+unchanged/i,
  /no\s+other\s+parts?\s+(of\s+the\s+code\s+)?(are\s+)?affected/i,
  /without\s+(affecting|breaking|changing|modifying)\s+(existing|other|the\s+rest)/i,
  /existing\s+(code|behavior|behaviour|tests?|interface)\s+(is\s+)?(not\s+)?(modified|changed|broken|affected)/i,
  /no\s+regressions?/i,
  /backward[\s-]?compat/i,
  /existing\s+\w*\s*tests?\s+(still\s+|continue\s+to\s+)?pass/i,
];

const isPreservationCriterion = (criterion) => PRESERVATION_PATTERNS.some((p) => p.test(String(criterion || '')));
const plainPath = (p) => typeof p === 'string' && p.length > 0 && p.length <= 300 && !p.startsWith('/')
  && !/[\u0000-\u001f\u007f]/.test(p) && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

/** Structural errors for every criterion's preservation binding. */
function preservationErrors(c) {
  const errors = [];
  for (const ac of c?.acceptance_criteria || []) {
    const p = ac?.preserves;
    if (p === undefined) {
      if (isPreservationCriterion(ac?.criterion)) errors.push(`${ac.id} is a preservation criterion: name the tests it preserves (preserves.tests)`);
      continue;
    }
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some((k) => k !== 'tests')
      || !Array.isArray(p.tests) || !p.tests.length || p.tests.length > 32 || !p.tests.every(plainPath)) {
      errors.push(`${ac.id} preserves must be { "tests": [<repository-relative test files>] } (1–32 plain paths)`);
    }
  }
  return errors;
}

/**
 * Decide a preservation criterion from the classified test run (verify/tests.js).
 * @param {object} ac        - with preserves.tests
 * @param {object} classified - classifyTestRun() result (with byFile)
 */
function decidePreservation(ac, classified) {
  const base = { id: ac.id, criterion: ac.criterion, method: 'test-runner' };
  const usable = classified && ['passed', 'failed', 'preexisting_failures'].includes(classified.outcome) && classified.byFile;
  if (!usable) {
    return { ...base, met: null, evidence: `The test run cannot show that ${ac.preserves.tests.join(', ')} still pass (${classified ? classified.reason : 'no test run'}); not verified.` };
  }
  const lines = [];
  let broken = false;
  for (const f of ac.preserves.tests) {
    const s = classified.byFile[f];
    if (!s || s.passed + s.failed === 0) { lines.push(`${f} did not run`); broken = true; continue; }
    lines.push(`${f}: ${s.passed} passed, ${s.failed} failed`);
    if (s.failed > 0 || s.passed === 0) broken = true;
  }
  return broken
    ? { ...base, met: false, evidence: lines.join('; '), repair: `Keep these tests passing without editing them: ${ac.preserves.tests.join(', ')}` }
    : { ...base, met: true, evidence: lines.join('; ') };
}

module.exports = { isPreservationCriterion, preservationErrors, decidePreservation, PRESERVATION_PATTERNS };
