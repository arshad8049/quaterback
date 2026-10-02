/**
 * QB-38 — durable, versioned run record.
 *
 * Exit gate: one run manifest connects input, patch, checks and outcome,
 * including for a deliberately interrupted run.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { spawn } = require('child_process');

const store = require('../../run/store');
const { RunManifestSchema } = require('../../run/schema');

let runsDir;
beforeEach(() => { runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-runs-')); });
afterEach(() => fs.rmSync(runsDir, { recursive: true, force: true }));

function newRun(extra = {}) {
  return store.createRun({ kind: 'qb', request: 'add clamp()', repoPath: os.tmpdir(), runsDir, ...extra });
}

describe('run store', () => {
  test('a completed run links request, contract, patch, checks, report and outcome', () => {
    const run = newRun({ agent: { type: 'claude-code' }, models: { intent: 'm1' } });
    run.setContract({ goal: 'clamp', acceptance_criteria: [{ id: 'AC-1', criterion: 'x', met: null }] });
    run.startAttempt({ attempt: 1, base_sha: 'abc123' });

    const verifyInput = { hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: { passed: 3, failed: 0, skipped: 0 } };
    run.finishAttempt(1, {
      execution: { status: 'completed' },
      report:    { verdict: 'pass' },
      patch:     'diff --git a/x b/x\n+x\n',
      verifyInput,
      checks: [{ check_id: 'tests', status: 'pass', exit_code: 0, signal: null, duration_ms: 12, evidence_ids: [] }],
    });
    run.finish('VERIFIED', { legacy_verdict: 'pass' });

    const loaded = store.loadRun(run.id, runsDir);
    const m = loaded.manifest;
    assert.equal(m.schema_version, 1);
    assert.equal(m.request, 'add clamp()');
    assert.equal(m.outcome, 'VERIFIED');
    assert.match(m.contract_hash, /^[0-9a-f]{64}$/);
    assert.equal(m.attempts.length, 1);
    assert.match(m.attempts[0].patch_sha256, /^[0-9a-f]{64}$/);
    assert.equal(m.attempts[0].checks[0].exit_code, 0);
    assert.equal(loaded.readArtifact('a1-patch'), 'diff --git a/x b/x\n+x\n');
    assert.deepEqual(loaded.readArtifact('a1-verify-input'), verifyInput);

    const types = store.readEvents(loaded).map(e => e.type);
    assert.equal(types[0], 'run.started');
    assert.equal(types.at(-1), 'run.finished');
    assert.ok(types.includes('contract.accepted'));
  });

  test('artifacts are content-addressed and checksum-verified on read', () => {
    const run = newRun();
    const ref = run.artifact('note', 'hello');
    assert.equal(ref.sha256, require('crypto').createHash('sha256').update('hello').digest('hex'));

    fs.writeFileSync(path.join(run.dir, ref.path), 'tampered');
    assert.throws(() => run.readArtifact('note'), /checksum/);
  });

  test('artifact names and run ids cannot traverse out of the run directory', () => {
    const run = newRun();
    for (const bad of ['../x', '../../model-chosen-location', '/etc/passwd', 'a/b', '']) {
      assert.throws(() => run.artifact(bad, 'x'), /Invalid artifact name/);
    }
    assert.throws(() => store.loadRun('../../etc', runsDir), /Invalid run id/);
  });

  test('secrets are redacted from config, events and artifacts', () => {
    const run = newRun({ config: { apiKey: 'sk-ant-abcdefghijklmnop', maxRetries: 3 } });
    run.artifact('blob', { note: 'token sk-ant-zzzzzzzzzzzzzzzz here' });
    run.event('x', { authorization: 'Bearer abc' });

    const raw = fs.readdirSync(run.dir, { recursive: true })
      .map(f => path.join(run.dir, f))
      .filter(f => fs.statSync(f).isFile())
      .map(f => fs.readFileSync(f, 'utf8'))
      .join('\n');
    assert.ok(!raw.includes('sk-ant-'), 'raw key leaked');
    assert.ok(!raw.includes('Bearer abc'), 'auth header leaked');
    assert.equal(run.manifest.config.maxRetries, 3);
  });

  test('replay recomputes each verdict from stored evidence', () => {
    const run = newRun();
    run.startAttempt({ attempt: 1 });
    run.finishAttempt(1, {
      report: { verdict: 'fail' },
      verifyInput: { hasDiff: true, criteriaResults: [{ id: 'AC-1', met: false }], testResults: null },
    });
    run.startAttempt({ attempt: 2, parent_attempt: 1, repair_reason: ['AC-1'] });
    run.finishAttempt(2, {
      report: { verdict: 'pass' },
      verifyInput: { hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null },
    });
    run.finish('VERIFIED', { legacy_verdict: 'pass' });

    const r = store.replay(run.id, runsDir);
    assert.equal(r.ok, true);
    assert.deepEqual(r.attempts.map(a => a.replayed), ['fail', 'pass']);
  });

  test('replay detects a recorded verdict the evidence does not support', () => {
    const run = newRun();
    run.startAttempt({ attempt: 1 });
    run.finishAttempt(1, {
      report: { verdict: 'pass' },   // recorded PASS…
      verifyInput: { hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: { passed: 0, failed: 2, skipped: 0 } },
    });
    run.finish('VERIFIED', { legacy_verdict: 'pass' });

    const r = store.replay(run.id, runsDir);
    assert.equal(r.ok, false);         // …but failing tests replay as fail
    assert.equal(r.attempts[0].replayed, 'fail');
  });

  test('a committed v1 manifest still loads (schema compatibility)', () => {
    const fixture = path.join(__dirname, '..', 'fixtures', 'run-v1');
    const id = fs.readdirSync(fixture)[0];
    fs.cpSync(path.join(fixture, id), path.join(runsDir, id), { recursive: true });
    const run = store.loadRun(id, runsDir);
    assert.equal(run.manifest.outcome, 'FAILED');
    assert.doesNotThrow(() => RunManifestSchema.parse(run.manifest));
  });
});

describe('interrupted runs', () => {
  const CHILD = `
    const store = require(${JSON.stringify(path.join(__dirname, '../../run/store'))});
    const run = store.createRun({ kind: 'qb', request: 'long task', repoPath: process.cwd(), runsDir: process.env.RUNS });
    store.installSignalHandlers(run);
    run.startAttempt({ attempt: 1 });
    process.stdout.write(run.id + '\\n');
    setInterval(() => {}, 1000);
  `;

  function startChild() {
    const child = spawn(process.execPath, ['-e', CHILD], { env: { ...process.env, RUNS: runsDir }, stdio: ['ignore', 'pipe', 'inherit'] });
    const id = new Promise(resolve => child.stdout.once('data', d => resolve(String(d).trim())));
    const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
    return { child, id, exited };
  }

  test('SIGINT closes the run as CANCELLED with a terminal event', async () => {
    const { child, id, exited } = startChild();
    const runId = await id;
    child.kill('SIGINT');
    const { code } = await exited;
    assert.equal(code, 130);

    const run = store.loadRun(runId, runsDir);
    assert.equal(run.manifest.outcome, 'CANCELLED');
    assert.ok(run.manifest.finished_at);
    assert.equal(store.readEvents(run).at(-1).type, 'run.aborted');
    assert.equal(run.manifest.attempts.length, 1, 'in-flight attempt is preserved');
  });

  test('a hard-killed run is marked ABANDONED on the next start', async () => {
    const { child, id, exited } = startChild();
    const runId = await id;
    child.kill('SIGKILL');
    await exited;

    assert.equal(store.loadRun(runId, runsDir).manifest.outcome, 'RUNNING');
    const reaped = store.reapAbandoned(runsDir);
    assert.deepEqual(reaped, [runId]);
    const run = store.loadRun(runId, runsDir);
    assert.equal(run.manifest.outcome, 'ABANDONED');
    assert.equal(store.readEvents(run).at(-1).type, 'run.abandoned');
  });
});

test('a process that exits mid-run closes the record as ERROR', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-runs-'));
  try {
    const { spawnSync } = require('child_process');
    spawnSync(process.execPath, ['-e', `
      const store = require(${JSON.stringify(path.join(__dirname, '../../run/store'))});
      const run = store.createRun({ kind: 'qb', request: 'x', repoPath: process.cwd(), runsDir: ${JSON.stringify(dir)} });
      store.installSignalHandlers(run);
      new Promise(() => {});   // event loop drains with the run unfinished
    `]);
    const [id] = fs.readdirSync(dir);
    const m = store.loadRun(id, dir).manifest;
    assert.equal(m.outcome, 'ERROR');
    assert.match(m.outcome_reason, /exited/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
