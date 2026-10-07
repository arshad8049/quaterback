/**
 * QB-28: arms A–F through one API, equal agent-time budgets, exact memory isolation, the
 * same external grader for every arm, and QB's production orchestration (no benchmark copy).
 * Agents are scripted stand-ins for the sandbox (no Docker, no paid calls); the judge is a
 * mocked model; grading uses a stand-in sandbox that reports a synthetic node:test report.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ARMS, runArm } = require('../../bench/arms');
const { runExperiment, taskEntries, armDefinitions } = require('../../bench/experiment-run');
const { createExperiment, loadExperiment } = require('../../bench/experiment');
const { qualify } = require('../../bench/qualify');
const { GRADER_FILES } = require('../../bench/grader');
const runStore = require('../../run/store');
const budget = require('../../lib/budget');
const S = require('../../bench/schemas');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

// ── stand-ins ────────────────────────────────────────────────────────────────
const report = (pass) => [
  { type: 'qb:start', format: 'qb-node-test-events/1' },
  { type: pass ? 'test:pass' : 'test:fail', name: 'visible', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false,
    ...(pass ? {} : { failureType: 'testCodeFailure', error: 'expected 30s' }) },
  { type: 'test:summary', file: null, counts: { tests: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 }, success: pass },
  { type: 'qb:end' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';
const verification = (pass, output = '') => ({ status: 'ran', state: pass ? 'completed' : 'execution_error', exit_code: pass ? 0 : 1, report: report(pass), report_error: null, output });
const DIFF = (body) => `diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1 +1 @@\n-x\n+${body}\n`;

/** A scripted agent: one entry per invocation ({ diff, pass, ms }); records each call. */
function scriptedAgent(steps, calls = []) {
  return async (o) => {
    const s = steps[Math.min(calls.length, steps.length - 1)];
    calls.push({ briefing: o.briefing, agentDeadline: o.deadlines && o.deadlines.agent });
    if (s.ms) { const until = Date.now() + s.ms; while (Date.now() < until) { /* spend agent time */ } }
    return { status: 'completed', diff: DIFF(s.diff), changes: [{ file: 'src/duration.js', status: 'M', additions: 1, deletions: 1 }],
      unsupported_changes: [], sandbox: { isolation: 'none-test-only', verification: verification(s.pass, `visible output ${calls.length}`) } };
  };
}

/** The grading stand-in: the patch arrives as o.applyPatch (applied in the sandbox, never on the
 *  host); it passes exactly when the patch installs the correct implementation. */
const graderRunner = (calls = []) => async (o) => {
  calls.push(o);
  const added = String(o.applyPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') + '\n';
  const pass = added === IMPL.correct;
  return { status: 'completed', changes: [{ file: 'src/duration.js' }], sandbox: { stages: { agent: { exit_code: 0 } }, verification: verification(pass) } };
};

const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };

let tmp; const fixtures = [];
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb28-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });

function armEnv(spec) {
  const f = gradingFixture(); fixtures.push(f);
  const runsDir = path.join(tmp, `runs-${fixtures.length}`);
  const run = runStore.createRun({ kind: 'bench-arm', request: 'x', repoPath: f.repo.dir, baseSha: f.repo.head(), runsDir });
  return { f, run, spec: { ...(spec || f.spec), oracle: ORACLE } };
}
const NO = ollamaReply({ met: false, evidence: 'still renders ms', repair: 'Render whole seconds as <s>s' });

describe('QB-28: the arm table', () => {
  test('six arms, each adding exactly one thing over the previous; A vs E is the primary comparison', () => {
    const order = ['A', 'B', 'C', 'D', 'E', 'F'];
    assert.deepEqual(Object.keys(ARMS), order);
    const fields = ['contract', 'feedback', 'context', 'memory', 'max_attempts'];
    const diff = (a, b) => fields.filter((k) => a[k] !== b[k]);
    assert.deepEqual(diff(ARMS.A, ARMS.B), ['feedback', 'max_attempts']);   // the retry loop: feedback + attempts
    assert.deepEqual(diff(ARMS.B, ARMS.C), ['contract']);
    assert.deepEqual(diff(ARMS.C, ARMS.D), ['context']);
    assert.deepEqual(diff(ARMS.D, ARMS.E), ['feedback']);
    assert.deepEqual(diff(ARMS.E, ARMS.F), ['memory']);
    for (const a of Object.values(ARMS)) S.ArmDefinition.parse(a);
  });
});

