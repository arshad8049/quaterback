/**
 * QB-30: the evaluation protocol in the harness.
 *   - holdout tasks run only under an approval that names the exact protocol and holdout-set
 *     hashes (an approver name alone is not evidence); a protocol edited after approval, or a
 *     changed holdout set, is refused — before any agent work;
 *   - the execution order is randomized, paired and reproducible from its seed;
 *   - the analysis uses the TASK as the unit (trials nested, tasks clustered by repository),
 *     a cluster bootstrap, strata, and attrition next to completion — never McNemar over rows.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const S = require('../../bench/schemas');
const { seededOrder, holdoutGate } = require('../../bench/plan');
const { taskEffects, clusterBootstrap, analyze } = require('../../bench/stats');
const { createExperiment } = require('../../bench/experiment');
const { runExperiment } = require('../../bench/experiment-run');
const { ARMS } = require('../../bench/arms');

const H = (c) => c.repeat(64);
const T0 = '2026-10-08T00:00:00.000Z';
const task = (id, split, repository = 'repo-a', type = 'bug_fix', v = 1) => ({ id, version: v, spec_sha256: S.hashOf({ id, v }), split,
  repo_commit: 'c'.repeat(40), lockfiles: {}, stratum: { type, repository } });
const PINS = { qb: { commit: 'a'.repeat(40), dirty: false, dirty_patch_sha256: null }, agent: { name: 'claude-code', adapter_version: 't', cli_version: 'unknown' },
  images: {}, node: process.version, grader: { files: {} }, models: [] };
const BUDGET = { agent_time_ms: 1000, trial_deadline_ms: 5000, model_call_deadline_ms: 100, total_compute_controlled: false };

let tmp, qbRoot, protocolSha;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30-'));
  qbRoot = path.join(tmp, 'qb'); fs.mkdirSync(path.join(qbRoot, 'docs/bench'), { recursive: true });
  fs.writeFileSync(path.join(qbRoot, 'docs/bench/protocol.md'), '# protocol v1\n');
  protocolSha = S.sha256File(path.join(qbRoot, 'docs/bench/protocol.md'));
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
/** A manifest object (as read back) for gate tests. */
function manifest({ kind = 'official', tasks, approval = null, protocol = { path: 'docs/bench/protocol.md', sha256: protocolSha } }) {
  return { experiment_id: 'exp-gate', kind, tasks, protocol, approval };
}
const approvalFor = (tasks, over = {}) => ({ approver: 'independent reviewer', approved_at: T0, protocol_sha256: protocolSha, holdout_set_sha256: S.holdoutSetHash(tasks), ...over });

