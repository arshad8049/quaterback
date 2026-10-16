/**
 * QB-31 senior review (comment 10276, 2026-10-12): "unsupported agents/runners … fail before model
 * execution" was not met for runners. A committed repo with scripts.test 'jest' passed
 * validateRunOptions (errors []), and qb.js --agent claude-code made ONE model call and created
 * ONE run record before stopping. The run preflight now reuses testPlan(repo), which reads
 * package.json / .quarterback.json and never executes repository scripts.
 *
 * Exception: --agent dry-run only compiles a contract and briefing (it verifies nothing), so it
 * stays usable on any repository. Every agent run (claude-code, manual) is refused.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { makeRepo } = require('../helpers/tmprepo');
const { validateRunOptions } = require('../../lib/run-options');

const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD_OLLAMA = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const PRELOAD_SPY = path.join(__dirname, '..', 'helpers', 'preload-sandbox-spy.js');

const JEST = { 'package.json': JSON.stringify({ name: 'j', scripts: { test: 'jest' }, devDependencies: { jest: '29.7.0' } }), 'src/a.js': 'module.exports = {};\n' };
const CONFIGURED = { 'package.json': JSON.stringify({ name: 'c', scripts: { test: 'node --test' } }),
  '.quarterback.json': JSON.stringify({ test: { runner: 'mocha', command: ['npx', 'mocha'] } }), 'src/a.js': 'module.exports = {};\n' };
const INVALID = { 'package.json': JSON.stringify({ name: 'i', scripts: { test: 'node --test' } }), '.quarterback.json': '{ not json', 'src/a.js': '' };
const NODE_TEST = { 'package.json': JSON.stringify({ name: 'n', scripts: { test: 'node --test' } }), 'test/a.test.js': "require('node:test');\n", 'src/a.js': '' };

const opts = (repo, agent = 'claude-code') => ({ repo: repo.dir, agent, maxRetries: '3', clarify: [] });

describe('QB-31: unsupported test runners are refused in the run preflight', () => {
  test('detected Jest: claude-code and manual are refused with the runner named (pre-fix: errors [])', () => {
    const repo = makeRepo(JEST);
    try {
      for (const agent of ['claude-code', 'manual']) {
        const e = validateRunOptions(opts(repo, agent), 'Add a clamp function').errors.join('\n');
        assert.match(e, /--repo .*unsupported test runner: jest \(detected\); QB verifies only with node:test/, agent);
      }
    } finally { repo.cleanup(); }
  });
  test('an explicitly configured unsupported runner (.quarterback.json) is refused, naming the config', () => {
    const repo = makeRepo(CONFIGURED);
    try { assert.match(validateRunOptions(opts(repo), 'x').errors.join('\n'), /unsupported test runner: mocha \(\.quarterback\.json\)/); } finally { repo.cleanup(); }
  });
  test('an invalid test config is refused too', () => {
    const repo = makeRepo(INVALID);
    try { assert.match(validateRunOptions(opts(repo), 'x').errors.join('\n'), /--repo .*\.quarterback\.json is not valid JSON/); } finally { repo.cleanup(); }
  });
  test('controls: a node:test repo passes; dry-run (planning only) is the explicit exception', () => {
    const ok = makeRepo(NODE_TEST); const jest = makeRepo(JEST);
    try {
      assert.deepEqual(validateRunOptions(opts(ok), 'x').errors, []);
      assert.deepEqual(validateRunOptions(opts(jest, 'dry-run'), 'x').errors, []);
    } finally { ok.cleanup(); jest.cleanup(); }
  });

  /** qb.js end to end with the model and the sandbox spied; returns what happened. */
  function runCli(files, agent = 'claude-code') {
    const repo = makeRepo(files);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-runner-'));
    try {
      const fetchLog = path.join(tmp, 'fetch.log'); const sandboxLog = path.join(tmp, 'sandbox.log'); const runs = path.join(tmp, 'runs');
      const r = proc.run(process.execPath, ['--require', PRELOAD_OLLAMA, '--require', PRELOAD_SPY, QB, 'Add a clamp function', '--repo', repo.dir,
        '--agent', agent, '--no-llm-context', '--no-llm-verify'], {
        env: { ...process.env, QB_TEST_FETCH_LOG: fetchLog, QB_TEST_SANDBOX_LOG: sandboxLog, QB_RUNS_DIR: runs, QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: '{}' },
        encoding: 'utf8', timeout: 30_000,
      });
      const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      return { status: r.status, out: r.stdout + r.stderr, modelCalls: read(fetchLog).split('\n').filter(Boolean).length,
        launches: read(sandboxLog).split('\n').filter(Boolean).length, records: fs.existsSync(runs) ? fs.readdirSync(runs).length : 0 };
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  for (const [label, files, re] of [
    ['detected Jest', JEST, /unsupported test runner: jest \(detected\)/],
    ['configured mocha (.quarterback.json)', CONFIGURED, /unsupported test runner: mocha \(\.quarterback\.json\)/],
  ]) {
    test(`qb.js --agent claude-code, ${label}: exit 2, runner named, zero model calls, zero agent launches, zero run records (pre-fix: 1 model call, 1 record)`, () => {
      const r = runCli(files);
      assert.equal(r.status, 2, r.out);
      assert.match(r.out, /qb: invalid options/);
      assert.match(r.out, re);
      assert.deepEqual([r.modelCalls, r.launches, r.records], [0, 0, 0], r.out);
    });
  }

  test('qb.js control: a node:test repo is not refused by the gate (it proceeds to the model)', () => {
    const r = runCli(NODE_TEST);
    assert.doesNotMatch(r.out, /unsupported test runner|invalid options/);
    assert.ok(r.modelCalls >= 1, `the validated path reached the model: ${r.out}`);
  });
});
