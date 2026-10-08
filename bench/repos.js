/**
 * bench/repos.js — reproducible benchmark task repositories (QB-30 curation).
 *
 * A spec names its repository as `qb-bench:<name>`, never as a path on one machine. The
 * name is pinned in bench/repos/repos.json (upstream URL, tag, commit, license, test argv,
 * the devDependencies the upstream tests import) and BUILT the same way everywhere:
 *
 *   base = the pinned upstream commit + ONE commit with fixed author, committer and date:
 *     - package.json: `scripts` = { test: <node:test argv> } only (no lifecycle scripts, no
 *       coverage/lint wrappers); devDependencies cut to the ones the tests import;
 *     - package-lock.json: the pinned lockfile from bench/repos/<name>.package-lock.json
 *       (the sandbox installs only from a lockfile: `npm ci`);
 *     - .quarterback.json: the node:test command (QB-20), so visible tests are verifiable;
 *     - the files listed in `remove` (e.g. an .npmrc with package-lock=false).
 *   Every other file is upstream bytes. Same pin + same edits → same base_rev on any machine.
 *
 * Built checkouts live outside the QB repository (QB_BENCH_REPOS, default
 * ~/.qb/bench-repos/built), so hidden suites are never inside a task repository.
 *
 * CLI:
 *   node bench/repos.js build <name|all>   build (or rebuild) and print base_rev
 *   node bench/repos.js lock <name>        write bench/repos/<name>.package-lock.json, resolved as of the
 *                                          upstream commit date (needs network)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../lib/proc');

const PREFIX = 'qb-bench:';
const BASE_DATE = '2026-10-08T00:00:00Z';
const IDENTITY = { name: 'qb-bench', email: 'qb-bench@quarterback.invalid' };
const ARG = /^[A-Za-z0-9_./*@:=,+-]+$/;

let defaults = {
  manifest: null,                                        // loaded lazily from bench/repos/repos.json
  lockDir: path.join(__dirname, 'repos'),
  root: process.env.QB_BENCH_REPOS || path.join(os.homedir(), '.qb', 'bench-repos', 'built'),
  mirrors: process.env.QB_BENCH_MIRRORS || path.join(os.homedir(), '.qb', 'bench-repos', 'mirrors'),
};
/** Replace the defaults (tests); returns the previous ones. */
function setDefaults(o) { const prev = defaults; defaults = { ...defaults, ...o }; return prev; }

const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: BASE_DATE,
  GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: BASE_DATE };
function git(cwd, args, input) {
  const r = proc.run('git', args, { cwd, env: GIT_ENV, input });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

function manifestOf(o) {
  if (o.manifest) return o.manifest;
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'repos', 'repos.json'), 'utf8')).repos;
}

function entryOf(name, o) {
  const e = manifestOf(o)[name];
  if (!e) throw new Error(`unknown benchmark repository: ${name}`);
  if (!/^[0-9a-f]{40}$/.test(e.commit)) throw new Error(`${name}: commit must be a full sha`);
  if (!Array.isArray(e.test) || !e.test.length || !e.test.every((a) => ARG.test(a))) throw new Error(`${name}: test must be a simple argv`);
  return e;
}

/** A local mirror of the upstream that holds the pinned commit; the tag must point at it. */
function mirror(name, e, o) {
  const dir = path.join(o.mirrors, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(o.mirrors, { recursive: true });
    git(o.mirrors, ['clone', '--quiet', '--mirror', e.upstream, dir]);
  }
  const has = () => { try { git(dir, ['cat-file', '-e', `${e.commit}^{commit}`]); return true; } catch { return false; } };
  if (!has()) { try { git(dir, ['fetch', '--quiet', '--tags', 'origin']); } catch { /* checked below */ } }
  if (e.tag === null) {
    // A repository without release tags (e.g. a local project): pinned by commit alone.
    if (!has()) throw new Error(`${name}: pinned commit ${e.commit} not found in ${e.upstream}`);
    return dir;
  }
  let tagged = null;
  try { tagged = git(dir, ['rev-parse', '--verify', `refs/tags/${e.tag}^{commit}`]).trim(); } catch { /* unknown tag */ }
  if (tagged !== e.commit) throw new Error(`${name}: tag ${e.tag} (${tagged || 'unknown'}) does not match the pinned commit ${e.commit}`);
  return dir;
}

