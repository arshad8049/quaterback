/**
 * bench/grader.js — the external grader (QB-27).
 *
 * Grades ONE patch against ONE frozen task spec (qb-task-spec/1), the same way for
 * every arm. It never receives a QB contract, acceptance criteria, an internal verdict
 * or arm metadata: its only inputs are the spec, the hidden suite and the patch.
 *
 *   1. integrity   the spec validates; the hidden suite's files and the grader's own code
 *                  hash to what the spec's qualification recorded (else grader_error)
 *   2. boundary    the suite lives outside the task repository and is not in its object
 *                  database (history) — else grader_error suite_leaked
 *   3. ownership   a patch that touches a grader-owned path OR ANY ANCESTOR of one (the suite's
 *                  install directory, .quarterback.json, the spec's owned_paths; compared
 *                  case-insensitively) → fail, before anything is created or run
 *   4. checkout    fresh checkout of the pinned base commit (no untrusted content yet);
 *                  lockfiles must hash as the spec says
 *   5. install     the hidden suite is written into that trusted checkout with no-follow,
 *                  beneath-root writes: every ancestor must be a real directory (a symlink in
 *                  the BASE tree fails closed: grader_error unsafe_install_path), files are
 *                  created O_EXCL|O_NOFOLLOW. Then it is committed as the graded base.
 *   6. apply + run the untrusted patch is applied INSIDE the hardened sandbox (a trusted stage,
 *                  --network none, no credentials; exit 42 = does not apply) — the host never
 *                  writes it. Capture, then the suite command runs with --network none; the
 *                  captured change list is checked again for owned paths and ancestors.
 *   7. classify    via verify/tests.js on the QB node:test report (QB-06)
 *
 * Outcomes (qb-grade/1). Only pass / fail are scores:
 *   pass                 every non-adjudicated check passed
 *   fail                 tests failed; the patch does not apply; it touches a grader-owned
 *                        path; it breaks loading/startup (syntax error, collection failure,
 *                        no/garbled report, zero tests, exit without failures); it times out
 *                        or exceeds memory; it needs a dependency change the lockfile lacks
 *   needs_adjudication   only checks the frozen spec lists in suite.adjudicate_checks remain
 *   grader_error         the grader or suite is at fault (unqualified/changed suite, grader
 *                        changed since qualification, leaked suite, wrong base, missing
 *                        executable for the suite command)
 *   infra_error          Docker/sandbox unavailable, supervisor loss, cancellation
 *
 * Attributing load failures to the patch is sound only because the suite was QUALIFIED
 * (bench/qualify.js) with this exact grader: it loaded and passed on a known-correct
 * implementation and failed on known-incorrect ones.
 */

const fs = require('fs');
const path = require('path');
const proc = require('../lib/proc');
const { createWorkspace } = require('../lib/workspace');
const { classifyTestRun } = require('../verify/tests');
const { globToRegExp, parseDiffHeader, supportedPath } = require('../verify/policy');
const { AGENT_IMAGE } = require('../lib/sandbox/agent');
const S = require('./schemas');
const { resolveSource } = require('./repos');

const SUITES_ROOT = path.join(__dirname, 'suites');
/** The grader's own code: a change here invalidates every qualification. */
const GRADER_FILES = ['bench/grader.js', 'bench/schemas.js', 'verify/tests.js', 'sandbox/agent/qb-test-reporter.mjs'];
const QB_ROOT = path.join(__dirname, '..');

/** sha256 over the grader's own files (path → hash), so qualification is bound to this code. */
function graderHash() {
  return S.hashOf(Object.fromEntries(GRADER_FILES.map((f) => [f, S.sha256File(path.join(QB_ROOT, f))])));
}

/** Paths a patch may never touch: the suite's install dir, the grader's test plan, spec owned_paths. */
const ownedGlobs = (spec) => [`${spec.suite.install_to}/**`, '.quarterback.json', ...spec.suite.owned_paths];
/** The literal directory/file prefixes of the owned globs (before any glob character). */
const ownedRoots = (spec) => ownedGlobs(spec).map((g) => g.split('/').filter(Boolean))
  .map((segs) => { const i = segs.findIndex((x) => /[*?[\]{}]/.test(x)); return (i < 0 ? segs : segs.slice(0, i)).join('/'); })
  .filter(Boolean);

/**
 * Owned paths a change list touches: a path matching an owned glob, OR an ANCESTOR of an
 * owned root (replacing `test` with a symlink redirects `test/hidden`). Case-insensitive,
 * because a host filesystem may be (macOS, Windows).
 */
