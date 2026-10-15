/**
 * bench/qualify.js — qualify a hidden suite before it can be frozen (QB-27).
 *
 * The suite is graded, with the real grader, against
 *   - a known-correct reference implementation  → must be `pass`
 *   - at least two representative incorrect ones → each must be `fail` because tests
 *     failed (`tests_failed`) — failing for another reason (a patch that does not
 *     apply, a load error) does not show that the suite detects the wrong behaviour.
 * Any grader_error / infra_error, or any other outcome, leaves the suite unqualified.
 * The unchanged base must also pass the repository's OWN tests (the command its .quarterback.json
 * declares, the one QB verifies with): a release that ships a failing test makes every QB verdict
 * on the task a pre-existing failure, whatever the hidden suite says (KAN-65, FY-08). This check
 * lives here, not in the grader, so existing qualifications stay bound to an unchanged grader.
 * The returned qualification binds the suite hash and the grader hash: if either changes
 * later, grading refuses (grader_error suite_changed / grader_changed) until re-qualified.
 */

const fs = require('fs');
const path = require('path');
const { grade, graderHash, checksFromReport, SUITES_ROOT } = require('./grader');
const { createWorkspace } = require('../lib/workspace');
const { classifyTestRun } = require('../verify/tests');
const { resolveSource } = require('./repos');
const S = require('./schemas');

class SuiteNotQualified extends Error {
  constructor(problems) { super(`suite not qualified: ${problems.join('; ')}`); this.code = 'SUITE_NOT_QUALIFIED'; this.problems = problems; }
}

/**
 * The repository's own tests on the unchanged base, in the same sandbox as grading.
 * @returns {Promise<string|null>} why the base does not pass them, or null
 */
async function baseProblem(spec, o) {
  const ws = createWorkspace(resolveSource(spec.repo.source), { baseRev: spec.repo.base_rev, label: `qualify-base-${spec.id}` });
  try {
    let command = null;
    try { command = JSON.parse(fs.readFileSync(path.join(ws.dir, '.quarterback.json'), 'utf8')).test.command; } catch { /* none declared */ }
    if (!Array.isArray(command) || !command.length) return null;   // no visible test command to hold the base to
    const run = o.runSandboxed || require('../lib/sandbox/pipeline').runSandboxed;
    const r = await run({ repoPath: ws.dir, briefing: '', noAgent: true, applyPatch: '', testCommand: command, baseTests: false, verify: true, ...(o.sandbox || {}) });
    const v = r && r.sandbox && r.sandbox.verification;
    if (!v) return `the repository's own tests did not run on the unchanged base (${(r && (r.status || r.reason)) || 'no verification'})`;
    const cls = classifyTestRun(v);
    if (cls.outcome === 'passed') return null;
    const failed = checksFromReport(v.report).filter((c) => c.status === 'failed').map((c) => c.name);
    return `the repository's own tests must pass on the unchanged base, got ${cls.outcome}${cls.reason ? ` (${cls.reason})` : ''}`
      + (failed.length ? `: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? `; … ${failed.length - 5} more` : ''}` : '');
  } finally { ws.cleanup(); }
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
  const base = await baseProblem(spec, o);
  if (base) problems.push(`base: ${base}`);
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
