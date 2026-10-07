/**
 * QB-28 end to end in the real sandbox (QB_INTEGRATION=1, Docker): one paired A-vs-E trial.
 *   - both arms run through runArm (A: native prompt; E: QB's production pipeline, memory off),
 *     with a scripted agent stage in the real agent container;
 *   - both final patches are graded by the same external grader in the real sandbox;
 *   - the stored experiment regenerates a byte-identical report, and a tampered artifact is refused.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../../lib/sandbox/docker');
const { runSandboxed } = require('../../lib/sandbox/pipeline');
const { hardened } = require('../../lib/sandbox/workspace');
const { AGENT_IMAGE } = require('../../lib/sandbox/agent');
const { qualify } = require('../../bench/qualify');
const { GRADER_FILES } = require('../../bench/grader');
const { pinExperiment, loadExperiment } = require('../../bench/experiment');
const { runExperiment, taskEntries, armDefinitions } = require('../../bench/experiment-run');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { gradingFixture, IMPL } = require('../helpers/grading-fixture');

const ENABLED = process.env.QB_INTEGRATION === '1';
const ROOT = path.join(__dirname, '..', '..');
const ORACLE = { approved_by: 'qb-test-oracle', goal: 'formatDuration should show 30,000 ms as 30s',
  required_behavior: ['formatDuration(30000) returns "30s"'],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: 'formatDuration should show 30,000 ms as 30s' }], verification_plan: ['run the tests'], scope: { allowed_changes: ['**'] } };

/** A scripted agent in the real agent container: writes the correct implementation. */
const writer = (content) => (ws, egress, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
  ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'),
  '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=16m,uid=10001,gid=10001',
  '--entrypoint', 'sh', AGENT_IMAGE, '-c', `echo ${Buffer.from(content).toString('base64')} | base64 -d > /work/src/duration.js`,
], { waitTimeoutMs });

describe('QB-28: a paired A-vs-E trial through the real sandbox', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  let tmp; let f;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb28-int-')); f = gradingFixture(); });
  after(() => { f.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('both arms graded by the same grader; the report is byte-reproducible; tampering is refused', async () => {
    const stateDir = path.join(tmp, 'state'); fs.mkdirSync(stateDir);
    const sandbox = { stateDir, deadlines: { verify: 180_000 } };
    const qualification = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, sandbox,
      reference: f.patch('correct'), incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
    const spec = { ...f.spec, oracle: ORACLE, qualification };
    const { dir } = await pinExperiment({ dir: path.join(tmp, 'exps'), kind: 'exploratory', tasks: taskEntries([spec]), arms: armDefinitions(['A', 'E']),
      primary_comparison: ['A', 'E'], budget: { agent_time_ms: 300_000, trial_deadline_ms: 900_000, model_call_deadline_ms: 30_000, total_compute_controlled: false },
      repetitions: 1, graderFiles: GRADER_FILES, memory: { starting_store_sha256: null } });
    const m = mockFetch(ollamaReply({ met: true, evidence: 'renders 30s' }));
    try {
      await runExperiment(dir, { specs: { [spec.id]: spec }, runsDir: path.join(tmp, 'runs'),
        runSandboxed: (o) => runSandboxed({ ...o, stateDir, agentStage: writer(IMPL.correct) }),
        grader: { suitesRoot: f.suitesRoot, sandbox } });
    } finally { m.restore(); }
    const exp = loadExperiment(dir);
    assert.deepEqual(exp.trials.map((t) => [t.arm, t.status, t.grade_outcome]).sort(), [['A', 'completed', 'pass'], ['E', 'completed', 'pass']],
      JSON.stringify(exp.trials.map((t) => [t.arm, t.status, t.detail, t.grade && t.grade.reason])));
    assert.equal(exp.trials[0].grade.grader_sha256, exp.trials[1].grade.grader_sha256);
    // QB-29 re-review 2: each trial's evidence names the containers it actually launched (arm + grading),
    // every one from a pinned immutable image id resolved for THAT trial
    const realId = (await require('../../lib/sandbox/docker').op(['image', 'inspect', '-f', '{{.Id}}', require('../../lib/sandbox/agent').AGENT_IMAGE])).stdout.trim();
    for (const t of exp.trials) {
      const ids = new Set(Object.values(t.runtime.image_ids).map((x) => x.id));
      assert.equal(t.runtime.image_ids.agent.id, realId);
      assert.ok(t.runtime.launched.length >= 5, `${t.arm}: ${t.runtime.launched.length} launches recorded`);
      for (const l of t.runtime.launched) assert.ok(ids.has(l.image), `${t.arm}: ${l.container} ran ${l.image}`);
      assert.ok(t.runtime.launched.some((l) => l.image === realId), `${t.arm}: no agent-image launch recorded`);
    }
    const report = () => proc.run(process.execPath, [path.join(ROOT, 'bench/report.js'), dir, '--format', 'json']);
    const r1 = report(); const r2 = report();
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.stdout, r2.stdout, 'the report is not byte-reproducible');
    const patch = path.join(dir, exp.trials[0].artifacts['patch.diff'].path);
    fs.chmodSync(patch, 0o644); fs.appendFileSync(patch, '\n');
    const r3 = report();
    assert.notEqual(r3.status, 0);
    assert.match(r3.stderr + r3.stdout, /hash mismatch/);
  });
});