describe('QB-30: the holdout gate', () => {
  const tasks = [task('D-1', 'dev'), task('H-1', 'holdout'), task('H-2', 'holdout', 'repo-b')];

  test('dev-only experiments need no approval', () => {
    assert.deepEqual(holdoutGate(manifest({ kind: 'exploratory', tasks: [task('D-1', 'dev')], protocol: null }), { qbRoot }), { holdout: false });
  });

  test('holdout without an approval, in an exploratory experiment, or without a pinned protocol is refused', () => {
    assert.throws(() => holdoutGate(manifest({ tasks }), { qbRoot }), /no approval record/);
    assert.throws(() => holdoutGate(manifest({ kind: 'exploratory', tasks, approval: approvalFor(tasks) }), { qbRoot }), /official/);
    assert.throws(() => holdoutGate(manifest({ tasks, protocol: null, approval: approvalFor(tasks) }), { qbRoot }), /no protocol/);
  });

  test('an approver name alone is not an approval: the record must name both hashes (schema)', () => {
    assert.ok(!S.Approval.safeParse({ approver: 'independent reviewer', approved_at: T0 }).success);
    assert.ok(!S.Approval.safeParse({ approved_by: 'independent reviewer' }).success);
  });

  test('an approval of another protocol version or another holdout set is refused', () => {
    assert.throws(() => holdoutGate(manifest({ tasks, approval: approvalFor(tasks, { protocol_sha256: H('9') }) }), { qbRoot }), /different protocol/);
    const revised = tasks.map((t) => (t.id === 'H-2' ? task('H-2', 'holdout', 'repo-b', 'bug_fix', 2) : t));
    assert.throws(() => holdoutGate(manifest({ tasks: revised, approval: approvalFor(tasks) }), { qbRoot }), /different holdout spec set/);
    const added = [...tasks, task('H-3', 'holdout')];
    assert.throws(() => holdoutGate(manifest({ tasks: added, approval: approvalFor(tasks) }), { qbRoot }), /different holdout spec set/);
  });

  test('a protocol edited after approval is refused; the exact approved protocol and set pass', () => {
    const ok = holdoutGate(manifest({ tasks, approval: approvalFor(tasks) }), { qbRoot });
    assert.deepEqual([ok.holdout, ok.approver], [true, 'independent reviewer']);
    fs.appendFileSync(path.join(qbRoot, 'docs/bench/protocol.md'), 'edited after approval\n');
    try {
      assert.throws(() => holdoutGate(manifest({ tasks, approval: approvalFor(tasks) }), { qbRoot }), /changed after approval/);
    } finally { fs.writeFileSync(path.join(qbRoot, 'docs/bench/protocol.md'), '# protocol v1\n'); }
  });

  test('the runner refuses an unapproved holdout before any preflight or agent work', async () => {
    const m = createExperiment({ dir: path.join(tmp, 'exps'), kind: 'exploratory', tasks, arms: [{ ...ARMS.A }, { ...ARMS.E }], primary_comparison: ['A', 'E'],
      budget: BUDGET, pins: PINS, protocol: { path: 'docs/bench/protocol.md', sha256: protocolSha }, experimentId: `exp-qb30-run-${n++}`, now: () => new Date(T0) });
    let probed = 0; let agentCalls = 0;
    await assert.rejects(runExperiment(m.dir, { specs: {}, qbRoot, preflight: { probes: { ensureImages: async () => { probed++; } } },
      runSandboxed: async () => { agentCalls++; } }), /holdout refused/);
    assert.deepEqual([probed, agentCalls], [0, 0]);
  });
});

describe('QB-30: randomized, paired, reproducible order', () => {
  const tasks = [task('T-1', 'dev'), task('T-2', 'dev'), task('T-3', 'dev')];
  const arms = ['A', 'B', 'E'].map((id) => ({ ...ARMS[id] }));
  test('the same seed gives the same order; a different seed a different one; every (task, rep, arm) appears once', () => {
    const o1 = seededOrder(tasks, arms, 3, 'seed-1');
    assert.deepEqual(seededOrder(tasks, arms, 3, 'seed-1'), o1);
    assert.notDeepEqual(seededOrder(tasks, arms, 3, 'seed-2'), o1);
    assert.equal(o1.length, 3 * 3 * 3);
    assert.equal(new Set(o1.map((x) => `${x.trial_id}/${x.arm}`)).size, 27);
    const def = []; for (const t of tasks) for (let r = 1; r <= 3; r++) for (const a of arms) def.push(`${t.id}-r${r}/${a.id}`);
    assert.notDeepEqual(o1.map((x) => `${x.trial_id}/${x.arm}`), def, 'not randomized');
  });
  test('the arms of one trial run back to back (paired), in a seeded order that varies between trials', () => {
    const o = seededOrder(tasks, arms, 3, 'seed-1');
    for (let i = 0; i < o.length; i += 3) assert.equal(new Set(o.slice(i, i + 3).map((x) => x.trial_id)).size, 1);
    const armOrders = new Set(); for (let i = 0; i < o.length; i += 3) armOrders.add(o.slice(i, i + 3).map((x) => x.arm).join(''));
    assert.ok(armOrders.size > 1, 'arm order never varies');
    assert.throws(() => seededOrder(tasks, arms, 1, 'none'), /seed is required/);
  });
});

