/**
 * QB-21: deadlines, cancellation and budgets.
 * - a hung model call ends at its per-call deadline (even if the transport ignores the abort);
 * - a total-run deadline cancels in-flight work, releases locks, and the final state names
 *   the interrupted stage (qb.js end-to-end);
 * - a stalled telemetry endpoint cannot hold the run;
 * - a child process TREE is terminated at its deadline (grandchildren included);
 * - local-model calls run concurrently, bounded; stage time and tokens are recorded.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const { mockFetch, ollamaReply } = require('../helpers/mocks');

/** Fails the test if `p` does not settle within `ms` (pre-fix: these hang). */
const within = (ms, p, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not finish within ${ms}ms`)), ms).unref())]);
const withEnv = async (vars, fn) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
/** A fetch that never answers; `respectSignal: false` also ignores the abort signal. */
function hungFetch({ respectSignal = true } = {}) {
  const original = global.fetch;
  const calls = [];
  global.fetch = (url, init = {}) => {
    calls.push(String(url));
    return new Promise((_, reject) => {
      if (respectSignal && init.signal) init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
  };
  return { calls, restore: () => { global.fetch = original; } };
}
const CRIT = [{ id: 'AC-1', criterion: 'README documents --verbose', kind: 'non_behavioral' }];
const DIFF = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,0 +1,1 @@\n+--verbose prints stages\n';

describe('per-call deadlines on model calls', () => {
  for (const respectSignal of [true, false]) {
    test(`a hung model (${respectSignal ? 'honours' : 'ignores'} abort) → each judge call ends at its deadline; the criterion is unresolved (pre-fix: hangs)`, async () => {
      const m = hungFetch({ respectSignal });
      try {
        await withEnv({ QB_MODEL_CALL_TIMEOUT_MS: '200' }, async () => {
          const { judgeAll } = require('../../verify/judge');
          const [r] = await within(4000, judgeAll(CRIT, DIFF), 'judgeAll');
          assert.equal(r.met, null);
          assert.equal(r.judgment_status, 'error');
          assert.match(r.evidence, /model call timed out after 200ms/);
        });
      } finally { m.restore(); }
    });
  }
  test('the intent compiler and the context enricher are bounded too (pre-fix: hang)', async () => {
    const m = hungFetch({ respectSignal: false });
    try {
      await withEnv({ QB_MODEL_CALL_TIMEOUT_MS: '200' }, async () => {
        const { compile } = require('../../intent/compiler');
        await assert.rejects(within(4000, compile('Add a clamp() function to src/math.js'), 'compile'), /model call timed out after 200ms/);
      });
    } finally { m.restore(); }
  });
});

describe('total-run deadline and cancellation', () => {
  test('the run budget aborts in-flight model calls, names the interrupted stage, and releases the judge-cache claim', async () => {
    const { openCache } = require('../../verify/judge-cache');
    const budget = require('../../lib/budget');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb21-cache-'));
    const m = hungFetch({ respectSignal: false });
    try {
      const run = budget.startRun({ deadlineMs: 300 });
      run.stage('L4 verification (attempt 1)');
      const { judgeAll } = require('../../verify/judge');
      const [r] = await within(4000, judgeAll(CRIT, DIFF, {}, new Map(), { cache: openCache(dir) }), 'judgeAll under a run deadline');
      assert.equal(r.met, null);
      assert.match(r.evidence, /run deadline \(300ms\) exceeded during L4 verification \(attempt 1\)/);
      assert.deepEqual(run.interrupted(), { stage: 'L4 verification (attempt 1)', deadline_ms: 300 });
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.lock')), [], 'the claim is released');
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json')), [], 'an interrupted judgment is not cached');
    } finally { budget.endRun(); m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('qb.js end-to-end: a hung model under QB_RUN_DEADLINE_MS ends CANCELLED, naming the stage; the run record survives (pre-fix: hangs)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb21-cli-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const env = { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_HANG: '1', QB_RUN_DEADLINE_MS: '1500' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--require', path.join(__dirname, '..', 'helpers', 'preload-ollama.js'), path.join(__dirname, '..', '..', 'qb.js'),
      'Add a clamp() function to src/math.js', '--repo', repo], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const code = await within(15000, new Promise((res) => child.on('exit', res)), 'qb.js');
      assert.notEqual(code, 0);
      const runs = fs.readdirSync(path.join(tmp, 'runs'));
      const m = JSON.parse(fs.readFileSync(path.join(tmp, 'runs', runs[0], 'manifest.json'), 'utf8'));
      assert.equal(m.outcome, 'CANCELLED');
      assert.match(m.outcome_reason, /run deadline \(1500ms\) exceeded during L1 intent/);
    } finally { child.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('telemetry is bounded and non-blocking', () => {
  test('a stalled metrics endpoint is abandoned at its deadline (pre-fix: awaited with no deadline)', async () => {
    const server = http.createServer(() => { /* accept, never answer */ });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const { sendMetrics } = require('../../lib/telemetry');
      const t0 = Date.now();
      const r = await within(4000, sendMetrics({ x: 1 }, { url: `http://127.0.0.1:${server.address().port}/api/metrics`, timeoutMs: 300 }), 'sendMetrics');
      assert.deepEqual(r, { sent: false, reason: 'timeout' });
      assert.ok(Date.now() - t0 < 2000);
    } finally { server.closeAllConnections(); server.close(); }
  });
});