/** The deterministic edits on top of upstream (see the header). */
function transform(dir, name, e, o) {
  const pkgPath = path.join(dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.scripts = { test: e.test.join(' ') };
  const keep = e.keep_dev_dependencies || [];
  const dev = Object.fromEntries(keep.map((k) => {
    if (!pkg.devDependencies || !(k in pkg.devDependencies)) throw new Error(`${name}: keep_dev_dependencies names ${k}, which upstream does not declare`);
    return [k, pkg.devDependencies[k]];
  }));
  if (keep.length) pkg.devDependencies = dev; else delete pkg.devDependencies;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, '.quarterback.json'), JSON.stringify({ test: { runner: 'node-test', command: e.test } }, null, 2) + '\n');
  for (const rel of e.remove || []) fs.rmSync(path.join(dir, rel), { force: true });
  if (!o.noLock) {
    const lock = path.join(o.lockDir, `${name}.package-lock.json`);
    if (!fs.existsSync(lock)) throw new Error(`${name}: no pinned lockfile at ${path.relative(process.cwd(), lock)} — run: node bench/repos.js lock ${name}`);
    // The sandbox's deps plan refuses link:/file:/git dependencies (deps-plan.sh) — refuse them here, at build.
    const local = Object.entries(JSON.parse(fs.readFileSync(lock, 'utf8')).packages || {})
      .filter(([, v]) => v.link === true || /^(file:|git|github:|link:)/.test(v.resolved || '')).map(([k]) => k);
    if (local.length) throw new Error(`${name}: the pinned lockfile has link:/file:/git dependencies (${local.join(', ')}); the sandbox installs registry packages only`);
    fs.copyFileSync(lock, path.join(dir, 'package-lock.json'));
  }
}

/**
 * Build `name` into <root>/<name> (replacing any previous build). Returns { dir, head }.
 * @param {string} name
 * @param {object} [o] { manifest, root, lockDir, mirrors, noLock }
 */
function build(name, o = {}) {
  o = { ...defaults, ...o };
  const e = entryOf(name, o);
  const src = mirror(name, e, o);
  const dir = path.join(o.root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(o.root, { recursive: true });
  git(o.root, ['clone', '--quiet', '--no-checkout', '--no-hardlinks', src, dir]);
  git(dir, ['checkout', '--quiet', '--detach', e.commit]);
  transform(dir, name, e, o);
  git(dir, ['add', '-A']);
  // The files the builder writes are committed even when the upstream .gitignore lists them
  // (many ignore package-lock.json); without -f the pinned lockfile silently drops out.
  git(dir, ['add', '-f', '--', 'package.json', '.quarterback.json', ...(o.noLock ? [] : ['package-lock.json'])]);
  const tree = git(dir, ['write-tree']).trim();
  const msg = `qb-bench: ${name} ${e.tag || e.commit.slice(0, 12)} as a QB benchmark base\n\n`
    + `Upstream ${e.upstream} @ ${e.commit} (${e.license || 'license unknown'}).\n`
    + 'Changes: package.json scripts = node:test only, devDependencies cut to those the tests import;\n'
    + `pinned package-lock.json; .quarterback.json test command${(e.remove || []).length ? `; removed ${e.remove.join(', ')}` : ''}.\n`;
  const head = git(dir, ['commit-tree', tree, '-p', e.commit, '-F', '-'], msg).trim();
  git(dir, ['checkout', '--quiet', '-B', 'qb-bench', head]);
  try { git(dir, ['remote', 'remove', 'origin']); } catch { /* none */ }
  return { dir, head };
}

/** `qb-bench:<name>` → the built checkout (built on first use); any other source is a path, unchanged. */
function resolveSource(source, o = {}) {
  if (typeof source !== 'string' || !source.startsWith(PREFIX)) return source;
  o = { ...defaults, ...o };
  const name = source.slice(PREFIX.length);
  entryOf(name, o);
  const dir = path.join(o.root, name);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  return build(name, o).dir;
}

/** Write bench/repos/<name>.package-lock.json for the transformed package.json (network). */
function lock(name, o = {}) {
  o = { ...defaults, ...o };
  const { dir } = build(name, { ...o, noLock: true, root: fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bench-lock-')) });
  try {
    // Resolve as of the upstream commit's date: the dependency set upstream tested against
    // (a later release of a transitive dependency can break the base's own tests).
    const before = git(dir, ['log', '-1', '--format=%cI', 'HEAD^']).trim();
    const r = proc.run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', `--before=${before}`], { cwd: dir, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`${name}: npm install --package-lock-only failed`);
    const out = path.join(o.lockDir, `${name}.package-lock.json`);
    fs.copyFileSync(path.join(dir, 'package-lock.json'), out);
    return out;
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
}

module.exports = { build, resolveSource, lock, setDefaults, PREFIX, BASE_DATE };

if (require.main === module) {
  const [cmd, name] = process.argv.slice(2);
  const names = name === 'all' ? Object.keys(manifestOf(defaults)) : [name];
  if (cmd === 'build' && name) for (const n of names) console.log(`${n}\t${build(n).head}`);
  else if (cmd === 'lock' && name) for (const n of names) console.log(lock(n));
  else { console.error('usage: node bench/repos.js build|lock <name|all>'); process.exit(2); }
}
