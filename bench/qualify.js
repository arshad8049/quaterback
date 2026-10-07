/**
 * bench/qualify.js — qualify a hidden suite before it can be frozen (QB-27).
 *
 * The suite is graded, with the real grader, against
 *   - a known-correct reference implementation  → must be `pass`
 *   - at least two representative incorrect ones → each must be `fail` because tests
 *     failed (`tests_failed`) — failing for another reason (a patch that does not
 *     apply, a load error) does not show that the suite detects the wrong behaviour.
 * Any grader_error / infra_error, or any other outcome, leaves the suite unqualified.
 * The returned qualification binds the suite hash and the grader hash: if either changes
 * later, grading refuses (grader_error suite_changed / grader_changed) until re-qualified.
 */

const path = require('path');
const { grade, graderHash, SUITES_ROOT } = require('./grader');
const S = require('./schemas');

class SuiteNotQualified extends Error {
  constructor(problems) { super(`suite not qualified: ${problems.join('; ')}`); this.code = 'SUITE_NOT_QUALIFIED'; this.problems = problems; }
}

/**
 * @param {object} o  { spec, reference: patch, incorrect: [{ label, patch }], suitesRoot?, runSandboxed?, sandbox?, now? }
 * @returns {Promise<object>} the Qualification record for spec.qualification
 */
async function qualify(o) {
  const spec = S.TaskSpec.parse({ ...o.spec, qualification: null });
  const incorrect = Array.isArray(o.incorrect) ? o.incorrect : [];
  const problems = [];
  if (incorrect.length < 2) problems.push('at least two representative incorrect implementations are required');
  const g = (patch) => grade({ spec, patch, suitesRoot: o.suitesRoot, runSandboxed: o.runSandboxed, sandbox: o.sandbox, qualifying: true });

  const ref = await g(o.reference);
  if (ref.outcome !== 'pass') problems.push(`reference: expected pass, got ${ref.outcome} (${ref.reason}${ref.detail ? `: ${ref.detail}` : ''})`);
  const wrong = [];
  for (const w of incorrect) {
    const r = await g(w.patch);
    if (r.outcome !== 'fail' || r.reason !== 'tests_failed') problems.push(`${w.label}: expected fail (tests_failed), got ${r.outcome} (${r.reason})`);
    wrong.push({ label: w.label, patch_sha256: r.patch_sha256, outcome: 'fail' });
  }
  if (problems.length) throw new SuiteNotQualified(problems);
  return {
    grader_sha256: graderHash(),
    suite_sha256: S.treeHash(path.join(o.suitesRoot || SUITES_ROOT, spec.suite.dir)),
    reference: { patch_sha256: ref.patch_sha256, outcome: 'pass' },
    incorrect: wrong,
    qualified_at: (o.now || new Date()).toISOString(),
  };
}

module.exports = { qualify, SuiteNotQualified };