describe('QB-30: the task is the unit of analysis', () => {
  const row = (task_id, repetition, arm, score) => ({ task_id, repetition, arm, score });
  test('repeated trials do not count as independent tasks: each task weighs the same', () => {
    // T-1: 3 reps, E passes and A fails every time; T-2: 1 rep, both fail.
    const rows = [1, 2, 3].flatMap((r) => [row('T-1', r, 'A', 'fail'), row('T-1', r, 'E', 'pass')]).concat([row('T-2', 1, 'A', 'fail'), row('T-2', 1, 'E', 'fail')]);
    const eff = taskEffects(rows, 'A', 'E');
    assert.deepEqual(eff.map((e) => [e.task_id, e.matched, e.effect]), [['T-1', 3, 1], ['T-2', 1, 0]]);
    const ci = clusterBootstrap(eff.map((e) => ({ ...e, repository: 'r' })), { seed: 's' });
    assert.equal(ci.estimate, 0.5, 'trial-weighted would be 0.75');
    assert.equal(ci.method, 'cluster bootstrap (repositories, then tasks)');
    assert.match(ci.note, /fewer than 2 repositories/);
  });
  test('a task with no matched pair has no effect (listed), never 0; the bootstrap is seeded and resamples repositories', () => {
    const rows = [row('T-1', 1, 'A', 'fail'), row('T-1', 1, 'E', 'pass'), row('T-2', 1, 'A', 'pass'), row('T-2', 1, 'E', null),
      row('T-3', 1, 'A', 'pass'), row('T-3', 1, 'E', 'pass')];
    const eff = taskEffects(rows, 'A', 'E');
    assert.equal(eff.find((e) => e.task_id === 'T-2').effect, null);
    const withRepo = eff.map((e) => ({ ...e, repository: e.task_id === 'T-3' ? 'repo-b' : 'repo-a' }));
    const a = clusterBootstrap(withRepo, { seed: 'x' }); const b = clusterBootstrap(withRepo, { seed: 'x' });
    assert.deepEqual(a, b);
    assert.deepEqual([a.n_tasks, a.n_repositories, a.estimate], [2, 2, 0.5]);
    assert.ok(a.ci95[0] <= a.estimate && a.estimate <= a.ci95[1]);
  });
  test('analyze: primary + exploratory secondaries, strata by type and repository, completion and attrition per arm; no McNemar', () => {
    const tasks = [task('T-1', 'dev', 'repo-a', 'bug_fix'), task('T-2', 'dev', 'repo-b', 'addition')];
    const m = { experiment_id: 'e', tasks, arms: [{ id: 'A' }, { id: 'B' }, { id: 'E' }], trial_plan: { seed: 's' } };
    const rows = [row('T-1', 1, 'A', 'fail'), row('T-1', 1, 'E', 'pass'), row('T-1', 1, 'B', 'fail'), row('T-2', 1, 'A', 'pass'), row('T-2', 1, 'E', null), row('T-2', 1, 'B', 'pass')];
    const arms = { A: { planned: 2, scored: 2, pass: 1, attrition: {} }, B: { planned: 2, scored: 2, pass: 1, attrition: {} }, E: { planned: 2, scored: 1, pass: 1, attrition: { infra_error: 1 } } };
    const an = analyze({ primary_comparison: ['A', 'E'], rows, arms }, m);
    assert.equal(an.primary.role, 'primary (predeclared)');
    assert.deepEqual(an.primary.unmatched_tasks, ['T-2']);
    assert.deepEqual(an.secondary.map((s2) => [s2.comparison.join(''), s2.role]), [['AB', 'secondary (exploratory ablation)']]);
    assert.deepEqual(an.strata.by_type.map((s2) => s2.type), ['addition', 'bug_fix']);
    assert.deepEqual(an.strata.by_repository.map((s2) => [s2.repository, s2.tasks_matched]), [['repo-a', 1], ['repo-b', 0]]);
    assert.deepEqual([an.completion.E.completion_rate, an.completion.E.attrition], [0.5, { infra_error: 1 }]);
    assert.match(an.not_used, /McNemar/);
  });
});

describe('QB-30: the legacy tasks are labelled for what they are', () => {
  test('the six legacy tasks are dev-only and marked as tuned during development', () => {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '../../bench/tasks.json'), 'utf8'));
    assert.equal(t.tasks.length, 6);
    for (const x of t.tasks) assert.deepEqual([x.split, x.tuned_during_development], ['dev', true], x.id);
  });
  test('the protocol document exists, is marked as an unreviewed draft, and predeclares A vs E with the task as the unit', () => {
    const doc = fs.readFileSync(path.join(__dirname, '../../docs/bench/protocol.md'), 'utf8');
    assert.match(doc, /DRAFT for independent review/);
    assert.match(doc, /A \(the native agent\) vs E/);
    assert.match(doc, /Unit of analysis: the task/);
    assert.match(doc, /cluster bootstrap/);
  });
});
