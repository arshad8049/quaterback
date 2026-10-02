/**
 * lib/sandbox/cli.js — `qb auth …` and `qb patch …` (agent-sandbox.md §5, §9.3).
 *
 *   qb auth login | logout | status
 *   qb patch <run_id> [--attempt N] [--out FILE | --stdout]
 *
 * `qb patch` exports the run's exact patch for MANUAL application; QB never
 * writes to the checkout. It refuses unsafe patches, never overwrites a file or
 * follows a destination symlink, never writes inside the checkout, keeps stdout
 * for patch bytes only, labels the patch with its real verification status, and
 * reports drift between the checkout now and the base the agent started from.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultStateDir } = require('./pipeline');

const err = (...a) => process.stderr.write(a.join(' ') + '\n');

async function main(argv) {
  const [cmd, sub, ...rest] = argv;
  if (cmd === 'auth') return auth(sub);
  if (cmd === 'patch') return patch([sub, ...rest].filter((x) => x !== undefined));
  err('usage: qb auth login|logout|status  |  qb patch <run_id> [--attempt N] [--out FILE | --stdout]');
  return 2;
}

async function auth(sub) {
  const A = require('./auth');
  const stateDir = defaultStateDir();
  if (sub === 'login') {
    err('Signing in with the official Claude Code binary (subscription) into the QB-scoped login.');
    err('Your own ~/.claude login is not used or changed. Open the printed URL, sign in, paste the code back.');
    const r = await A.login(stateDir);
    return r.status === 0 ? 0 : 1;
  }
  if (sub === 'logout') { const r = await A.logout(stateDir); err(r.note || (r.ok ? 'logged out' : 'logout failed')); return r.ok ? 0 : 1; }
  if (sub === 'status') {
    if (!(await A.authVolumeExists())) { err('not logged in (run `qb auth login`)'); return 1; }
    const { ensureToolsImage } = require('./workspace');
    const exp = await A.credentialExpiry(A.AUTH_VOLUME, await ensureToolsImage());
    err(exp ? `logged in; access token expires ${new Date(exp).toISOString()} (refreshed before each run)` : 'logged in (expiry unknown)');
    return 0;
  }
  err('usage: qb auth login | logout | status');
  return 2;
}

// ── qb patch ─────────────────────────────────────────────────────────────────

function gitBlobId(buf) {
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** `git ls-tree -z` → Map(path → { mode, id }). */
function parseListing(buf) {
  const m = new Map();
  for (const rec of buf.toString('utf8').split('\0').filter(Boolean)) {
    const tab = rec.indexOf('\t');
    const [mode, , id] = rec.slice(0, tab).split(' ');
    m.set(rec.slice(tab + 1), { mode, id });
  }
  return m;
}

/** What is at `rel` in the checkout now, without following symlinks: { mode, id } | null. */
function current(repo, rel) {
  const abs = path.join(repo, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return null; }
  if (st.isSymbolicLink()) return { mode: '120000', id: gitBlobId(Buffer.from(fs.readlinkSync(abs))) };
  if (st.isFile()) return { mode: st.mode & 0o111 ? '100755' : '100644', id: gitBlobId(fs.readFileSync(abs)) };
  return { mode: 'other', id: null };
}

function readBinArtifact(run, name) {
  const ref = run.manifest.artifacts[name];
  if (!ref) return null;
  const buf = fs.readFileSync(path.join(run.dir, ref.path));
  if (crypto.createHash('sha256').update(buf).digest('hex') !== ref.sha256) throw new Error(`artifact ${name} failed checksum`);
  return buf;
}

