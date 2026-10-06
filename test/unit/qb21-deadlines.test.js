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
      assert.deepEqual([u.model.attempted, u.model.completed, u.model.tokens.prompt, u.model.tokens.completion, u.model.tokens.status], [3, 3, 300, 21, 'complete']);
    } finally { budget.endRun(); m.restore(); }
  });
});

describe('QB-21 re-review: the run deadline also bounds the judge-cache claim wait', () => {
  const { openCache, judgmentKey } = require('../../verify/judge-cache');
  const budget = require('../../lib/budget');
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qb21-claim-'));

  test('senior repro: a waiter on a live claim returns at the run deadline, not after its own waitMs (pre-fix: 450 ms, timedOut)', async () => {
    const dir = tmpDir();
    try {
      const holder = openCache(dir, { waitMs: 450, pollMs: 20, heartbeatMs: 50 });
      const lock = await holder.acquire('same');
      const tokenBefore = JSON.parse(fs.readFileSync(path.join(dir, 'same.lock'), 'utf8')).token;
      const run = budget.startRun({ deadlineMs: 40 });
      run.stage('L4 verification (attempt 1)');
      const t0 = Date.now();
      const r = await openCache(dir, { waitMs: 450, pollMs: 20 }).acquire('same', { signal: run.signal });
      assert.ok(Date.now() - t0 < 300, `waited ${Date.now() - t0}ms`);
      assert.equal(r.cancelled, true);
      assert.match(r.reason.message, /run deadline \(40ms\) exceeded during L4 verification \(attempt 1\)/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'same.lock'), 'utf8')).token, tokenBefore, "the other owner's claim is untouched");
      lock.release();
    } finally { budget.endRun(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('verifier path: judgeAll behind a live claim ends at the run deadline — no model call, nothing cached, the claim kept', async () => {
    const dir = tmpDir();
    const { judgeAll, MODEL, SYSTEM_PROMPT } = require('../../verify/judge');
    const key = judgmentKey({ model: MODEL, prompt: SYSTEM_PROMPT, criterion: CRIT[0].criterion, kind: 'diff', bundle: null, text: DIFF });
    const lock = await openCache(dir, { heartbeatMs: 50 }).acquire(key);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'x' }));
    try {
      const run = budget.startRun({ deadlineMs: 150 });
      run.stage('L4 verification (attempt 1)');
      const [r] = await within(2000, judgeAll(CRIT, DIFF, {}, new Map(), { cache: openCache(dir) }), 'judgeAll behind a claim');
      assert.deepEqual([r.met, r.judgment_cache, m.calls.length], [null, 'cancelled', 0]);
      assert.match(r.evidence, /run deadline \(150ms\) exceeded during L4 verification/);
      assert.ok(fs.existsSync(path.join(dir, `${key}.lock`)));
      assert.ok(!fs.existsSync(path.join(dir, `${key}.json`)));
    } finally { lock.release(); budget.endRun(); m.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('qb.js end-to-end: run B waits on run A\'s live claim; B ends CANCELLED during L4 at its deadline, A\'s claim intact (pre-fix: B waits 15 min)', async () => {
    const ROOT = path.join(__dirname, '..', '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb21-e2e-'));
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    require('child_process').execFileSync('git', ['init', '-q'], { cwd: repo });
    require('child_process').execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
    const file = path.join(tmp, 'contract.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'Document --verbose', required_behavior: ['README documents --verbose'],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'README documents the --verbose flag', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
      verification_plan: ['read README'], requirements: [{ id: 'R-1', quote: 'Document --verbose' }], scope: { allowed_changes: ['**'] } }));
    const script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [{ write: 'docs/v.md', content: '--verbose prints stages\n' }] }));
    const cacheDir = path.join(tmp, 'judge-cache');
    const env = (extra) => { const e = { ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_JUDGE_CACHE_DIR: cacheDir, ...extra }; delete e.NODE_TEST_CONTEXT; return e; };
    const args = ['--require', path.join(ROOT, 'test', 'helpers', 'preload-ollama.js'), '--require', path.join(ROOT, 'test', 'helpers', 'preload-fake-sandbox.js'),
      path.join(ROOT, 'qb.js'), 'Document --verbose', '--repo', repo, '--agent', 'claude-code', '--no-llm-context', '--max-retries', '1', '--contract-file', file];
    const a = spawn(process.execPath, args, { env: env({ QB_TEST_HANG: '1', QB_FAKE_AGENT_COUNTER: path.join(tmp, 'ca') }), stdio: ['ignore', 'pipe', 'pipe'] });
    let b;
    try {
      await within(20000, new Promise((res) => a.stdout.on('data', (d) => { if (String(d).includes('QB_TEST_HANGING')) res(); })), 'run A reaching the judge');
      const lockA = fs.readdirSync(cacheDir).find((f) => f.endsWith('.lock'));
      assert.ok(lockA, 'run A holds a judge-cache claim');
      const tokenA = JSON.parse(fs.readFileSync(path.join(cacheDir, lockA), 'utf8')).token;
      b = spawn(process.execPath, args, { env: env({ QB_RUN_DEADLINE_MS: '2500', QB_FAKE_AGENT_COUNTER: path.join(tmp, 'cb') }), stdio: ['ignore', 'pipe', 'pipe'] });
      const code = await within(20000, new Promise((res) => b.on('exit', res)), 'run B');
      assert.equal(code, 3);
      const runs = fs.readdirSync(path.join(tmp, 'runs')).map((id) => JSON.parse(fs.readFileSync(path.join(tmp, 'runs', id, 'manifest.json'), 'utf8')));
      const cancelled = runs.find((m) => m.outcome === 'CANCELLED');
      assert.ok(cancelled, JSON.stringify(runs.map((m) => [m.outcome, m.outcome_reason])));
      assert.match(cancelled.outcome_reason, /run deadline \(2500ms\) exceeded during L4 verification \(attempt 1\)/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, lockA), 'utf8')).token, tokenA, "run A's claim is intact");
    } finally { a.kill('SIGKILL'); if (b) b.kill('SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); }
  });
});

