/**
 * Phase 4 shared schemas (bench/schemas.js): the invariants both the grader (QB-27) and
 * the experiment store/report (QB-29) rely on.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../bench/schemas');

const H = 'a'.repeat(64); const C = 'b'.repeat(40); const T = '2026-10-07T00:00:00Z';

test('hashOf is key-order independent; treeHash covers names and bytes and refuses symlinks', () => {
  assert.equal(S.hashOf({ b: 1, a: [1, { y: 2, x: 1 }] }), S.hashOf({ a: [1, { x: 1, y: 2 }], b: 1 }));
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-schemas-'));
  try {
    fs.mkdirSync(path.join(d, 's'));
    fs.writeFileSync(path.join(d, 's/a.js'), 'x');
    const h1 = S.treeHash(d);
    fs.writeFileSync(path.join(d, 's/a.js'), 'y');
    assert.notEqual(S.treeHash(d), h1);
    fs.symlinkSync('/etc/hosts', path.join(d, 'link'));
    assert.throws(() => S.treeHash(d), /symlink/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('only pass/fail are scored outcomes; usage accepts unknown but never a coerced value of the wrong type', () => {
  assert.deepEqual(S.SCORED_OUTCOMES, ['pass', 'fail']);
  const base = { schema: 'qb-trial-result/1', experiment_id: 'e', trial_id: 't', task_id: 'T-1', repetition: 1, arm: 'A', status: 'completed',
    started_at: T, finished_at: T, elapsed_ms: 1, artifacts: { patch: { path: 'trials/t/A/patch.diff', sha256: H } }, internal_verdict: null,
    grade_outcome: 'pass', usage: { agent_ms: 'unknown', model_calls: 'unknown', tokens: 'unknown', cost_usd: 'unknown', human_approval_ms: 'unknown', models_returned: [] },
    memory: { mode: 'off', store_sha256_before: null, recall_calls: 0, persist_calls: 0 } };
  assert.ok(S.TrialResult.safeParse(base).success);
  assert.ok(!S.TrialResult.safeParse({ ...base, usage: { ...base.usage, cost_usd: null } }).success, 'null is not unknown');
  assert.ok(!S.TrialResult.safeParse({ ...base, artifacts: { patch: { path: '../escape', sha256: H } } }).success);
});

test('an approval must name the protocol and holdout-set hashes; holdoutSetHash ignores dev specs and order', () => {
  assert.ok(!S.Approval.safeParse({ approver: 'prof', approved_at: T }).success);
  assert.ok(S.Approval.safeParse({ approver: 'prof', approved_at: T, protocol_sha256: H, holdout_set_sha256: H }).success);
  const a = { id: 'H-1', version: 1, spec_sha256: H, split: 'holdout' }; const b = { id: 'H-2', version: 1, spec_sha256: H, split: 'holdout' };
  const dev = { id: 'D-1', version: 1, spec_sha256: H, split: 'dev' };
  assert.equal(S.holdoutSetHash([a, dev, b]), S.holdoutSetHash([b, a]));
  assert.notEqual(S.holdoutSetHash([a, b]), S.holdoutSetHash([a, { ...b, version: 2 }]));
});

test('a manifest must state total compute is not controlled, pin a full commit, and use digests or unknown for images', () => {
  const r = S.Experiment.shape.budget.safeParse({ agent_time_ms: 1, trial_deadline_ms: 1, model_call_deadline_ms: 1, total_compute_controlled: true });
  assert.ok(!r.success);
  assert.ok(!S.Experiment.shape.pins.shape.qb.safeParse({ commit: 'abc', dirty: false, dirty_patch_sha256: null }).success);
  const img = S.Experiment.shape.pins.shape.images;
  assert.ok(!img.safeParse({ sandbox: { ref: 'qb:latest', digest: 'latest' } }).success);
  assert.ok(img.safeParse({ sandbox: { ref: 'qb:latest', digest: 'unknown' } }).success);
  assert.ok(img.safeParse({ sandbox: { ref: 'qb:latest', digest: `sha256:${H}` } }).success);
  assert.ok(C);
});
