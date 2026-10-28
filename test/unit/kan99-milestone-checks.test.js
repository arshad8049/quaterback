/**
 * KAN-99 milestone 1: scenario checks for the 23 criteria of AV-04, FJ-01, FP-03, LM-01 and PW-01
 * (bench/kan99/checks/<task>/<AC>.js, written from the prompt and criterion text only), and the
 * matrix that runs them on the base, the reference and every incorrect implementation.
 * - Every criterion has a check, and every check passes the registry from a reviewed contract.
 * - runPatch goes through the real check runner on a real checkout with the patch overlaid.
 * - summarize says, per patch, whether the checks said yes (all pass) and, per criterion, what
 *   each patch got; an error or a missing record is never counted as a pass or a catch.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateChecks, checkSetHash } = require('../../verify/checks/registry');
const M = require('../../scripts/kan99-scenario-matrix');

const TASKS = ['AV-04', 'FJ-01', 'FP-03', 'LM-01', 'PW-01'];
const criteriaOf = (t) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'curation', t, 'task.json'), 'utf8')).oracle.acceptance_criteria;

describe('the milestone checks', () => {
  test('the milestone is exactly the five tasks', () => {
    assert.deepEqual(M.TASKS, TASKS);
  });
  for (const t of TASKS) {
    test(`${t}: one check per criterion, all accepted from a reviewed contract, none from model output`, () => {
      const checks = M.loadChecks(t);
      const acs = criteriaOf(t);
      assert.deepEqual(checks.map((c) => c.ac_id), acs.map((a) => a.id));
      assert.deepEqual(checks.map((c) => c.id), acs.map((a) => `${t}-${a.id}`));
      assert.ok(checks.every((c) => c.adapter === 'scenario'));
      const r = validateChecks(checks, acs, { allowScenario: true });
      assert.deepEqual([r.accepted.length, r.rejected], [checks.length, []]);
      assert.equal(validateChecks(checks, acs).accepted.length, 0);
    });
  }
  test('23 checks in all', () => {
    assert.equal(TASKS.reduce((n, t) => n + M.loadChecks(t).length, 0), 23);
  });
  test('a criterion without a check is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99m-'));
    try {
      fs.mkdirSync(path.join(dir, 'AV-04'));
      fs.writeFileSync(path.join(dir, 'AV-04', 'AC-1.js'), 'module.exports = async () => {}\n');
      assert.throws(() => M.loadChecks('AV-04', { checksDir: dir }), /AV-04.*no check for AC-2/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('the patch kinds are the base, the reference and every incorrect implementation', () => {
    assert.deepEqual(M.patchKinds('PW-01'), ['base', 'reference', 'incorrect:arguments-length', 'incorrect:first-arg-only', 'incorrect:null-excluded']);
    assert.equal(M.truthOf('reference'), 'correct');
    assert.equal(M.truthOf('base'), 'wrong');
    assert.equal(M.truthOf('incorrect:x'), 'wrong');
  });
});

describe('runPatch: the real runner on a checkout with the patch overlaid', () => {
  const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  test('base, reference and an incorrect patch each get their own result, bound to the check set hash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99p-'));
    try {
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      fs.writeFileSync(path.join(repo, 'index.js'), 'exports.add = (a, b) => a - b\n');
      git(repo, 'init', '-q'); git(repo, 'add', '.');
      git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '-qm', 'base');
      const cur = path.join(dir, 'curation', 'XX-01');
      fs.mkdirSync(path.join(cur, 'reference'), { recursive: true });
      fs.mkdirSync(path.join(cur, 'incorrect', 'off-by-one'), { recursive: true });
      fs.writeFileSync(path.join(cur, 'task.json'), JSON.stringify({ id: 'XX-01', oracle: { acceptance_criteria: [{ id: 'AC-1', criterion: 'add adds' }, { id: 'AC-2', criterion: 'add(0, 0) is 0' }] } }));
      fs.writeFileSync(path.join(cur, 'reference', 'index.js'), 'exports.add = (a, b) => a + b\n');
      fs.writeFileSync(path.join(cur, 'incorrect', 'off-by-one', 'index.js'), 'exports.add = (a, b) => a + b + (a ? 1 : 0)\n');
      const checks = path.join(dir, 'checks', 'XX-01');
      fs.mkdirSync(checks, { recursive: true });
      fs.writeFileSync(path.join(checks, 'AC-1.js'), "module.exports = async ({ require, assert }) => { assert.equal(require('./index.js').add(2, 3), 5) }\n");
      fs.writeFileSync(path.join(checks, 'AC-2.js'), "module.exports = async ({ require, assert }) => { assert.equal(require('./index.js').add(0, 0), 0) }\n");
      const opts = { checksDir: path.join(dir, 'checks'), curationDir: path.join(dir, 'curation') };
      const recs = M.patchKinds('XX-01', opts).map((kind) => M.runPatch({ task: 'XX-01', kind, repo, ...opts }));
      assert.deepEqual(recs.map((r) => [r.patch_kind, r.truth, r.results.map((x) => x.status).join(',')]), [
        ['base', 'wrong', 'fail,pass'],
        ['reference', 'correct', 'pass,pass'],
        ['incorrect:off-by-one', 'wrong', 'fail,pass'],
      ]);
      for (const r of recs) {
        assert.equal(r.schema, 'qb-kan99-scenario/1');
        assert.equal(r.check_set_hash, checkSetHash(M.loadChecks('XX-01', opts)));
        assert.equal(r.base_rev, git(repo, 'rev-parse', 'HEAD').trim());
        assert.equal(r.qb_commit, git(path.join(__dirname, '..', '..'), 'rev-parse', 'HEAD').trim(), 'the record names the QB commit that ran it');
      }
      assert.equal(git(repo, 'status', '--porcelain'), '', 'the built repository is never modified');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('summarize', () => {
  // A trusted manifest: the checks each task expects, their hash, the pinned base and the QB commit.
  const checksOf = (task, n) => Array.from({ length: n }, (_, i) => ({ id: `${task}-AC-${i + 1}`, ac_id: `AC-${i + 1}`, adapter: 'scenario',
    params: { source: `module.exports = async () => {} // ${task} ${i + 1}\n` } }));
  const QB = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);
  const manifest = { qb_commit: QB, tasks: { T: { checks: checksOf('T', 2), check_set_hash: checkSetHash(checksOf('T', 2)), base_rev: BASE } } };
  const rec = (task, kind, statuses) => ({ schema: 'qb-kan99-scenario/1', task_id: task, patch_kind: kind, truth: M.truthOf(kind),
    base_rev: BASE, qb_commit: QB, check_set_hash: manifest.tasks.T.check_set_hash,
    results: statuses.map((s, i) => ({ id: `${task}-AC-${i + 1}`, ac_id: `AC-${i + 1}`, adapter: 'scenario', status: s, detail: '' })) });
  const expected = [{ task: 'T', kind: 'base' }, { task: 'T', kind: 'reference' }, { task: 'T', kind: 'incorrect:a' }, { task: 'T', kind: 'incorrect:b' }];
  const others = () => [rec('T', 'base', ['fail', 'pass']), rec('T', 'incorrect:a', ['fail', 'pass']), rec('T', 'incorrect:b', ['pass', 'fail'])];
  test('says yes only when every check passes; a wrong patch is caught only by a fail', () => {
    const s = M.summarize([rec('T', 'base', ['fail', 'pass']), rec('T', 'reference', ['pass', 'pass']),
      rec('T', 'incorrect:a', ['pass', 'fail']), rec('T', 'incorrect:b', ['pass', 'pass'])], expected, manifest);
    assert.deepEqual(s.patches.map((p) => [p.kind, p.truth, p.said]), [
      ['base', 'wrong', 'no'], ['reference', 'correct', 'yes'], ['incorrect:a', 'wrong', 'no'], ['incorrect:b', 'wrong', 'yes']]);
    assert.deepEqual(s.totals, { correct: { yes: 1, no: 0, incomplete: 0 }, wrong: { yes: 1, no: 2, incomplete: 0 } });
    assert.equal(s.exitCode, 0);
    assert.match(s.text, /\| T \| AC-1 \| fail \| pass \| pass \| pass \|/);
  });
  test('an error is incomplete, never yes or caught, and exits 1', () => {
    const s = M.summarize([rec('T', 'base', ['fail', 'pass']), rec('T', 'reference', ['pass', 'error']),
      rec('T', 'incorrect:a', ['error', 'pass']), rec('T', 'incorrect:b', ['pass', 'fail'])], expected, manifest);
    assert.deepEqual(s.patches.map((p) => p.said), ['no', 'incomplete', 'incomplete', 'no']);
    assert.equal(s.exitCode, 1);
    assert.match(s.text, /Incomplete \(2\)/);
  });
  test('a missing record or an error record is listed as incomplete with every denominator kept', () => {
    const s = M.summarize([rec('T', 'base', ['fail', 'pass']), rec('T', 'reference', ['pass', 'pass']),
      { task_id: 'T', patch_kind: 'incorrect:a', error: 'npm ci failed' }], expected, manifest);
    assert.deepEqual(s.totals, { correct: { yes: 1, no: 0, incomplete: 0 }, wrong: { yes: 0, no: 1, incomplete: 2 } });
    assert.equal(s.exitCode, 1);
    assert.match(s.text, /T incorrect:a: npm ci failed/);
    assert.match(s.text, /T incorrect:b: missing/);
  });
  test('a duplicate, an unexpected patch or a foreign schema is refused', () => {
    const ok = [rec('T', 'base', ['fail', 'pass']), rec('T', 'reference', ['pass', 'pass']), rec('T', 'incorrect:a', ['fail', 'pass']), rec('T', 'incorrect:b', ['fail', 'pass'])];
    assert.throws(() => M.summarize([...ok, rec('T', 'base', ['pass', 'pass'])], expected, manifest), /duplicate T base/);
    assert.throws(() => M.summarize([...ok, rec('T', 'incorrect:z', ['pass', 'pass'])], expected, manifest), /unexpected T incorrect:z/);
    assert.throws(() => M.summarize([...ok.slice(1), { ...ok[0], schema: 'other/1' }], expected, manifest), /T base.*schema/);
  });

  // KAN-99 review 10450: saved records are revalidated against the trusted manifest, never trusted.
  test('no manifest, no summary', () => {
    assert.throws(() => M.summarize([rec('T', 'reference', ['pass', 'pass'])], expected), /manifest/);
  });
  const refused = (r, re) => assert.throws(() => M.summarize([...others(), r], expected, manifest), re);
  test('10450: a reference record with no results is refused, not counted as yes', () => {
    refused({ ...rec('T', 'reference', []), results: [] }, /T reference: .*check results/);
  });
  test('10450: an unknown status is refused, not counted as no', () => {
    refused(rec('T', 'reference', ['pass', 'skipped']), /T reference: .*check results/);
  });
  test('missing, duplicate, unexpected or reordered checks are refused', () => {
    const r = rec('T', 'reference', ['pass', 'pass']);
    refused({ ...r, results: r.results.slice(0, 1) }, /T reference: .*check results/);
    refused({ ...r, results: [r.results[0], r.results[0]] }, /T reference: .*check results/);
    refused({ ...r, results: [r.results[0], { ...r.results[1], id: 'T-AC-9' }] }, /T reference: .*check results/);
    refused({ ...r, results: [r.results[1], r.results[0]] }, /T reference: .*check results/);
    refused({ ...r, results: 'pass' }, /T reference: .*check results/);
  });
  test('a wrong criterion or adapter is refused', () => {
    const r = rec('T', 'reference', ['pass', 'pass']);
    refused({ ...r, results: [{ ...r.results[0], ac_id: 'AC-2' }, r.results[1]] }, /T reference: .*check results/);
    refused({ ...r, results: [{ ...r.results[0], adapter: 'call_returns' }, r.results[1]] }, /T reference: .*check results/);
  });
  test('a check set hash other than the trusted one is refused, even when every record agrees', () => {
    const h = 'c'.repeat(64);
    assert.throws(() => M.summarize([...others(), rec('T', 'reference', ['pass', 'pass'])].map((r) => ({ ...r, check_set_hash: h })), expected, manifest),
      /T base: .*check results/);
  });
  test('a base revision other than the task pin is refused', () => {
    refused({ ...rec('T', 'reference', ['pass', 'pass']), base_rev: 'd'.repeat(40) }, /T reference: base_rev/);
  });
  test('a missing or different QB commit is refused', () => {
    const r = rec('T', 'reference', ['pass', 'pass']);
    const { qb_commit, ...noCommit } = r;
    refused(noCommit, /T reference: qb_commit/);
    refused({ ...r, qb_commit: 'e'.repeat(40) }, /T reference: qb_commit/);
  });
  test('a task the manifest does not cover is refused', () => {
    assert.throws(() => M.summarize([{ ...rec('U', 'base', ['pass']) }], [{ task: 'U', kind: 'base' }], manifest), /U base: .*manifest/);
  });
});

describe('the summary CLI refuses the 10450 records (exit 2)', () => {
  const run = (rec) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99s-'));
    try {
      fs.writeFileSync(path.join(dir, 'AV-04-reference.json'), JSON.stringify(rec));
      return spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'kan99-scenario-matrix.js'), 'summary', dir], { encoding: 'utf8' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const checks = M.loadChecks('AV-04');
  const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'curation', 'AV-04', 'task.json'), 'utf8')).base_rev;
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' }).stdout.trim();
  const good = { schema: 'qb-kan99-scenario/1', task_id: 'AV-04', patch_kind: 'reference', truth: 'correct', base_rev: base, qb_commit: head,
    check_set_hash: checkSetHash(checks), results: checks.map((c) => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status: 'pass', detail: '' })) };
  test('results: [] is refused', () => {
    const r = run({ ...good, results: [] });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /refused: AV-04 reference/);
  });
  test('an unknown status is refused', () => {
    const r = run({ ...good, results: good.results.map((x, i) => (i ? x : { ...x, status: 'skipped' })) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /refused: AV-04 reference/);
  });
  test('control: the same record with valid results is accepted (exit 1 only because the other records are missing)', () => {
    const r = run(good);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /AV-04 \| \*\*said\*\* \| \*\*incomplete\*\* \| \*\*yes\*\*/);
  });
});
