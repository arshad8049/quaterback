/**
 * QB-05 — benchmark setup must never damage the developer's checkout.
 *
 * Done when: starting from dirty tracked, staged, untracked and ignored
 * files in the source checkout, the harness preserves them all and gives
 * both arms identical initial snapshots, even after an agent commit.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawnSync } = require('child_process');

const { makeRepo, fingerprint } = require('../helpers/tmprepo');
const { createWorkspace } = require('../../lib/workspace');

const ROOT    = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const PRELOAD_AGENT = path.join(__dirname, '..', 'helpers', 'preload-fake-sandbox.js');

function dirtyRepo() {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node --test' } }),
    'src/utils.js': 'module.exports = {};\n',
    '.gitignore': 'ignored.log\n',
  });
  repo.write('src/utils.js', 'module.exports = { wip: true };\n');   // dirty tracked
  repo.write('src/staged.js', 'staged\n'); repo.git(['add', 'src/staged.js']);   // staged
  repo.write('notes.txt', 'untracked\n');                              // untracked
  repo.write('ignored.log', 'ignored\n');                              // ignored
  return repo;
}

describe('lib/workspace', () => {
  let repo;
  beforeEach(() => { repo = dirtyRepo(); });
  afterEach(() => repo.cleanup());

  test('a workspace is built from the pinned commit and leaves the source untouched', () => {
    const before = fingerprint(repo.dir);
    const ws = createWorkspace(repo.dir, { baseRev: 'HEAD' });
    try {
      assert.equal(ws.mode, 'clone');
      assert.equal(ws.sourceDirty, true);
      assert.equal(fs.readFileSync(path.join(ws.dir, 'src/utils.js'), 'utf8'), 'module.exports = {};\n', 'uncommitted edits leaked into the workspace');
      assert.ok(!fs.existsSync(path.join(ws.dir, 'notes.txt')));
      assert.equal(spawnSync('git', ['remote'], { cwd: ws.dir, encoding: 'utf8' }).stdout.trim(), '', 'workspace can push to the source');
    } finally {
      ws.cleanup();
    }
    assert.deepEqual(fingerprint(repo.dir), before);
  });

  test('two workspaces from the same revision start from the same tree, even after an agent commit in one', () => {
    const a = createWorkspace(repo.dir);
    const b = createWorkspace(repo.dir);
    try {
      fs.writeFileSync(path.join(a.dir, 'x.js'), 'x');
      spawnSync('git', ['add', '-A'], { cwd: a.dir });
      spawnSync('git', ['commit', '-qm', 'agent'], { cwd: a.dir });
      const c = createWorkspace(repo.dir);
      try {
        assert.equal(a.baseTree, b.baseTree);
        assert.equal(b.baseTree, c.baseTree);
      } finally { c.cleanup(); }
    } finally { a.cleanup(); b.cleanup(); }
  });

  test('a repository subdirectory materialises deterministically (archive mode)', () => {
    const a = createWorkspace(path.join(repo.dir, 'src'));
    const b = createWorkspace(path.join(repo.dir, 'src'));
    try {
      assert.equal(a.mode, 'archive');
      assert.equal(a.baseSha, b.baseSha);
      assert.deepEqual(fs.readdirSync(a.dir).filter(f => f !== '.git'), ['utils.js']);
    } finally { a.cleanup(); b.cleanup(); }
  });

  test('setup errors throw instead of being swallowed', () => {
    assert.throws(() => createWorkspace(repo.dir, { baseRev: 'no-such-rev' }));
    assert.throws(() => createWorkspace(path.join(os.tmpdir(), 'qb-does-not-exist')));
  });
});

describe('bench/run.js', () => {
  let repo, tmp;
  beforeEach(() => {
    repo = dirtyRepo();
    tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-bench-'));
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('preserves a dirty source checkout byte-for-byte across both arms', () => {
    const tasksFile = path.join(tmp, 'tasks.json');
    fs.writeFileSync(tasksFile, JSON.stringify({
      meta: { repo: repo.dir, base_rev: 'HEAD' },
      tasks: [{ id: 'X-001', difficulty: 'easy', tags: [], description: 'Add clamp to src/utils.js' }],
    }));
    // The agent edits, commits, and leaves an untracked file — in both arms.
    const script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [
      { write: 'src/utils.js', content: 'module.exports = { clamp: (n, a, b) => Math.min(Math.max(n, a), b) };\n' },
      { git: ['add', '-A'] }, { git: ['commit', '-qm', 'agent'] },
      { write: 'agent-scratch.txt', content: 'tmp\n' },
    ] }));

    const before = fingerprint(repo.dir);
    const r = spawnSync(process.execPath, [
      '--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'bench', 'run.js'),
      '--tasks', tasksFile, '--results', path.join(tmp, 'results'),
      '--no-llm-context', '--max-retries', '1',
    ], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        QB_FAKE_AGENT_SCRIPT: script,
        QB_RUNS_DIR:          path.join(tmp, 'runs'),
        QB_MEMORY_DIR:        path.join(tmp, 'mem'),
        QB_TEST_OLLAMA_REPLY: JSON.stringify({
          goal: 'Add clamp', required_behavior: ['clamp'], constraints: [],
          acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported' }],
          verification_plan: ['tests'], relevant_context: [], ambiguity_flags: [], clarifying_question: null,
          met: true, evidence: 'clamp added',
        }),
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);

    assert.deepEqual(fingerprint(repo.dir), before, 'source checkout was modified by the benchmark');

    const [resultFile] = fs.readdirSync(path.join(tmp, 'results')).filter(f => f.startsWith('X-001'));
    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'results', resultFile), 'utf8'));
    assert.ok(result.qb.workspace.base_tree, 'QB arm base snapshot not recorded');
    assert.equal(result.qb.workspace.base_tree, result.baseline.workspace.base_tree, 'arms started from different snapshots');
    assert.deepEqual(result.qb.files_changed.sort(), ['agent-scratch.txt', 'src/utils.js']);
    assert.deepEqual(result.baseline.files_changed.sort(), ['agent-scratch.txt', 'src/utils.js']);
  });
});
