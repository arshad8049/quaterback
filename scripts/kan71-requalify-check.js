#!/usr/bin/env node
/**
 * scripts/kan71-requalify-check.js — is the dev-set re-qualification revision (KAN-71) only a
 * re-qualification?
 *
 * For every task in the v1 lock (bench/specs.lock.json), compares the v2 draft
 * (bench/dev-r2/specs/<ID>.draft.json) with the frozen v1 spec (bench/specs/<ID>.json). v2 may
 * differ only by:
 *   - the version (v1 + 1) and exactly one new changelog entry for it;
 *   - the grader hash, which must be the current grader's;
 *   - qualified_at;
 *   - the oracle's approval, which a person gives at freeze.
 * The base check must have run and passed (base_tests). Everything else (base revision,
 * prompt, oracle criteria, suite, reference and incorrect patches and outcomes) must be
 * identical.
 *
 * With --committed <dir>, each fresh draft must also equal the committed draft in <dir>, apart
 * from qualified_at: a fresh runner reproduced it.
 *
 * Prints one line per task and a summary; exit 1 on any difference or missing draft. Read-only.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/** JSON with sorted keys, so key order never counts as a difference. */
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const same = (a, b) => canon(a) === canon(b);
const without = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => !keys.includes(k)));

/**
 * @param {object} o  { frozen: v1 spec, draft: v2 qb-task-draft/1, committed?: draft, graderSha }
 * @returns {string[]} differences (empty: v2 is only a re-qualification)
 */
function checkTask({ frozen, draft, committed, graderSha }) {
  const diffs = [];
  const spec = (draft && draft.spec) || {};
  const fq = frozen.qualification || {}; const q = spec.qualification || {};
  if (!same(without(spec, ['version', 'changelog', 'oracle', 'qualification']), without(frozen, ['version', 'changelog', 'oracle', 'qualification']))) {
    diffs.push('spec: differs from v1 outside version/changelog/oracle/qualification');
  }
  if (spec.version !== frozen.version + 1) diffs.push(`version: expected ${frozen.version + 1}, got ${spec.version}`);
  const cl = spec.changelog || [];
  if (!same(cl.slice(0, (frozen.changelog || []).length), frozen.changelog || []) || cl.length !== (frozen.changelog || []).length + 1
    || cl[cl.length - 1].version !== spec.version) diffs.push('changelog: v1 entries plus exactly one disclosed entry for the new version are required');
  if (!same(draft.oracle_draft, without(frozen.oracle, ['approved_by']))) diffs.push('oracle: the drafted oracle differs from v1\'s approved criteria');
  if (!same(without(q, ['grader_sha256', 'qualified_at']), without(fq, ['grader_sha256', 'qualified_at']))) {
    diffs.push('qualification: base/suite/reference/incorrect results differ from v1');
  }
  if (q.grader_sha256 !== graderSha) diffs.push(`grader: expected the current grader ${String(graderSha).slice(0, 8)}, got ${String(q.grader_sha256).slice(0, 8)}`);
  if (!draft.base_tests || draft.base_tests.outcome !== 'passed') diffs.push(`base_tests: the base check did not run and pass (${JSON.stringify(draft.base_tests)})`);
  if (committed) {
    const strip = (d) => ({ ...d, spec: { ...d.spec, qualification: { ...(d.spec.qualification || {}), qualified_at: null } } });
    if (!same(strip(draft), strip(committed))) diffs.push('committed: the fresh draft differs from the committed draft (apart from qualified_at)');
  }
  return diffs;
}

module.exports = { checkTask };

if (require.main === module) {
  const { graderHash } = require(path.join(ROOT, 'bench', 'grader'));
  const ci = process.argv.indexOf('--committed');
  const committedDir = ci >= 0 ? process.argv[ci + 1] : null;
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'specs.lock.json'), 'utf8'));
  const graderSha = graderHash();
  const ids = Object.keys(lock.specs).sort();
  let bad = 0; const lines = [];
  for (const id of ids) {
    const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'specs', `${id}.json`), 'utf8'));
    const file = path.join(ROOT, 'bench', 'dev-r2', 'specs', `${id}.draft.json`);
    if (!fs.existsSync(file)) { bad++; lines.push(`${id}  MISSING  no v2 draft (qualify failed?)`); continue; }
    const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
    let committed = null;
    if (committedDir) {
      const cf = path.join(committedDir, `${id}.draft.json`);
      if (!fs.existsSync(cf)) { bad++; lines.push(`${id}  MISSING  no committed draft in ${committedDir}`); continue; }
      committed = JSON.parse(fs.readFileSync(cf, 'utf8'));
    }
    const d = checkTask({ frozen, draft, committed, graderSha });
    if (d.length) { bad++; lines.push(`${id}  DIFFERS  ${d.join('; ')}`); }
    else lines.push(`${id}  ok  v${frozen.version}→v${draft.spec.version}; grader ${frozen.qualification.grader_sha256.slice(0, 8)}→${graderSha.slice(0, 8)}; base tests passed${committed ? '; matches committed draft' : ''}`);
  }
  console.log(lines.join('\n'));
  console.log(`\n${ids.length - bad}/${ids.length} dev tasks: v2 is only a re-qualification of v1${committedDir ? ', reproduced exactly' : ''}${bad ? `; ${bad} not` : ''}.`);
  process.exit(bad ? 1 : 0);
}