describe('QB-28: equal agent-time budgets', () => {
  test('pre-fix: the baseline got one 8-minute invocation while the QB arm got up to 3 invocations of its default agent deadline', async () => {
    const { runBaseline } = require('../../bench/baseline');
    const calls = [];
    const { approve } = require('../../intent/contract-state');
    const { contractFromObject } = require('../../intent/compiler');
    const c = approve(contractFromObject({ ...ORACLE, clarifying_question: null }, ORACLE.goal), { via: 'test' });
    await runBaseline('x', tmp, { contract: c, runSandboxed: scriptedAgent([{ diff: 'a', pass: true }], calls) });
    assert.equal(calls[0].agentDeadline, 8 * 60 * 1000);   // the legacy baseline, kept only for bench/run.js
    const { DEFAULT_DEADLINES } = require('../../lib/sandbox/pipeline');
    assert.notEqual(3 * DEFAULT_DEADLINES.agent, 8 * 60 * 1000);
  });

  test('every arm gets the same total agent time: each invocation receives what remains; none starts once it is spent', async () => {
    for (const arm of ['A', 'B', 'E']) {
      const { f, run, spec } = armEnv();
      const calls = [];
      const m = mockFetch(NO);
      try {
        const r = await runArm({ arm, spec, repoPath: f.repo.dir, run, baseSha: f.repo.head(), agentTimeMs: 150, judgeCache: path.join(tmp, 'jc'),
          runSandboxed: scriptedAgent([{ diff: 'a', pass: false, ms: 60 }, { diff: 'b', pass: false, ms: 60 }, { diff: 'c', pass: false, ms: 60 }], calls) });
        assert.equal(calls[0].agentDeadline, 150, arm);
        for (let i = 1; i < calls.length; i++) assert.ok(calls[i].agentDeadline <= 150 - 60 * i + 10, `${arm}: invocation ${i + 1} got ${calls[i].agentDeadline}`);
        assert.ok(r.agent_ms <= 150 + 60, `${arm}: agent_ms ${r.agent_ms}`);
        if (arm === 'A') assert.equal(calls.length, 1);
        else assert.ok(calls.length >= 2 && calls.length <= 3, `${arm}: ${calls.length} invocations`);
      } finally { m.restore(); }
    }
  });

  test('a manifest cannot give arms different agent time: the budget is one value, and extra per-arm fields are refused', () => {
    const b = S.Experiment.shape.budget;
    assert.ok(b.safeParse({ agent_time_ms: 1000, trial_deadline_ms: 5000, model_call_deadline_ms: 100, total_compute_controlled: false }).success);
    assert.ok(!b.safeParse({ agent_time_ms: 1000, per_arm: { A: 480000, E: 1800000 }, trial_deadline_ms: 5000, model_call_deadline_ms: 100, total_compute_controlled: false }).success);
    assert.ok(!S.ArmDefinition.safeParse({ ...ARMS.A, agent_time_ms: 480000 }).success);
  });
});

