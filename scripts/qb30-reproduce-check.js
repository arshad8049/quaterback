#!/usr/bin/env node
/**
 * scripts/qb30-reproduce-check.js — does a fresh machine reproduce a frozen dev set? (QB-30)
 *
 *   node scripts/qb30-reproduce-check.js [--set dev-r2|dev]
 *
 * Run after `node bench/repos.js build all` and `node bench/curate.js qualify all --set <set>` on
 * that machine. For every frozen spec in the set's lock, compares the fresh qualification draft
 * (<specs>/<ID>.draft.json) with the frozen spec: the repository base commit, the grader and
 * suite hashes, the reference patch and its outcome, and every incorrect implementation's patch
 * and outcome. Prints one line per task and a summary; exit 1 on any mismatch or missing draft.
 * Read-only.
 *
 * KAN-74: the default set is dev-r2, the revision frozen in KAN-71. v1 (`--set dev`) records the
 * earlier grader, so the current grader cannot reproduce it.
 */

const fs = require('fs');
const path = require('path');
const { curateDirs } = require('../bench/curate');

const SETS = ['dev-r2', 'dev'];

/** The specs folder and lock of a dev set. */
function setDirs(set = 'dev-r2') {
  if (!SETS.includes(set)) throw new Error(`unknown set ${JSON.stringify(set)} (${SETS.join(' | ')})`);
  const d = curateDirs(set);
  return { set, specs: d.specs, lockFile: d.lockFile };
}

function compare(frozen, draft) {
  const diffs = [];
  const eq = (label, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${label}: frozen ${JSON.stringify(a)} vs now ${JSON.stringify(b)}`); };
  const fq = frozen.qualification || {}; const dq = draft.qualification || {};
  eq('repo.base_rev', frozen.repo.base_rev, draft.repo && draft.repo.base_rev);
  eq('grader_sha256', fq.grader_sha256, dq.grader_sha256);
  eq('suite_sha256', fq.suite_sha256, dq.suite_sha256);
  const ref = (q) => q.reference ? { patch: q.reference.patch_sha256, outcome: q.reference.outcome } : null;
  eq('reference', ref(fq), ref(dq));
  const inc = (q) => (q.incorrect || []).map((i) => ({ label: i.label, patch: i.patch_sha256, outcome: i.outcome })).sort((a, b) => a.label.localeCompare(b.label));
  eq('incorrect', inc(fq), inc(dq));
  return diffs;
}

/** Compares every frozen spec in `lockFile` with its fresh draft in `specs`. */
function checkSet({ specs, lockFile }) {
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  let bad = 0; const lines = [];
  const ids = Object.keys(lock.specs).sort();
  for (const id of ids) {
    const frozen = JSON.parse(fs.readFileSync(path.join(specs, `${id}.json`), 'utf8'));
    const draftFile = path.join(specs, `${id}.draft.json`);
    if (!fs.existsSync(draftFile)) { bad++; lines.push(`${id}  MISSING  no fresh qualification draft (qualify failed?)`); continue; }
    const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));   // { schema, spec, oracle_draft, source }
    const d = compare(frozen, draft.spec || {});
    if (d.length) { bad++; lines.push(`${id}  MISMATCH  ${d.join('; ')}`); }
    else lines.push(`${id}  identical  base ${frozen.repo.base_rev.slice(0, 10)}; reference ${frozen.qualification.reference ? frozen.qualification.reference.outcome : 'none (already satisfied)'}; ${frozen.qualification.incorrect.length} incorrect → ${[...new Set(frozen.qualification.incorrect.map((i) => i.outcome))].join('/')}`);
  }
  return { lines, bad, total: ids.length };
}

module.exports = { compare, checkSet, setDirs };

if (require.main === module) {
  const args = process.argv.slice(2);
  const si = args.indexOf('--set');
  const dirs = setDirs(si >= 0 ? args[si + 1] : undefined);
  const { lines, bad, total } = checkSet(dirs);
  console.log(lines.join('\n'));
  console.log(`\n${total - bad}/${total} frozen ${dirs.set} tasks reproduced identically on this machine${bad ? `; ${bad} did not` : ''}.`);
  process.exit(bad ? 1 : 0);
}