describe('QB-21 re-review: usage is honest — unknown is never zero', () => {
  const budget = require('../../lib/budget');
  const { modelCall } = budget;
  const call = () => modelCall('http://127.0.0.1:11434/api/chat', { model: 'm', messages: [] });

  test('no token counts reported → tokens unknown (null), not 0; attempted/completed counted (pre-fix: 0 tokens)', async () => {
    const m = mockFetch({ message: { content: 'x' }, model: 'deepseek-r1:7b' });
    try {
      const run = budget.startRun({});
      await call();
      const u = run.usage();
      assert.deepEqual([u.model.attempted, u.model.completed, u.model.failed], [1, 1, 0]);
      assert.deepEqual(u.model.tokens, { status: 'unknown', prompt: null, completion: null, calls_reporting: 0, calls_not_reporting: 1 });
      assert.deepEqual(u.model.models_reported, { 'deepseek-r1:7b': 1 });
    } finally { budget.endRun(); m.restore(); }
  });
  test('mixed known/unknown → partial: known sums are labelled as covering only the reporting calls', async () => {
    let n = 0;
    const m = mockFetch(() => (++n === 1 ? { message: { content: 'x' }, prompt_eval_count: 10, eval_count: 2 } : { message: { content: 'x' } }));
    try {
      const run = budget.startRun({});
      await call(); await call();
      assert.deepEqual(run.usage().model.tokens, { status: 'partial', prompt: 10, completion: 2, calls_reporting: 1, calls_not_reporting: 1 });
    } finally { budget.endRun(); m.restore(); }
  });
  test('failures, timeouts and cancellations are counted as attempted, not hidden', async () => {
    const original = global.fetch;
    try {
      const run = budget.startRun({ deadlineMs: 400 });
      global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
      await assert.rejects(call());
      global.fetch = () => new Promise(() => {});
      await withEnv({ QB_MODEL_CALL_TIMEOUT_MS: '100' }, () => assert.rejects(call(), /timed out/));
      await assert.rejects(call(), /run deadline/);
      const u = run.usage();
      assert.deepEqual([u.model.attempted, u.model.completed, u.model.failed, u.model.timed_out, u.model.cancelled], [3, 0, 1, 1, 1]);
      assert.equal(u.model.tokens.status, 'none');
    } finally { global.fetch = original; budget.endRun(); }
  });
  test('agent usage is explicitly unknown with a reason; deadlines, versions and cost carry provenance', () => {
    const run = budget.startRun({ deadlineMs: 60000, agent: { type: 'claude-code', version: '2.1.0' }, sandboxDeadlines: { agent: 1800000 } });
    try {
      const u = run.usage();
      assert.deepEqual(u.agent.identity, { type: 'claude-code', version: '2.1.0' });
      assert.deepEqual([u.agent.tokens, u.agent.cost_usd, u.agent.usage_status], [null, null, 'unknown']);
      assert.match(u.agent.reason, /--output-format text/);
      assert.equal(u.deadlines.run_ms, 60000);
      assert.equal(u.deadlines.sandbox_stage_ms.agent, 1800000);
      assert.ok(Number.isInteger(u.deadlines.model_call_ms) && Number.isInteger(u.deadlines.model_concurrency));
      assert.equal(u.cost.total.status, 'unknown');
      assert.ok(Array.isArray(u.unsupported) && u.unsupported.some((x) => /token budget/.test(x)));
    } finally { budget.endRun(); }
  });
});
