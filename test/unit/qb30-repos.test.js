/**
 * QB-30 (curation): benchmark task repositories are reproducible on any machine.
 *   - a spec names its repository as `qb-bench:<name>`, never a path on one machine;
 *   - the base is built from the pinned upstream commit plus ONE deterministic commit
 *     (pinned lockfile, node:test command, test-only devDependencies), so every machine
 *     gets the same base_rev;
 *   - the grader and the experiment runner resolve the name to the built checkout.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const S = require('../../bench/schemas');
const R = require('../../bench/repos');
const { grade } = require('../../bench/grader');
const { hostRunner } = require('../helpers/grading-fixture');

const MAJOR = Number(process.versions.node.split('.')[0]);
// Grading reads the node:test summary event (QB-06), which Node 20 does not emit — as in qb27-grader.
const LIVE = { skip: MAJOR < 22 && `node ${process.version} has no test:summary event` };

const UPSTREAM = {
  'package.json': JSON.stringify({ name: 'fx', version: '1.2.3', main: 'index.js',
    scripts: { test: 'c8 --100 node --test', lint: 'eslint', prepare: 'husky' },
    dependencies: {}, devDependencies: { c8: '^10.0.0', eslint: '^9.0.0', 'left-pad': '^1.3.0' } }, null, 2) + '\n',
  '.npmrc': 'package-lock=false\n',
  '.gitignore': 'node_modules\npackage-lock.json\n',   // upstreams often ignore the lockfile
  'index.js': 'module.exports.add = (a, b) => a + b;\n',
  'test/add.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert');\n"
    + "test('add', () => assert.strictEqual(require('..').add(1, 2), 3));\n",
};
// What `npm install --package-lock-only` writes for the transformed package.json (one dev dep).
const LOCK = JSON.stringify({ name: 'fx', version: '1.2.3', lockfileVersion: 3, requires: true, packages: {
  '': { name: 'fx', version: '1.2.3', devDependencies: { 'left-pad': '^1.3.0' } },
  'node_modules/left-pad': { version: '1.3.0', resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz',
    integrity: 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQ9cI8ApUgy4rhC4dmN3Ruu8eiMb9yZHhtpgxcjzZXq3fEyZIaA==', dev: true } } }, null, 2) + '\n';

let tmp, upstream, mf;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30-repos-'));
  upstream = makeRepo(UPSTREAM);
  upstream.git(['tag', 'v1.2.3']);
  fs.mkdirSync(path.join(tmp, 'qb/bench/repos'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'qb/bench/repos/fx.package-lock.json'), LOCK);
  mf = { fx: { upstream: upstream.dir, tag: 'v1.2.3', commit: upstream.head(), license: 'MIT',
    test: ['node', '--test', 'test/'], keep_dev_dependencies: ['left-pad'], remove: ['.npmrc'] } };
});
after(() => { upstream.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

const opts = (root) => ({ manifest: mf, root, lockDir: path.join(tmp, 'qb/bench/repos'), mirrors: path.join(tmp, 'mirrors') });

describe('QB-30: reproducible task repositories', () => {
  test('two independent builds of the same pin give the same base_rev', () => {
    const a = R.build('fx', opts(path.join(tmp, 'a')));
    const b = R.build('fx', opts(path.join(tmp, 'b')));
    assert.match(a.head, /^[0-9a-f]{40}$/);
    assert.equal(a.head, b.head);
    assert.notEqual(a.head, upstream.head(), 'the base is one commit on top of upstream');
    const parent = require('child_process').execFileSync('git', ['rev-parse', 'HEAD^'], { cwd: a.dir, encoding: 'utf8' }).trim();
    assert.equal(parent, upstream.head(), 'its parent is exactly the pinned upstream commit');
  });

  test('the base commit: pinned lockfile, node:test command, test-only dev deps, no install scripts', () => {
    const { dir } = R.build('fx', opts(path.join(tmp, 'c')));
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.scripts, { test: 'node --test test/' });
    assert.deepEqual(pkg.devDependencies, { 'left-pad': '^1.3.0' });
    assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), LOCK);
    const tracked = require('child_process').execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).split('\n');
    assert.ok(tracked.includes('package-lock.json') && tracked.includes('.quarterback.json'), 'the pinned files are COMMITTED even when upstream .gitignore lists them');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.quarterback.json'), 'utf8')),
      { test: { runner: 'node-test', command: ['node', '--test', 'test/'] } });
    assert.equal(fs.existsSync(path.join(dir, '.npmrc')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'index.js'), 'utf8'), UPSTREAM['index.js'], 'source files are upstream bytes');
  });

  test('a pin that does not match the upstream tag is refused', () => {
    const bad = { fx: { ...mf.fx, commit: 'f'.repeat(40) } };
    assert.throws(() => R.build('fx', { ...opts(path.join(tmp, 'd')), manifest: bad }), /does not match|unknown/);
  });

  test('a local upstream without a tag is pinned by commit alone (and an unknown commit is refused)', () => {
    const local = { fx: { ...mf.fx, tag: null } };
    const a = R.build('fx', { ...opts(path.join(tmp, 'h')), manifest: local });
    const b = R.build('fx', opts(path.join(tmp, 'i')));
    const rev = (d, r) => require('child_process').execFileSync('git', ['rev-parse', r], { cwd: d, encoding: 'utf8' }).trim();
    assert.equal(rev(a.dir, 'HEAD^{tree}'), rev(b.dir, 'HEAD^{tree}'), 'same content as the tagged pin');
    assert.equal(rev(a.dir, 'HEAD^'), upstream.head());
    assert.equal(a.head, R.build('fx', { ...opts(path.join(tmp, 'k')), manifest: local }).head, 'deterministic');
    assert.throws(() => R.build('fx', { ...opts(path.join(tmp, 'j')), manifest: { fx: { ...local.fx, commit: 'e'.repeat(40) } } }), /not found/);
  });

  test('a pinned lockfile with link:/file:/git dependencies is refused at build (the sandbox would refuse it later)', () => {
    const lockDir = path.join(tmp, 'badlock'); fs.mkdirSync(lockDir, { recursive: true });
    const bad = JSON.parse(LOCK); bad.packages['node_modules/fx'] = { resolved: '', link: true };
    fs.writeFileSync(path.join(lockDir, 'fx.package-lock.json'), JSON.stringify(bad));
    assert.throws(() => R.build('fx', { ...opts(path.join(tmp, 'l')), lockDir }), /link:\/file:\/git.*node_modules\/fx/);
  });

  test('resolveSource: qb-bench:<name> → the built checkout; a plain path is unchanged; an unknown name is refused', () => {
    const o = opts(path.join(tmp, 'e'));
    const dir = R.resolveSource('qb-bench:fx', o);
    assert.equal(fs.existsSync(path.join(dir, '.git')), true);
    assert.equal(R.resolveSource('qb-bench:fx', o), dir, 'built once, reused');
    assert.equal(R.resolveSource('/some/local/repo', o), '/some/local/repo');
    assert.throws(() => R.resolveSource('qb-bench:nope', o), /unknown benchmark repository/);
  });

  test('the grader grades a spec whose repository is qb-bench:<name>', LIVE, async () => {
    const o = opts(path.join(tmp, 'g'));
    const prev = R.setDefaults(o);
    const suitesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30-suites-'));
    try {
      const { dir, head } = R.build('fx', o);
      fs.mkdirSync(path.join(suitesRoot, 'FX-1'));
      fs.writeFileSync(path.join(suitesRoot, 'FX-1/add.test.js'), "const { test } = require('node:test');\nconst assert = require('node:assert');\n"
        + "test('add(2, 2)', () => assert.strictEqual(require('../../index.js').add(2, 2), 4));\n");
      const spec = { schema: 'qb-task-spec/1', id: 'FX-1', version: 1, split: 'dev', stratum: { type: 'addition', repository: 'fx' },
        repo: { source: 'qb-bench:fx', base_rev: head, lockfiles: { 'package-lock.json': S.sha256File(path.join(dir, 'package-lock.json')) } },
        prompt: 'p', requirement: 'r', oracle: null,
        suite: { dir: 'FX-1', files: S.fileHashes(path.join(suitesRoot, 'FX-1')), command: ['node', '--test', 'test/hidden/add.test.js'],
          install_to: 'test/hidden', owned_paths: ['test/hidden/**'], adjudicate_checks: [] },
        qualification: null, adjudication_rules: 'a', provenance: { author: 't', created_at: '2026-10-08T00:00:00Z', tuned_during_development: false } };
      const g = await grade({ spec, patch: '', suitesRoot, runSandboxed: hostRunner(), qualifying: true });
      assert.equal(g.outcome, 'pass', `${g.reason} ${g.detail || ''}`);
    } finally { R.setDefaults(prev); fs.rmSync(suitesRoot, { recursive: true, force: true }); }
  });
});