function ownedTouched(spec, files) {
  const globs = ownedGlobs(spec).map((g) => globToRegExp(g.toLowerCase()));
  const roots = ownedRoots(spec).map((r) => r.toLowerCase());
  return files.filter((f) => {
    const l = f.toLowerCase();
    return globs.some((re) => re.test(l)) || roots.some((r) => r === l || r.startsWith(`${l}/`));
  });
}

/**
 * Write the hidden suite beneath `root` without following any link: every ancestor of every
 * target must be absent (then created, non-recursively) or a real directory; files are created
 * O_EXCL|O_NOFOLLOW; the final real path must stay beneath the root. Throws UNSAFE_INSTALL_PATH.
 */
function safeInstall(root, installTo, suiteDir, files) {
  const realRoot = fs.realpathSync(root);
  const unsafe = (why) => Object.assign(new Error(why), { code: 'UNSAFE_INSTALL_PATH' });
  const ensureDir = (rel) => {
    let cur = realRoot;
    for (const seg of rel.split('/').filter(Boolean)) {
      cur = path.join(cur, seg);
      let st = null;
      try { st = fs.lstatSync(cur); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (st && st.isSymbolicLink()) throw unsafe(`${path.relative(realRoot, cur)} is a symbolic link`);
      if (st && !st.isDirectory()) throw unsafe(`${path.relative(realRoot, cur)} is not a directory`);
      if (!st) fs.mkdirSync(cur);                       // non-recursive: one level, no link following
      const again = fs.lstatSync(cur);
      if (again.isSymbolicLink() || !again.isDirectory()) throw unsafe(`${path.relative(realRoot, cur)} changed type`);
    }
    const real = fs.realpathSync(cur);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw unsafe(`${rel} resolves outside the checkout`);
    return cur;
  };
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
  for (const rel of Object.keys(files)) {
    const target = path.posix.join(installTo, rel);
    const dir = ensureDir(path.posix.dirname(target));
    const fd = fs.openSync(path.join(dir, path.posix.basename(target)), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
    try { fs.writeSync(fd, fs.readFileSync(path.join(suiteDir, rel))); } finally { fs.closeSync(fd); }
  }
}

/** Every path a unified git diff touches (both sides of renames), or null if a header is unparseable. */
function patchPaths(patch) {
  const files = new Set();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const sides = parseDiffHeader(line);
    if (!sides) return null;
    for (const f of sides) files.add(f);
  }
  return [...files].sort();
}

/** Git blob id of a file's content (what `git hash-object` prints). */
function gitBlobId(buf) {
  return require('crypto').createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/**
 * The hidden suite must not be reachable from the task repository: not inside it, and
 * none of its files present in its object database (any branch, any history, any stash).
 * @returns {string|null} why the suite is not hidden
 */
function suiteLeak(spec, suiteDir) {
  const repo = fs.realpathSync(resolveSource(spec.repo.source));
  const suite = fs.realpathSync(suiteDir);
  if (suite === repo || suite.startsWith(repo + path.sep)) return `suite directory is inside the task repository (${spec.repo.source})`;
  for (const rel of Object.keys(spec.suite.files)) {
    const id = gitBlobId(fs.readFileSync(path.join(suiteDir, rel)));
    const r = proc.run('git', ['cat-file', '-e', id], { cwd: repo });
    if (r.status === 0) return `suite file ${rel} is present in the task repository's object database (blob ${id})`;
  }
  return null;
}

/** Per-check results from the QB node:test report: one entry per test (kind=test), by suite path + name. */
function checksFromReport(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!e || (e.type !== 'test:pass' && e.type !== 'test:fail') || e.kind !== 'test') continue;
    const name = [...(Array.isArray(e.path) ? e.path : []), e.name].join(' > ');
    out.push({ name, status: e.type === 'test:fail' ? 'failed' : e.skip ? 'skipped' : 'passed' });
  }
  return out;
}