describe('child process trees', () => {
  test('a timed-out command is killed with its whole process tree (pre-fix: only the direct child; the grandchild kept the pipe open)', async () => {
    const { runBounded } = require('../../lib/proc');
    const r = await within(5000, runBounded('sh', ['-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 300 }), 'runBounded');
    assert.equal(r.timedOut, true);
    const grandchild = Number(String(r.stdout).trim());
    assert.ok(grandchild > 0);
    await new Promise((res) => setTimeout(res, 100));
    assert.throws(() => process.kill(grandchild, 0), /ESRCH/, 'the grandchild was killed');
  });
  test('cancellation by signal kills the tree too', async () => {
    const { runBounded } = require('../../lib/proc');
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('run cancelled')), 200);
    const r = await within(5000, runBounded('sh', ['-c', 'sleep 30 & echo $!; wait'], { signal: ac.signal }), 'runBounded');
    assert.equal(r.cancelled, true);
    await new Promise((res) => setTimeout(res, 100));
    assert.throws(() => process.kill(Number(String(r.stdout).trim()), 0), /ESRCH/);
  });
});

describe('bounded concurrency and usage', () => {
  test('judge votes run concurrently, never more than QB_MODEL_CONCURRENCY at once (pre-fix: strictly sequential)', async () => {
    let inflight = 0;
    let peak = 0;
    const m = mockFetch(async () => {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 50));
      inflight--;
      return ollamaReply({ met: true, evidence: 'README documents --verbose' });
    });
    try {
      await withEnv({ QB_MODEL_CONCURRENCY: '2' }, async () => {
        const { judgeAll } = require('../../verify/judge');
        await judgeAll([...CRIT, { id: 'AC-2', criterion: 'README lists the flags', kind: 'non_behavioral' }], DIFF);
      });
      assert.equal(peak, 2);
      assert.equal(m.calls.length, 6);
    } finally { m.restore(); }
  });
  test('stage time, model calls and tokens are recorded', async () => {
    const budget = require('../../lib/budget');
    const m = mockFetch(() => ({ ...ollamaReply({ met: true, evidence: 'README documents --verbose' }), prompt_eval_count: 100, eval_count: 7 }));
    try {
      const run = budget.startRun({});
      run.stage('L4 verification (attempt 1)');
      const { judgeAll } = require('../../verify/judge');
      await judgeAll(CRIT, DIFF);
      const u = run.usage();
      const s = u.stages.find((x) => x.stage === 'L4 verification (attempt 1)');
      assert.ok(s && Number.isInteger(s.ms));
      assert.deepEqual([u.model.calls, u.model.prompt_tokens, u.model.completion_tokens, u.model.timeouts], [3, 300, 21, 0]);
    } finally { budget.endRun(); m.restore(); }
  });
});
