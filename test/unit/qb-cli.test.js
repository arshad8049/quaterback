/**
 * QB-38 end-to-end: qb.js writes one run record per invocation, including
 * when the run is interrupted. Ollama is replaced by a preload stub.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn, spawnSync } = require('child_process');

const store = require('../../run/store');
const { makeRepo } = require('../helpers/tmprepo');

const QB      = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

const CONTRACT = JSON.stringify({
  goal: 'Add a clamp function',
  required_behavior: ['clamp(n, min, max) returns n bounded to [min, max]'],
  constraints: [],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported from src/utils.js' }],
  verification_plan: ['run tests'],
  relevant_context: [],
  ambiguity_flags: [],
  clarifying_question: null,
});

let runsDir, repo, memDir;
beforeEach(() => {
  runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-runs-'));
  memDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-mem-'));
  repo    = makeRepo({ 'src/utils.js': 'module.exports = {};\n' });
});
afterEach(() => {
  for (const d of [runsDir, memDir]) fs.rmSync(d, { recursive: true, force: true });
  repo.cleanup();
});

function env(extra = {}) {
  return { ...process.env, QB_RUNS_DIR: runsDir, QB_MEMORY_DIR: memDir, QB_TEST_OLLAMA_REPLY: CONTRACT, ...extra };
}

function onlyRun() {
  const ids = fs.readdirSync(runsDir);
  assert.equal(ids.length, 1, `expected one run, got ${ids.length}`);
  return store.loadRun(ids[0], runsDir);
}

test('a dry-run invocation produces a complete, replayable run record', () => {
  const r = spawnSync(process.execPath, [
    '--require', PRELOAD, QB, 'Add a clamp function to src/utils.js',
    '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify',
  ], { env: env(), encoding: 'utf8', timeout: 30_000 });

  assert.ok(r.stdout.includes('[RUN]'), r.stdout + r.stderr);
  const run = onlyRun();
  const m = run.manifest;
  assert.equal(m.outcome, 'DRY_RUN');
  assert.equal(m.legacy_verdict, 'no-diff');
  assert.equal(m.request, 'Add a clamp function to src/utils.js');
  assert.match(m.contract_hash, /^[0-9a-f]{64}$/);
  assert.equal(m.attempts.length, 1);
  assert.equal(store.readEvents(run).at(-1).type, 'run.finished');

  const replay = spawnSync(process.execPath, [QB, 'replay', m.run_id], { env: env(), encoding: 'utf8' });
  assert.equal(replay.status, 0, replay.stdout + replay.stderr);
  assert.match(replay.stdout, /reproduced/);
});

test('an interrupted invocation still leaves a terminal run record', async () => {
  const child = spawn(process.execPath, [
    '--require', PRELOAD, QB, 'Add a clamp function',
    '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context',
  ], { env: env({ QB_TEST_HANG: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });

  await new Promise(resolve => child.stdout.on('data', d => { if (String(d).includes('QB_TEST_HANGING')) resolve(); }));
  child.kill('SIGINT');
  const code = await new Promise(resolve => child.on('exit', c => resolve(c)));
  assert.equal(code, 130);

  const run = onlyRun();
  assert.equal(run.manifest.outcome, 'CANCELLED');
  assert.equal(store.readEvents(run).at(-1).type, 'run.aborted');
});