/** Map the test-run classification to a grade, given a qualified suite. */
function fromTestRun(cls, checks, adjudicate) {
  const why = { tests_passed: 'tests_passed' };
  if (cls.outcome === 'passed') {
    const pending = checks.filter((c) => adjudicate.includes(c.name));
    if (pending.length) return { outcome: 'needs_adjudication', reason: 'adjudication_required' };
    return { outcome: 'pass', reason: why.tests_passed };
  }
  if (cls.outcome === 'failed') {
    // Failures only in checks the spec reserves for people → adjudication; anything else fails.
    const failed = checks.filter((c) => c.status === 'failed');
    if (failed.length && failed.every((c) => adjudicate.includes(c.name))) return { outcome: 'needs_adjudication', reason: 'adjudication_required' };
    return { outcome: 'fail', reason: 'tests_failed' };
  }
  if (cls.outcome === 'not_run') {
    if (cls.reason === 'dependency_change_required') return { outcome: 'fail', reason: 'dependency_change_required' };
    return { outcome: 'grader_error', reason: `suite_not_run:${cls.reason}` };
  }
  // error: decide who is at fault
  if (cls.reason === 'infra' || cls.reason === 'cancelled') return { outcome: 'infra_error', reason: cls.reason === 'infra' ? 'infra_error' : 'cancelled' };
  if (cls.reason === 'missing_executable') return { outcome: 'grader_error', reason: 'suite_command_missing' };
  if (cls.reason === 'timeout') return { outcome: 'fail', reason: 'timeout' };
  if (cls.reason === 'oom') return { outcome: 'fail', reason: 'oom' };
  // collection failure, zero tests, garbled/incomplete report, exit without failures, …:
  // a qualified suite loaded and passed on the reference, so the patch broke loading/startup.
  return { outcome: 'fail', reason: 'syntax_or_load_error', detail: cls.reason };
}

/**
 * @param {object} o
 * @param {object} o.spec              qb-task-spec/1
 * @param {string} o.patch             unified git diff ('' = no change)
 * @param {string} [o.suitesRoot]      default bench/suites
 * @param {Function} [o.runSandboxed]  injectable (tests); default lib/sandbox/pipeline
 * @param {boolean} [o.qualifying]     bench/qualify.js only: the suite is not yet qualified
 * @param {object} [o.sandbox]         { stateDir, deadlines }
 * @returns {Promise<object>} qb-grade/1
 */
