/**
 * QB-30 dev pilot on GitHub runners: one experiment is pinned ONCE, then parallel jobs each run a
 * shard of it (`experiment-run --resume <dir> --shard i/n`) and a final job merges the recorded
 * trials. A shard is a set of WHOLE tasks (every arm and repetition of a task stays together, so
 * pairing is never split across machines); assignment is by sorted task id, deterministic, and
 * every task belongs to exactly one shard.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runExperiment, taskEntries, armDefinitions, parseShard, taskShards } = require('../../bench/experiment-run');
const { createExperiment, loadExperiment } = require('../../bench/experiment');
const { qualify } = require('../../bench/qualify');
const { GRADER_FILES } = require('../../bench/grader');
const budget = require('../../lib/budget');
const S = require('../../bench/schemas');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

describe('QB-30: shard assignment', () => {
  test('whole tasks, by sorted id, every task in exactly one shard, independent of input order', () => {
    const ids = ['PW-02', 'AV-01', 'LM-07', 'FJ-03', 'AV-02', 'FP-05', 'PW-01'];
    const a = taskShards(ids, 3); const b = taskShards([...ids].reverse(), 3);
    assert.deepEqual(a, b);
    const all = Object.values(a).flat().sort();
    assert.deepEqual(all, [...ids].sort());
    // sorted: AV-01 AV-02 FJ-03 FP-05 LM-07 PW-01 PW-02 → round-robin over 3 shards
    assert.deepEqual(a, { 1: ['AV-01', 'FP-05', 'PW-02'], 2: ['AV-02', 'LM-07'], 3: ['FJ-03', 'PW-01'] });
    assert.equal(new Set(all).size, ids.length);
  });
  test('parseShard accepts i/n with 1 ≤ i ≤ n and refuses anything else', () => {
    assert.deepEqual(parseShard('2/5'), { index: 2, count: 5 });
    for (const bad of ['0/3', '4/3', '1/0', 'x', '1-3', '', '1/3/2', '-1/3']) assert.throws(() => parseShard(bad), /--shard/, bad);
  });
});

// ── runExperiment honours the shard ─────────────────────────────────────────
const report = (pass) => [
  { type: 'qb:start', format: 'qb-node-test-events/1' },
  { type: pass ? 'test:pass' : 'test:fail', name: 'visible', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false },
  { type: 'test:summary', file: null, counts: { tests: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 }, success: pass },
  { type: 'qb:end' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';
const verification = (pass) => ({ status: 'ran', state: pass ? 'completed' : 'execution_error', exit_code: pass ? 0 : 1, report: report(pass), report_error: null, output: '' });
const graderRunner = () => async (o) => {
  const added = String(o.applyPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') + '\n';
  return { status: 'completed', changes: [{ file: 'src/duration.js' }], sandbox: { stages: { agent: { exit_code: 0 } }, verification: verification(added === IMPL.correct) } };
};
const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
const PROBES = { probes: { git: (args) => Buffer.from(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''), claudeVersion: () => 'unknown',
  agentVersion: () => 't', agentConfig: () => ({}), images: () => ({}), models: () => [], ensureImages: async () => {} } };

let tmp; const fixtures = [];
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30-shard-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });

describe('QB-30: runExperiment runs only its shard', () => {
  test('a single-task experiment: shard 2/2 records nothing; shard 1/2 records every arm of the task', async () => {
    const f = gradingFixture(); fixtures.push(f);
    const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: graderRunner(), reference: f.patch('correct'),
      incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
    const spec = { ...f.spec, oracle: ORACLE, qualification: q };
    const pins = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
      images: {}, node: process.version, grader: { files: Object.fromEntries(GRADER_FILES.map((g) => [g, S.sha256File(path.join(__dirname, '../..', g))])) }, models: [] };
    const { dir } = createExperiment({ dir: path.join(tmp, 'exps'), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E']),
      primary_comparison: ['A', 'E'], budget: { agent_time_ms: 60_000, trial_deadline_ms: 120_000, model_call_deadline_ms: 30_000, total_compute_controlled: false },
      repetitions: 1, pins, memory: { starting_store_sha256: null } });
    const correct = f.patch('correct'); let agentCalls = 0;
    const agent = async () => { agentCalls++; return { status: 'completed', diff: correct, changes: [{ file: 'src/duration.js', status: 'M', additions: 3, deletions: 1 }],
      unsupported_changes: [], sandbox: { isolation: 'none-test-only', verification: verification(true) } }; };
    const m = mockFetch(ollamaReply({ met: true, evidence: 'renders 30s' }));
    const opts = (shard) => ({ specs: { [spec.id]: spec }, runSandboxed: agent, runsDir: path.join(tmp, 'runs'), preflight: PROBES,
      grader: { suitesRoot: f.suitesRoot, runSandboxed: graderRunner() }, shard });
    try {
      await runExperiment(dir, opts({ index: 2, count: 2 }));
      assert.equal(agentCalls, 0, 'the other shard launched no agent');
      assert.equal(loadExperiment(dir).trials.length, 0);
      await runExperiment(dir, opts({ index: 1, count: 2 }));
      assert.deepEqual(loadExperiment(dir).trials.map((t) => t.arm).sort(), ['A', 'E']);
      const before = agentCalls;
      await runExperiment(dir, opts({ index: 1, count: 2 }));     // resume: recorded trials are never rerun
      assert.equal(agentCalls, before);
    } finally { m.restore(); budget.endRun(); }
  });
});