describe('QB-28: feedback per arm', () => {
  test('B retries on the repository\'s own visible test output and stops when the visible tests pass (never the hidden grader)', async () => {
    const { f, run, spec } = armEnv();
    const calls = [];
    const r = await runArm({ arm: 'B', spec, repoPath: f.repo.dir, run, agentTimeMs: 60_000,
      runSandboxed: scriptedAgent([{ diff: 'a', pass: false }, { diff: 'b', pass: true }], calls) });
    assert.equal(calls.length, 2);
    assert.doesNotMatch(calls[0].briefing, /Previous attempt/);
    assert.match(calls[1].briefing, /project's own tests did not pass/);
    assert.match(calls[1].briefing, /visible output 1/);
    assert.doesNotMatch(calls[1].briefing, /30,000 ms is 30s|test\/hidden/);
    assert.equal(r.patch, DIFF('b'));
  });

  test('A sees only the prompt; C sees the approved contract; D adds QB context', async () => {
    const seen = {};
    for (const arm of ['A', 'C', 'D']) {
      const { f, run, spec } = armEnv(); const calls = [];
      await runArm({ arm, spec, repoPath: f.repo.dir, run, agentTimeMs: 60_000, noLlmContext: true, runSandboxed: scriptedAgent([{ diff: 'a', pass: true }], calls) });
      seen[arm] = calls[0].briefing;
    }
    assert.match(seen.A, /^formatDuration should show 30,000 ms as 30s/);
    assert.doesNotMatch(seen.A, /AC-1|acceptance/i);
    assert.match(seen.C, /AC-1/);
    assert.ok(seen.D.length > seen.C.length, 'D adds the context package');
    assert.match(seen.D, /src\/duration\.js/);
  });
});

describe('QB-28: memory isolation', () => {
  test('memory OFF (E) reads and writes nothing — not even the default store', async () => {
    const mem = path.join(tmp, 'default-mem'); fs.mkdirSync(mem);
    const prev = process.env.QB_MEMORY_DIR; process.env.QB_MEMORY_DIR = mem;
    const { f, run, spec } = armEnv();
    const m = mockFetch(NO);
    try {
      const r = await runArm({ arm: 'E', spec, repoPath: f.repo.dir, run, agentTimeMs: 60_000, noLlmContext: true, judgeCache: path.join(tmp, 'jc'),
        runSandboxed: scriptedAgent([{ diff: 'a', pass: false }, { diff: 'b', pass: false }]) });
      assert.deepEqual(r.memory, { mode: 'off', store_sha256_before: null, recall_calls: 0, persist_calls: 0 });
      assert.deepEqual(fs.readdirSync(mem), [], 'memory-off wrote to the default memory store');
    } finally { m.restore(); if (prev === undefined) delete process.env.QB_MEMORY_DIR; else process.env.QB_MEMORY_DIR = prev; }
  });

  test('memory ON (F): L5 is actually called; each trial gets its own copy of the frozen start; the start never changes', async () => {
    const start = path.join(tmp, 'mem-start'); fs.mkdirSync(start); fs.writeFileSync(path.join(start, 'README'), 'frozen start\n');
    const sha = S.treeHash(start);
    const results = [];
    for (let i = 0; i < 2; i++) {
      const { f, run, spec } = armEnv();
      const m = mockFetch(NO);
      try {
        results.push(await runArm({ arm: 'F', spec, repoPath: f.repo.dir, run, agentTimeMs: 60_000, noLlmContext: true, judgeCache: path.join(tmp, 'jc'),
          memoryStart: { store: start, sha256: sha }, runSandboxed: scriptedAgent([{ diff: `a${i}`, pass: false }, { diff: `b${i}`, pass: false }]) }));
      } finally { m.restore(); }
    }
    for (const r of results) {
      assert.equal(r.memory.mode, 'on');
      assert.equal(r.memory.store_sha256_before, sha, 'every memory-on trial starts from the same frozen store');
      assert.ok(r.memory.recall_calls >= 2, `recall calls: ${r.memory.recall_calls}`);
      assert.equal(r.memory.persist_calls, 1);
    }
    assert.equal(S.treeHash(start), sha, 'the frozen starting store was modified');
    await assert.rejects(() => { const { f, run, spec } = armEnv(); return runArm({ arm: 'F', spec, repoPath: f.repo.dir, run, agentTimeMs: 1000, memoryStart: { store: start, sha256: 'f'.repeat(64) }, runSandboxed: scriptedAgent([{ diff: 'a', pass: true }]) }); }, /does not match the manifest hash/);
  });
});

describe('QB-28: one experiment, every arm graded by the same external grader', () => {
  test('A, E and F run through runArm; every completed arm is graded (spy); results are recorded and reported', async () => {
    const f = gradingFixture(); fixtures.push(f);
    const graderCalls = [];
    const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: graderRunner(), reference: f.patch('correct'),
      incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
    const spec = { ...f.spec, oracle: ORACLE, qualification: q };
    const pins = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
      images: {}, node: process.version, grader: { files: Object.fromEntries(GRADER_FILES.map((g) => [g, S.sha256File(path.join(__dirname, '../..', g))])) }, models: [] };
    const { dir } = createExperiment({ dir: path.join(tmp, 'exps'), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E', 'F']),
      primary_comparison: ['A', 'E'], budget: { agent_time_ms: 60_000, trial_deadline_ms: 120_000, model_call_deadline_ms: 30_000, total_compute_controlled: false },
      repetitions: 1, pins, memory: { starting_store_sha256: null } });
    const correct = f.patch('correct');
    const agent = async (o) => ({ status: 'completed', diff: correct, changes: [{ file: 'src/duration.js', status: 'M', additions: 3, deletions: 1 }], unsupported_changes: [],
      sandbox: { isolation: 'none-test-only', verification: verification(true) } });
    const m = mockFetch(ollamaReply({ met: true, evidence: 'renders 30s' }));
    try {
      await runExperiment(dir, { specs: { [spec.id]: spec }, runSandboxed: agent, runsDir: path.join(tmp, 'exp-runs'),
        grader: { suitesRoot: f.suitesRoot, runSandboxed: graderRunner(graderCalls) } });
    } finally { m.restore(); budget.endRun(); }
    const exp = loadExperiment(dir);
    assert.deepEqual(exp.trials.map((t) => [t.arm, t.status, t.grade_outcome]).sort(), [['A', 'completed', 'pass'], ['E', 'completed', 'pass'], ['F', 'completed', 'pass']]);
    assert.equal(graderCalls.length, 3, 'the external grader ran once per arm');
    for (const call of graderCalls) assert.deepEqual(Object.keys(call).sort(), ['applyPatch', 'baseTests', 'briefing', 'noAgent', 'repoPath', 'testCommand', 'verify']);
    const F = exp.trials.find((t) => t.arm === 'F');
    assert.ok(F.memory.recall_calls > 0 && F.memory.persist_calls === 1);
    assert.equal(exp.trials.find((t) => t.arm === 'E').memory.persist_calls, 0);
    for (const t of exp.trials) {
      assert.equal(typeof t.usage.agent_ms, 'number');
      assert.equal(t.usage.tokens, 'unknown');           // the agent reports no tokens — never 0
      assert.ok(t.artifacts['usage.json'] && t.artifacts['run.json']);
    }
    assert.equal(exp.trials.find((t) => t.arm === 'A').usage.model_calls, 0);
    assert.ok(exp.trials.find((t) => t.arm === 'E').usage.model_calls > 0, 'QB\'s own model calls are recorded');
  });

  test('bench/run.js no longer carries its own copy of the attempt loop: it runs lib/qb-pipeline.js', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../bench/run.js'), 'utf8');
    assert.match(src, /require\('\.\.\/lib\/qb-pipeline'\)/);
    assert.doesNotMatch(src, /\borchestrate\(|\brouteRepair\(/);
  });
});
