/**
 * QB-29: experiments are immutable and pinned; the report cannot mix versions.
 *
 * Pre-fix (5c8a5de) the report deduplicated bench/results by task id ("later file wins"),
 * so runs with different contracts or code versions were merged; a task without a
 * baseline was folded into the totals; result files were named by Date.now() with no
 * experiment, so nothing tied a score to its patch, grade or versions; nothing was hashed.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const S = require('../../bench/schemas');
const { makeRepo } = require('../helpers/tmprepo');

const ROOT = path.join(__dirname, '..', '..');
const REPORT = path.join(ROOT, 'bench', 'report.js');
const H = (c) => c.repeat(64).slice(0, 64);
const COMMIT = 'c'.repeat(40);
const T0 = '2026-10-07T00:00:00.000Z';

const tmps = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qb29-')); tmps.push(d); return d; };
const repos = [];
after(() => { for (const d of tmps) fs.rmSync(d, { recursive: true, force: true }); for (const r of repos) r.cleanup(); });

const exp = () => require('../../bench/experiment');
const rep = () => require('../../bench/report');

const GRADER_FILES = { 'bench/grader.js': H('1') };
const PINS = {
  qb: { commit: COMMIT, dirty: false, dirty_patch_sha256: null },
  agent: { name: 'claude-code', adapter_version: 'claude-code@2.0.0 (qb-sandbox-agent:abc)', cli_version: 'unknown' },
  images: { agent: { ref: 'qb-sandbox-agent:abc', digest: `sha256:${H('d')}` } },
  node: 'v22.0.0',
  grader: { files: GRADER_FILES },
  models: [{ role: 'l1', requested: 'deepseek-r1:7b' }],
};
const TASKS = [
  { id: 'T-001', version: 1, spec_sha256: H('a'), split: 'dev', repo_commit: COMMIT, lockfiles: {} },
  { id: 'T-006', version: 1, spec_sha256: H('b'), split: 'dev', repo_commit: COMMIT, lockfiles: {} },
];
const ARM = (id, extra = {}) => ({ id, adds: id === 'A' ? 'native agent' : 'QB verifier + repair', contract: id === 'A' ? 'none' : 'oracle_approved',
  feedback: id === 'A' ? 'none' : 'qb_verifier', context: id !== 'A', memory: 'off', max_attempts: id === 'A' ? 1 : 3, ...extra });
const BUDGET = { agent_time_ms: 1_800_000, trial_deadline_ms: 3_600_000, model_call_deadline_ms: 120_000, total_compute_controlled: false };

function newExperiment(o = {}) {
  return exp().createExperiment({
    dir: tmp(), kind: 'official', tasks: TASKS, arms: [ARM('A'), ARM('E')], primary_comparison: ['A', 'E'], budget: BUDGET,
    repetitions: 1, config: { max_retries: 3 }, pins: PINS, experimentId: o.id || 'exp-test-1', now: () => new Date(T0), ...o,
  });
}

const USAGE = { agent_ms: 'unknown', model_calls: 'unknown', tokens: 'unknown', cost_usd: 'unknown', human_approval_ms: 'unknown', models_returned: [] };
function grade(task, patch, outcome, extra = {}) {
  return { schema: 'qb-grade/1', task_id: task.id, spec_sha256: task.spec_sha256, patch_sha256: S.sha256(Buffer.from(patch)),
    grader_sha256: S.hashOf(GRADER_FILES), outcome, reason: outcome === 'pass' ? 'tests_passed' : outcome === 'fail' ? 'tests_failed' : outcome,
    checks: [], environment: { network: 'none', credentials: 'none', image: 'qb-sandbox-tools@sha256:x' }, duration_ms: 10, ...extra };
}
function record(e, { task = TASKS[0], rep = 1, arm, outcome = 'pass', status = 'completed', internal = null, patch = `diff ${arm} ${task.id}\n`, gradeExtra } = {}) {
  const artifacts = { 'patch.diff': patch };
  if (outcome) artifacts['grade.json'] = grade(task, patch, outcome, gradeExtra);
  return exp().recordTrial(e.dir, {
    experiment_id: e.manifest.experiment_id, trial_id: `${task.id}-r${rep}`, task_id: task.id, repetition: rep, arm, status,
    started_at: T0, finished_at: T0, elapsed_ms: 5, internal_verdict: internal, grade_outcome: outcome || null, usage: USAGE,
    memory: { mode: 'off', store_sha256_before: null, recall_calls: 0, persist_calls: 0 },
  }, artifacts);
}

describe('QB-29: immutable, pinned experiments', () => {
  test('a re-run never overwrites a recorded trial (pre-fix: results were loose files, any rerun replaced the reported row)', () => {
    const e = newExperiment();
    record(e, { arm: 'A', outcome: 'fail' });
    const patchFile = path.join(e.dir, 'trials/T-001-r1/A/patch.diff');
    const before = fs.readFileSync(patchFile);
    assert.throws(() => record(e, { arm: 'A', outcome: 'pass', patch: 'different\n' }), /already recorded; a re-run is a new trial/);
    assert.deepEqual(fs.readFileSync(patchFile), before);
    // an experiment id is never reused in the same root
    assert.throws(() => exp().createExperiment({ dir: path.dirname(e.dir), kind: 'official', tasks: TASKS, arms: [ARM('A'), ARM('E')],
      primary_comparison: ['A', 'E'], budget: BUDGET, pins: PINS, experimentId: 'exp-test-1', now: () => new Date(T0) }), /EEXIST/);
  });

  test('a tampered or missing artifact is refused, naming the file (pre-fix: nothing was hashed)', () => {
    const e = newExperiment();
    record(e, { arm: 'A', outcome: 'pass' });
    record(e, { arm: 'E', outcome: 'pass' });
    assert.doesNotThrow(() => exp().loadExperiment(e.dir));
    const f = path.join(e.dir, 'trials/T-001-r1/E/patch.diff');
    fs.chmodSync(f, 0o644);
    fs.appendFileSync(f, 'sneaky\n');
    assert.throws(() => rep().buildReport(e.dir), (err) => /hash mismatch/.test(err.message) && err.message.includes('trials/T-001-r1/E/patch.diff'));
    fs.rmSync(f);
    assert.throws(() => exp().loadExperiment(e.dir), /T-001-r1\/E\/patch\.diff: artifact missing/);
    // the manifest's config is hash-checked too
    const e2 = newExperiment({ id: 'exp-test-2' });
    const mf = path.join(e2.dir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.config.max_retries = 9;
    fs.chmodSync(mf, 0o644); fs.writeFileSync(mf, JSON.stringify(m));
    assert.throws(() => exp().loadExperiment(e2.dir), /config does not match config_sha256/);
  });

  test('an official experiment refuses a dirty QB checkout; an exploratory one archives and hashes the diff', () => {
    const qb = makeRepo({ 'qb.js': 'console.log(1)\n', 'bench/grader.js': 'g\n' }); repos.push(qb);
    fs.writeFileSync(path.join(qb.dir, 'qb.js'), 'console.log(2)\n');
    fs.writeFileSync(path.join(qb.dir, 'new-file.js'), 'x\n');
    const probes = { claudeVersion: () => 'unknown', imageDigest: () => 'unknown', agentVersion: () => 'claude-code@test', images: () => ({ agent: 'qb-sandbox-agent:t' }) };
    const base = { kind: 'official', tasks: TASKS, arms: [ARM('A'), ARM('E')], primary_comparison: ['A', 'E'], budget: BUDGET, qbRoot: qb.dir,
      graderFiles: ['bench/grader.js'], probes, now: () => new Date(T0) };
    assert.throws(() => exp().createExperiment({ ...base, dir: tmp(), experimentId: 'exp-dirty' }), /official experiment refused.*uncommitted/s);
    const e = exp().createExperiment({ ...base, kind: 'exploratory', dir: tmp(), experimentId: 'exp-dirty' });
    const patch = fs.readFileSync(path.join(e.dir, 'dirty.patch'), 'utf8');
    assert.match(patch, /console\.log\(2\)/);
    assert.match(patch, /# untracked [0-9a-f]{64} new-file\.js/);
    assert.equal(e.manifest.pins.qb.dirty, true);
    assert.equal(e.manifest.pins.qb.dirty_patch_sha256, S.sha256File(path.join(e.dir, 'dirty.patch')));
    assert.equal(e.manifest.pins.grader.files['bench/grader.js'], S.sha256(Buffer.from('g\n')));
    assert.deepEqual(e.manifest.pins.images, { agent: { ref: 'qb-sandbox-agent:t', digest: 'unknown' } });
    assert.match(e.manifest.pins.qb.commit, /^[0-9a-f]{40}$/);
    fs.appendFileSync(path.join(e.dir, 'dirty.patch'), 'x');
    assert.throws(() => exp().loadExperiment(e.dir), /dirty\.patch: hash does not match/);
    // a clean checkout is accepted for an official experiment
    execFileSync('git', ['checkout', '--', 'qb.js'], { cwd: qb.dir }); fs.rmSync(path.join(qb.dir, 'new-file.js'));
    const ok = exp().createExperiment({ ...base, dir: tmp(), experimentId: 'exp-clean' });
    assert.equal(ok.manifest.pins.qb.dirty, false);
    assert.equal(fs.existsSync(path.join(ok.dir, 'dirty.patch')), false);
  });

  test('recording refuses a trial outside the plan or a grade that disagrees with its spec, grader, patch or outcome', () => {
    const e = newExperiment();
    assert.throws(() => record(e, { arm: 'A', rep: 2 }), /not in the trial plan/);
    assert.throws(() => record(e, { arm: 'A', gradeExtra: { spec_sha256: H('f') } }), /another spec version/);
    assert.throws(() => record(e, { arm: 'A', gradeExtra: { grader_sha256: H('9') } }), /unpinned grader/);
    assert.throws(() => record(e, { arm: 'A', gradeExtra: { patch_sha256: H('8') } }), /another patch/);
    assert.throws(() => exp().recordTrial(e.dir, { experiment_id: 'exp-test-1', trial_id: 'T-001-r1', task_id: 'T-001', repetition: 1, arm: 'A', status: 'completed',
      started_at: T0, finished_at: T0, elapsed_ms: 1, internal_verdict: null, grade_outcome: 'fail', usage: USAGE,
      memory: { mode: 'off', store_sha256_before: null, recall_calls: 0, persist_calls: 0 } }, { 'grade.json': grade(TASKS[0], 'p', 'pass') }), /disagrees with the grade/);
  });
});

describe('QB-29: the report', () => {
  test('mixed versions are refused by default and labelled MIXED with --allow-mixed (pre-fix: byTask merged runs with different contracts)', () => {
    const e = newExperiment();
    record(e, { arm: 'A', outcome: 'fail' });
    record(e, { arm: 'E', outcome: 'pass' });
    // a result copied in from another experiment, graded against another spec version
    const foreign = newExperiment({ id: 'exp-other' });
    const t6 = { ...TASKS[1], spec_sha256: H('e') };
    const fe = exp().createExperiment({ dir: tmp(), kind: 'official', tasks: [TASKS[0], t6], arms: [ARM('A'), ARM('E')], primary_comparison: ['A', 'E'],
      budget: BUDGET, pins: PINS, experimentId: 'exp-other', now: () => new Date(T0) });
    record(fe, { task: t6, arm: 'A', outcome: 'pass' });
    fs.cpSync(path.join(fe.dir, 'trials/T-006-r1'), path.join(e.dir, 'trials/T-006-r1'), { recursive: true });
    assert.ok(foreign);
    assert.throws(() => rep().buildReport(e.dir), (err) => /mixed versions refused/.test(err.message)
      && /trials\/T-006-r1\/A: belongs to experiment exp-other/.test(err.message) && /graded against spec/.test(err.message));
    const out = rep().buildReport(e.dir, { allowMixed: true });
    assert.match(out, /\[MIXED\]/);
    assert.match(out, /belongs to experiment exp-other/);
    const d = rep().reportData(e.dir, { allowMixed: true });
    assert.equal(d.mixed, true);
  });

  test('legacy results are shown per file, labelled not comparable, never deduplicated or aggregated (pre-fix: --legacy unknown; byTask kept only the latest)', () => {
    const dir = tmp();
    const r = (contract, verdict, base) => ({ task_id: 'T-002', qb: { final_verdict: verdict, contract }, ...(base ? { baseline: { verdict: base } } : {}) });
    fs.writeFileSync(path.join(dir, 'T-002_1.json'), JSON.stringify(r({ goal: 'v1', acceptance_criteria: [{ id: 'AC-1', criterion: '30s' }] }, 'fail', 'pass')));
    fs.writeFileSync(path.join(dir, 'T-002_2.json'), JSON.stringify(r({ goal: 'v2', acceptance_criteria: [{ id: 'AC-1', criterion: '5m' }] }, 'pass')));
    const out = execFileSync(process.execPath, [REPORT, '--legacy', dir, '--format', 'json'], { encoding: 'utf8' });
    const d = JSON.parse(out);
    assert.equal(d.comparable, false);
    assert.match(d.label, /pre-QB-29, not comparable/);
    assert.equal(d.entries.length, 2, 'both runs of T-002 are listed');
    assert.notEqual(d.entries[0].contract_sha256, d.entries[1].contract_sha256);
    assert.equal(d.entries[1].baseline_internal_verdict, 'not run');
    const table = execFileSync(process.execPath, [REPORT, '--legacy', dir], { encoding: 'utf8' });
    assert.doesNotMatch(table, /pass rate|lift|pp\b/i);
  });

  test('a missing arm is attrition, never a win or a loss (pre-fix: a T-006 without baseline was folded into the totals)', () => {
    const e = newExperiment();
    record(e, { arm: 'A', outcome: 'fail' });
    record(e, { arm: 'E', outcome: 'pass' });
    record(e, { task: TASKS[1], arm: 'E', outcome: 'pass' });        // T-006: baseline arm never recorded
    const d = rep().reportData(e.dir);
    assert.equal(d.matched_pairs.count, 1);
    assert.deepEqual([d.matched_pairs.only_E, d.matched_pairs.only_A], [1, 0]);
    assert.deepEqual(d.matched_pairs.unmatched, [{ task_id: 'T-006', repetition: 1, A: 'not_recorded', E: 'pass' }]);
    assert.equal(d.arms.A.attrition.not_recorded, 1);
    assert.deepEqual([d.arms.A.scored, d.arms.A.planned, d.arms.E.scored, d.arms.E.planned], [1, 2, 2, 2]);
  });

  test('only external pass/fail are scores: grader/infra errors, adjudication, ungraded and failed trials are attrition; internal verdicts are never scored', () => {
    const e = exp().createExperiment({ dir: tmp(), kind: 'official', tasks: TASKS, arms: [ARM('A'), ARM('E')], primary_comparison: ['A', 'E'],
      budget: BUDGET, repetitions: 3, pins: PINS, experimentId: 'exp-attr', now: () => new Date(T0) });
    record(e, { rep: 1, arm: 'A', outcome: 'grader_error' });
    record(e, { rep: 1, arm: 'E', outcome: 'fail', internal: 'pass' });          // QB said pass; the external grader says fail
    record(e, { rep: 2, arm: 'A', outcome: 'infra_error' });
    record(e, { rep: 2, arm: 'E', outcome: 'needs_adjudication', internal: 'pass' });
    record(e, { rep: 3, arm: 'A', outcome: null, status: 'timeout' });
    record(e, { rep: 3, arm: 'E', outcome: null });                                // completed but never graded
    fs.mkdirSync(path.join(e.dir, 'trials/T-006-r1/A'), { recursive: true });       // crashed mid-record
    const d = rep().reportData(e.dir);
    assert.deepEqual([d.arms.A.scored, d.arms.E.scored, d.arms.E.fail, d.arms.E.pass], [0, 1, 1, 0]);
    assert.deepEqual(d.arms.A.attrition, { needs_adjudication: 0, grader_error: 1, grade_infra_error: 1, ungraded: 0, agent_error: 0, timeout: 1,
      trial_infra_error: 0, missing: 0, incomplete: 1, not_recorded: 2 });
    assert.deepEqual([d.arms.E.attrition.needs_adjudication, d.arms.E.attrition.ungraded], [1, 1]);
    assert.deepEqual(d.arms.E.internal_verdicts, { pass: 2 });
    assert.equal(d.matched_pairs.count, 0);
  });

  test('every score links to its patch and grade; the report is byte-identical across runs and processes', () => {
    const e = newExperiment();
    record(e, { arm: 'A', outcome: 'fail' });
    record(e, { arm: 'E', outcome: 'pass' });
    const d = rep().reportData(e.dir);
    for (const r of d.rows.filter((x) => x.score)) {
      assert.equal(r.patch, `trials/${r.trial_id}/${r.arm}/patch.diff`);
      assert.equal(r.grade, `trials/${r.trial_id}/${r.arm}/grade.json`);
    }
    for (const format of ['table', 'markdown', 'json']) {
      const a = rep().buildReport(e.dir, { format });
      const b = execFileSync(process.execPath, [REPORT, e.dir, '--format', format], { encoding: 'utf8' });
      assert.equal(a, b, format);
      assert.doesNotMatch(a, /20\d\d-\d\d-\d\dT/, 'no clock in the report');
    }
    assert.match(rep().buildReport(e.dir), /trials\/T-001-r1\/E\/grade\.json/);
    assert.match(rep().buildReport(e.dir), /Execution is not reproducible/);
  });
});
