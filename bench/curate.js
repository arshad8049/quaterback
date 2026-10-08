/**
 * bench/curate.js — curate a benchmark task into a frozen qb-task-spec/1 (QB-30).
 *
 * A task is authored as files, never as a hand-edited spec:
 *   bench/curation/<ID>/task.json                 id, split, stratum, repo (qb-bench:<name> or a path),
 *                                                  base_rev, prompt, requirement, oracle draft,
 *                                                  suite.command, adjudication_rules, provenance
 *   bench/curation/<ID>/reference/<files>          the changed files of a known-correct implementation
 *                                                  (absent only for already_satisfied: the correct change is none)
 *   bench/curation/<ID>/incorrect/<label>/<files>  ≥2 representative wrong implementations
 *   bench/suites/<ID>/<files>                      the hidden suite (installed at test/hidden)
 *
 *   qualify  patches are generated against the pinned base; the suite is qualified with the real
 *            grader (bench/qualify.js). Writes bench/specs/<ID>.draft.json: the spec with oracle
 *            null, plus the oracle draft. Nothing is approved or frozen here.
 *   freeze   a named PERSON approves the oracle (QB-13): spec.oracle = draft + approved_by; the
 *            spec is frozen in bench/specs.lock.json (bench/spec.js) and written to bench/specs/<ID>.json.
 *            The reviewer reads the curation files, so freeze approves only a draft whose source
 *            fingerprint (task.json, reference and incorrect trees) and grader still match the current
 *            files; anything edited after qualification needs a re-qualify first.
 *
 * CLI:
 *   node bench/curate.js qualify <ID|all>
 *   node bench/curate.js freeze <ID|all> --approver "<name>"
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../lib/proc');
const S = require('./schemas');
const { qualify } = require('./qualify');
const { freeze } = require('./spec');
const { resolveSource } = require('./repos');
const { graderHash } = require('./grader');

const DEFAULTS = {
  curation: path.join(__dirname, 'curation'),
  suites: path.join(__dirname, 'suites'),
  specs: path.join(__dirname, 'specs'),
  lockFile: path.join(__dirname, 'specs.lock.json'),
};
const INSTALL_TO = 'test/hidden';
const NOT_A_PERSON = /^(qb|quarterback|claude|ai|bot|auto(mated)?|system|model|agent|llm)\b/i;

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };
function git(cwd, args, input) {
  const r = proc.run('git', args, { cwd, input, env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

function listFiles(root) {
  const out = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push(path.relative(root, abs).split(path.sep).join('/'));
      else throw new Error(`${abs}: only regular files are allowed in a curation tree`);
    }
  })(root);
  return out.sort();
}

/** A unified git diff that turns the base into base + the files under `tree` (a path → contents overlay). */
function patchFromTree(repoDir, baseRev, tree) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-curate-'));
  try {
    git(os.tmpdir(), ['clone', '--quiet', '--no-hardlinks', '--no-checkout', repoDir, tmp]);
    git(tmp, ['checkout', '--quiet', '--detach', baseRev]);
    for (const rel of listFiles(tree)) {
      fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
      fs.copyFileSync(path.join(tree, rel), path.join(tmp, rel));
    }
    git(tmp, ['add', '-A']);
    const diff = git(tmp, ['diff', '--cached', '--binary', 'HEAD']);
    if (!diff.trim()) throw new Error(`${tree}: identical to the base — not an implementation`);
    return diff;
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/** The spec (oracle null, no qualification) and oracle draft described by task.json. */
function specOf(id, o) {
  const t = JSON.parse(fs.readFileSync(path.join(o.curation, id, 'task.json'), 'utf8'));
  if (t.id !== id) throw new Error(`${id}: task.json id is ${t.id}`);
  const repoDir = resolveSource(t.repo);
  const lockfiles = {};
  for (const rel of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const r = proc.run('git', ['show', `${t.base_rev}:${rel}`], { cwd: repoDir, encoding: 'buffer', env: GIT_ENV });
    if (r.status === 0) lockfiles[rel] = S.sha256(r.stdout);
  }
  const suiteDir = path.join(o.suites, id);
  const spec = S.TaskSpec.parse({
    schema: 'qb-task-spec/1', id, version: t.version || 1, split: t.split, stratum: t.stratum,
    repo: { source: t.repo, base_rev: t.base_rev, lockfiles },
    prompt: t.prompt, requirement: t.requirement, oracle: null,
    suite: { dir: id, files: S.fileHashes(suiteDir), command: t.suite.command, install_to: INSTALL_TO,
      owned_paths: [`${INSTALL_TO}/**`, ...(t.suite.owned_paths || [])], adjudicate_checks: t.suite.adjudicate_checks || [] },
    qualification: null, adjudication_rules: t.adjudication_rules, provenance: t.provenance, changelog: t.changelog || [],
  });
  return { spec, oracleDraft: t.oracle || null, repoDir };
}

/** Fingerprint of what a reviewer reads: the whole curation tree (task.json, reference, incorrect). */
const sourceOf = (id, o) => ({ curation_sha256: S.treeHash(path.join(o.curation, id)) });

/** Qualify one task; writes <specs>/<ID>.draft.json. Throws SuiteNotQualified when the suite is too weak. */
async function qualifyTask(id, o = {}) {
  o = { ...DEFAULTS, ...o };
  const { spec, oracleDraft, repoDir } = specOf(id, o);
  if (!oracleDraft || !Array.isArray(oracleDraft.acceptance_criteria) || !oracleDraft.acceptance_criteria.length) throw new Error(`${id}: task.json needs an oracle draft with acceptance_criteria`);
  const dir = path.join(o.curation, id);
  // already_satisfied: the request is already met, so the correct change is none — no reference tree.
  const refTree = path.join(dir, 'reference');
  let reference;
  if (fs.existsSync(refTree)) reference = patchFromTree(repoDir, spec.repo.base_rev, refTree);
  else if (spec.stratum.type === 'already_satisfied') reference = '';
  else throw new Error(`${id}: no reference implementation (only already_satisfied tasks may omit it)`);
  const wrongRoot = path.join(dir, 'incorrect');
  const incorrect = (fs.existsSync(wrongRoot) ? fs.readdirSync(wrongRoot).sort() : [])
    .map((label) => ({ label, patch: patchFromTree(repoDir, spec.repo.base_rev, path.join(wrongRoot, label)) }));
  const qualification = await qualify({ spec, reference, incorrect, suitesRoot: o.suites, runSandboxed: o.runSandboxed, sandbox: o.sandbox, now: o.now });
  const draft = { schema: 'qb-task-draft/1', spec: S.TaskSpec.parse({ ...spec, qualification }), oracle_draft: oracleDraft, source: sourceOf(id, o) };
  fs.mkdirSync(o.specs, { recursive: true });
  fs.writeFileSync(path.join(o.specs, `${id}.draft.json`), JSON.stringify(draft, null, 2) + '\n');
  return draft;
}

/** A named person approves the drafted oracle; the spec is frozen. Returns the frozen spec. */
function freezeTask(id, o = {}) {
  o = { ...DEFAULTS, ...o };
  const approver = String(o.approver || '').trim();
  if (!approver) throw new Error('freeze needs --approver "<name>": the oracle is approved by a person (QB-13)');
  if (NOT_A_PERSON.test(approver)) throw new Error(`"${approver}" is not a person: an oracle is approved by a named human reviewer`);
  const draft = JSON.parse(fs.readFileSync(path.join(o.specs, `${id}.draft.json`), 'utf8'));
  if (!draft.source) throw new Error(`${id}: the draft has no source fingerprint; re-qualify`);
  if (draft.source.curation_sha256 !== sourceOf(id, o).curation_sha256) throw new Error(`${id}: task.json, reference or incorrect trees changed since qualification; re-qualify before approving`);
  if (draft.spec.qualification.grader_sha256 !== graderHash()) throw new Error(`${id}: the grader changed since qualification; re-qualify before approving`);
  const spec = S.TaskSpec.parse({ ...draft.spec, oracle: { ...draft.oracle_draft, approved_by: approver } });
  freeze(spec, { lockFile: o.lockFile, suitesRoot: o.suites, now: o.now });
  fs.writeFileSync(path.join(o.specs, `${id}.json`), JSON.stringify(spec, null, 2) + '\n');
  return spec;
}

module.exports = { qualifyTask, freezeTask, patchFromTree, specOf, DEFAULTS };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const [cmd, which] = args;
    const ai = args.indexOf('--approver');
    const ids = which === 'all' ? fs.readdirSync(DEFAULTS.curation).filter((d) => fs.existsSync(path.join(DEFAULTS.curation, d, 'task.json'))).sort() : [which];
    if (!which || !['qualify', 'freeze'].includes(cmd)) { console.error('usage: node bench/curate.js qualify|freeze <ID|all> [--approver "<name>"]'); process.exit(2); }
    let failed = 0;
    for (const id of ids) {
      try {
        if (cmd === 'qualify') { await qualifyTask(id); console.log(`${id}\tqualified`); }
        else { freezeTask(id, { approver: ai >= 0 ? args[ai + 1] : '' }); console.log(`${id}\tfrozen`); }
      } catch (e) { failed++; console.log(`${id}\tFAILED\t${e.message.replace(/\s+/g, ' ').slice(0, 600)}`); }
    }
    process.exit(failed ? 1 : 0);
  })();
}