async function grade(o) {
  const t0 = Date.now();
  const spec = S.TaskSpec.parse(o.spec);
  const patch = typeof o.patch === 'string' ? o.patch : '';
  const base = {
    schema: 'qb-grade/1', task_id: spec.id, spec_sha256: S.specHash(spec), patch_sha256: S.sha256(Buffer.from(patch)),
    grader_sha256: graderHash(), checks: [], environment: { network: 'none', credentials: 'none', image: AGENT_IMAGE },
  };
  const result = (outcome, reason, extra = {}) => S.Grade.parse({ ...base, outcome, reason, duration_ms: Date.now() - t0, ...extra });

  // 1. integrity
  const suiteDir = path.join(o.suitesRoot || SUITES_ROOT, spec.suite.dir);
  let files;
  try { files = S.fileHashes(suiteDir); } catch (e) { return result('grader_error', 'suite_unreadable', { detail: e.message }); }
  if (S.hashOf(files) !== S.hashOf(spec.suite.files)) return result('grader_error', 'suite_changed', { detail: 'hidden suite files differ from the frozen spec' });
  if (!o.qualifying) {
    const q = spec.qualification;
    if (!q) return result('grader_error', 'suite_not_qualified');
    if (q.suite_sha256 !== S.treeHash(suiteDir)) return result('grader_error', 'suite_changed', { detail: 'suite differs from the qualified suite' });
    if (q.grader_sha256 !== base.grader_sha256) return result('grader_error', 'grader_changed', { detail: 'the grader changed since the suite was qualified; re-qualify' });
  }
  // 2. boundary
  const leak = suiteLeak(spec, suiteDir);
  if (leak) return result('grader_error', 'suite_leaked', { detail: leak });
  // 3. ownership
  const touched = patchPaths(patch);
  if (touched === null) return result('fail', 'patch_does_not_apply', { detail: 'unparseable diff header' });
  const bad = touched.filter((f) => !supportedPath(f));
  if (bad.length) return result('fail', 'patch_does_not_apply', { detail: `unsupported path(s): ${bad.slice(0, 3).map((f) => JSON.stringify(f)).join(', ')}` });
  const owned = ownedTouched(spec, touched);
  if (owned.length) return result('fail', 'grader_owned_path', { detail: owned.slice(0, 10).join(', ') });

  // 4. a fresh pinned checkout — trusted content only; the patch is never applied on the host
  let ws;
  try {
    ws = createWorkspace(resolveSource(spec.repo.source), { baseRev: spec.repo.base_rev, label: `grade-${spec.id}` });
  } catch (e) { return result('grader_error', 'workspace_failed', { detail: e.message }); }
  try {
    if (ws.sourceCommit !== spec.repo.base_rev) return result('grader_error', 'base_rev_mismatch');
    for (const [rel, sha] of Object.entries(spec.repo.lockfiles)) {
      const p = path.join(ws.dir, rel);
      let st = null; try { st = fs.lstatSync(p); } catch { /* missing */ }
      if (!st || !st.isFile() || S.sha256File(p) !== sha) return result('grader_error', 'lockfile_mismatch', { detail: rel });
    }
    // 5. install the hidden suite (no-follow, beneath the root), committed as the graded base
    try { safeInstall(ws.dir, spec.suite.install_to, suiteDir, spec.suite.files); } catch (e) {
      if (e.code === 'UNSAFE_INSTALL_PATH' || e.code === 'EEXIST' || e.code === 'ELOOP') return result('grader_error', 'unsafe_install_path', { detail: e.message });
      throw e;
    }
    proc.git(['add', '-A'], ws.dir);
    proc.git(['-c', 'user.name=qb-grader', '-c', 'user.email=qb-grader@localhost', 'commit', '--quiet', '--no-gpg-sign', '--allow-empty', '-m', 'graded base (task base + hidden suite)'], ws.dir);

    // 6. apply the untrusted patch INSIDE the sandbox; run the suite there (no network, no credentials)
    const run = o.runSandboxed || require('../lib/sandbox/pipeline').runSandboxed;
    const r = await run({ repoPath: ws.dir, briefing: '', noAgent: true, applyPatch: patch, testCommand: spec.suite.command,
      baseTests: false, verify: true, ...(o.sandbox || {}) });
    const agentStage = r && r.sandbox && r.sandbox.stages && r.sandbox.stages.agent;
    if (agentStage && agentStage.exit_code === 42) return result('fail', 'patch_does_not_apply', { detail: 'git apply failed inside the sandbox' });
    // Defence in depth: the CAPTURED change list must not touch an owned path or an ancestor either.
    const captured = ownedTouched(spec, [...((r && r.changes) || []).map((c) => c.file), ...((r && r.unsupported_changes) || [])]);
    if (captured.length) return result('fail', 'grader_owned_path', { detail: `captured: ${captured.slice(0, 10).join(', ')}` });
    const v = r && r.sandbox && r.sandbox.verification;
    if (!v) {
      if (['blocked', 'infra_error', 'cancelled'].includes(r && r.status)) return result('infra_error', 'infra_error', { detail: String(r.reason || '').slice(0, 500) });
      if (r && r.status === 'setup_failed') {
        const depsTouched = touched.some((f) => /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json)$/.test(f));
        return depsTouched ? result('fail', 'dependency_install_failed', { detail: String(r.reason).slice(0, 500) })
          : result('infra_error', 'setup_failed', { detail: String(r.reason).slice(0, 500) });
      }
      return result('grader_error', 'no_verification', { detail: String(r && r.reason).slice(0, 500) });
    }
    // 7. classify
    const checks = checksFromReport(v.report);
    const g = fromTestRun(classifyTestRun(v), checks, spec.suite.adjudicate_checks);
    const marked = checks.map((c) => (spec.suite.adjudicate_checks.includes(c.name) ? { ...c, status: 'adjudicate' } : c));
    return result(g.outcome, g.reason, { checks: marked, ...(g.detail ? { detail: g.detail } : {}) });
  } finally {
    ws.cleanup();
  }
}

/**
 * The benchmark's scoring step for one arm (bench/run.js): the grader gets the frozen
 * spec and the arm's final patch ONLY — never the contract, internal verdict or arm label.
 * No frozen spec, or a blocked arm with no patch → 'ungraded', which is never a score.
 */
async function gradeArm(spec, armResult, o = {}) {
  if (!spec) return { outcome: 'ungraded', reason: 'no frozen task spec — internal verdicts are not scores' };
  if (armResult.blocked) return { outcome: 'ungraded', reason: `arm blocked (${armResult.blocked}) — no patch to grade` };
  return grade({ ...o, spec, patch: typeof armResult.patch === 'string' ? armResult.patch : '' });
}

module.exports = { grade, gradeArm, graderHash, patchPaths, suiteLeak, checksFromReport, ownedGlobs, ownedTouched, safeInstall, SUITES_ROOT, GRADER_FILES };
