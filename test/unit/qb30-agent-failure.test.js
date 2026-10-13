/**
 * QB-30 screen (GitHub run 38409518314): in the last shard Claude Code exited after ~1 s in 7 of 8
 * trials (FY-07, FY-14). The empty patch was graded, so both arms recorded 4 "fails" that were
 * never attempts, and the report showed 28/28 scored with no attrition. Protocol §4: agent errors
 * and timeouts are attrition, never a score. These tests run the real experiment runner
 * (runExperiment → runArm → grader) with an agent that fails the way that shard did.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runExperiment, taskEntries, armDefinitions } = require('../../bench/experiment-run');
const { createExperiment, loadExperiment } = require('../../bench/experiment');
const { agentFailure } = require('../../bench/arms');
const { GRADER_FILES } = require('../../bench/grader');
const { qualify } = require('../../bench/qualify');
const budget = require('../../lib/budget');
const S = require('../../bench/schemas');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };
const PROBES = { git: (args) => Buffer.from(args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : ''), claudeVersion: () => 'unknown',
  agentVersion: () => 't', agentConfig: () => ({}), images: () => ({}), models: () => [], ensureImages: async () => {} };
const LIMIT = 'Claude AI usage limit reached|1791900000';

const report = (pass) => [
  { type: 'qb:start', format: 'qb-node-test-events/1' },
  { type: pass ? 'test:pass' : 'test:fail', name: 'hidden', nesting: 0, path: [], file: '/verify/test/a.test.js', kind: 'test', skip: false, todo: false,
    ...(pass ? {} : { failureType: 'testCodeFailure', error: 'expected 30s' }) },
  { type: 'test:summary', file: null, counts: { tests: 1, passed: pass ? 1 : 0, failed: pass ? 0 : 1, cancelled: 0, skipped: 0, todo: 0 }, success: pass },
  { type: 'qb:end' },
].map((e) => JSON.stringify(e)).join('\n') + '\n';
/** The grading stand-in (as in qb28-arms): passes exactly when the patch installs the correct implementation. */
const graderRunner = (calls = []) => async (o) => {
  calls.push(o);
  const added = String(o.applyPatch || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join('\n') + '\n';
  const pass = added === IMPL.correct;
  return { status: 'completed', changes: [{ file: 'src/duration.js' }], sandbox: { stages: { agent: { exit_code: 0 } },
    verification: { status: 'ran', state: pass ? 'completed' : 'execution_error', exit_code: pass ? 0 : 1, report: report(pass), report_error: null, output: '' } } };
};

let tmp; const fixtures = [];
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30af-')); process.env.QB_JUDGE_CACHE_DIR = path.join(tmp, 'jc'); });
after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); delete process.env.QB_JUDGE_CACHE_DIR; });

/** One experiment (A and E, 1 repetition) with the given agent; returns the trials and the grader calls. */
async function experiment(agent, label) {
  const f = gradingFixture(); fixtures.push(f);
  const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: graderRunner(), reference: f.patch('correct'),
    incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
  const spec = { ...f.spec, oracle: ORACLE, qualification: q };
  const pins = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
    images: {}, node: process.version, grader: { files: Object.fromEntries(GRADER_FILES.map((g) => [g, S.sha256File(path.join(__dirname, '../..', g))])) }, models: [] };
  const { dir } = createExperiment({ dir: path.join(tmp, label), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E']),
    primary_comparison: ['A', 'E'], budget: { agent_time_ms: 60_000, trial_deadline_ms: 120_000, model_call_deadline_ms: 30_000, total_compute_controlled: false },
    repetitions: 1, pins, memory: { starting_store_sha256: null } });
  const graderCalls = [];
  const grader = graderRunner(graderCalls);
  const m = mockFetch(ollamaReply({ met: false, evidence: 'no change', repair: 'Render whole seconds' }));
  try {
    await runExperiment(dir, { specs: { [spec.id]: spec }, runSandboxed: agent, runsDir: path.join(tmp, `${label}-runs`), preflight: { probes: PROBES },
      grader: { suitesRoot: f.suitesRoot, runSandboxed: grader } });
  } finally { m.restore(); budget.endRun(); }
  return { trials: loadExperiment(dir).trials, graderCalls };
}

const crashed = (status, extra = {}) => async () => ({ status, diff: null, changes: [], unsupported_changes: [], exit_code: 1, stderr_tail: LIMIT,
  sandbox: { isolation: 'none-test-only', stages: { agent: { state: status, exit_code: 1, duration_ms: 1047 } } }, ...extra });

describe('QB-30: an agent that fails is attrition, never a graded fail', () => {
  test('agent exits non-zero after ~1 s (the screen\'s shard 7): A and E are agent_error, ungraded, with the agent\'s stderr', async () => {
    const { trials, graderCalls } = await experiment(crashed('execution_error'), 'crash');
    assert.deepEqual(trials.map((t) => [t.arm, t.status, t.grade_outcome]).sort(), [['A', 'agent_error', null], ['E', 'agent_error', null]]);
    assert.equal(graderCalls.length, 0, 'an empty patch from a crashed agent is never graded');
    for (const t of trials) assert.match(t.detail, /agent execution_error \(exit 1\): Claude AI usage limit reached/);
  });

  test('agent timeout is recorded as timeout (attrition)', async () => {
    const { trials, graderCalls } = await experiment(crashed('timeout'), 'timeout');
    assert.deepEqual(trials.map((t) => [t.arm, t.status]).sort(), [['A', 'timeout'], ['E', 'timeout']]);
    assert.equal(graderCalls.length, 0);
  });

  test('control: an agent that runs to completion and changes nothing is still graded (a real fail)', async () => {
    const quiet = async () => ({ status: 'no_change', diff: null, changes: [], unsupported_changes: [], exit_code: 0,
      sandbox: { isolation: 'none-test-only', stages: { agent: { state: 'completed', exit_code: 0, duration_ms: 30000 } } } });
    const { trials, graderCalls } = await experiment(quiet, 'nochange');
    assert.deepEqual(trials.map((t) => [t.arm, t.status, t.grade_outcome]).sort(), [['A', 'completed', 'fail'], ['E', 'completed', 'fail']]);
    assert.equal(graderCalls.length, 2);
  });

  test('agentFailure: only failed executions; completed and no_change are not failures', () => {
    for (const s of ['completed', 'no_change', 'dry_run']) assert.equal(agentFailure({ status: s }), null, s);
    for (const s of ['execution_error', 'oom', 'cancelled', 'setup_failed']) assert.equal(agentFailure({ status: s }).status, 'agent_error', s);
    assert.equal(agentFailure({ status: 'timeout' }).status, 'timeout');
    assert.equal(agentFailure(null), null);
  });
});