async function patch(args) {
  const runId = args[0];
  if (!runId) { err('usage: qb patch <run_id> [--attempt N] [--out FILE | --stdout]'); return 2; }
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const toStdout = args.includes('--stdout');
  const store = require('../../run/store');
  const run = store.loadRun(runId);
  const m = run.manifest;
  const attempts = m.attempts.filter((a) => run.manifest.artifacts[`a${a.attempt}-patch-raw`]);
  const attempt = opt('--attempt') ? m.attempts.find((a) => a.attempt === Number(opt('--attempt'))) : attempts[attempts.length - 1];
  if (!attempt || !run.manifest.artifacts[`a${attempt.attempt}-patch-raw`]) { err(`run ${runId} has no exportable patch`); return 1; }
  const n = attempt.attempt;
  const raw = readBinArtifact(run, `a${n}-patch-raw`);
  const listing = parseListing(readBinArtifact(run, `a${n}-base-ls`) || Buffer.alloc(0));
  const execution = run.readArtifact(`a${n}-execution`) || {};
  const repo = m.repo.path;

  // 1. Refuse unsafe patches.
  const touched = [];
  const ns = execution.changes || [];
  for (const c of ns) touched.push(c.file);
  const bad = touched.filter((p) => path.isAbsolute(p) || p.split('/').some((c) => c === '..' || c.toLowerCase() === '.git'));
  const unresolved = execution.sandbox?.capture?.unresolved;
  if (bad.length || unresolved === 'unsafe_symlink' || unresolved === 'git_metadata_path') {
    err(`refusing to export: ${bad.length ? `unsafe paths ${JSON.stringify(bad)}` : `capture ${unresolved}`}`);
    return 1;
  }

  // 2. Drift: each touched path must still be exactly what the agent started from.
  const drift = [];
  const parentLinks = [];
  for (const rel of touched) {
    const base = listing.get(rel) || null;
    const now = current(repo, rel);
    if (base ? !(now && now.mode === base.mode && now.id === base.id) : now !== null) drift.push(rel);
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      try { if (fs.lstatSync(path.join(repo, ...parts.slice(0, i))).isSymbolicLink()) { parentLinks.push(rel); break; } } catch { break; }
    }
  }

  // 3. Status label: never "verified" in Phase 1 (tests were agent-editable).
  const v = execution.sandbox?.verification;
  const verification = !v ? 'not run'
    : v.status === 'ran' ? (v.state === 'completed' ? 'tests passed in sandbox (Phase 1: tests were agent-editable; protected tests restored from base)' : `tests ${v.state} in sandbox`)
      : `not run: ${v.reason}`;
  const header = Buffer.from([
    `# qb patch — run ${runId}, attempt ${n}`,
    `# execution: ${attempt.execution_status || execution.status}; verdict: ${attempt.verdict || 'unknown'}; verification: ${verification}`,
    `# base tree: ${execution.base_tree}; candidate tree: ${execution.candidate_tree}`,
    drift.length ? `# DRIFT: ${drift.length} touched path(s) changed in the checkout since the run started` : '# drift: none',
    '', ''].join('\n'));

  // 4. Write: stdout (patch bytes only) or a new file outside the checkout.
  if (toStdout) {
    process.stdout.write(Buffer.concat([header, raw]));
  } else {
    const out = path.resolve(opt('--out') || path.join(defaultStateDir(), 'patches', `${runId}-a${n}.patch`));
    const parent = path.dirname(out);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const realParent = fs.realpathSync(parent);
    const realRepo = fs.realpathSync(repo);
    if (realParent === realRepo || realParent.startsWith(realRepo + path.sep)) { err(`refusing to write inside the checkout: ${out}`); return 1; }
    const dfd = fs.openSync(realParent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.closeSync(dfd);
    let fd;
    try {
      fd = fs.openSync(path.join(realParent, path.basename(out)), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    } catch (e) {
      err(e.code === 'EEXIST' ? `refusing to overwrite ${out}` : e.code === 'ELOOP' ? `refusing to follow a symlink at ${out}` : e.message);
      return 1;
    }
    fs.writeSync(fd, Buffer.concat([header, raw])); fs.closeSync(fd);
    err(`patch written to ${out}`);
  }

  // 5. Diagnostics (stderr only).
  err(`status: ${header.toString().split('\n')[1].replace(/^# /, '')}`);
  if (drift.length) err(`drift: ${drift.length} path(s) changed since the run started:\n  ${drift.join('\n  ')}`);
  if (parentLinks.length) err(`warning: these paths go through a symlinked directory in your checkout:\n  ${parentLinks.join('\n  ')}`);
  err('Before applying, preserve your current state (commit, or `git stash push --include-untracked`).');
  err(`Then: git apply --check <file> && git apply <file>    (in ${repo})`);
  err('If an apply fails part-way, inspect with `git status` / `git diff` and restore from the state you preserved.');
  return 0;
}

module.exports = { main, gitBlobId, parseListing };
