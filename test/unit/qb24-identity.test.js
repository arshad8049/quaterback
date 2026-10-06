/**
 * QB-24: memory never mixes repositories or opposite instructions.
 * - the store namespace is a collision-resistant repository identity (sha256 of the
 *   realpath) plus a schema version: /x/a/b and /x/a_b never share records; the
 *   pre-QB-24 path-sanitized namespaces are ignored and reported, never merged;
 * - negation and task intent are preserved: opposite requests are never similarity 1,
 *   and an opposite-intent repair is never reused automatically;
 * - file hints are validated (no traversal, no absolute paths, must exist in the
 *   current checkout); records carry their base revision and an incompatible one is
 *   stale; hints from failed runs are ranked and labelled apart from resolved ones.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMemory } = require('../../memory');
const { createStore } = require('../../memory/store');
const { intentOf, compareIntent } = require('../../memory/scorer');
const { makeRepo } = require('../helpers/tmprepo');

const dirs = [];
const mk = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `qb24-${p}-`)); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const contract = (goal, crit = 'the deploy runs on push') => ({ id: crypto.randomUUID(), goal, acceptance_criteria: [{ id: 'AC-1', criterion: crit }] });
const report = (verdict = 'pass') => ({ verdict, attempts: 1, criteria_results: [] });
const exec = (files) => ({ duration_ms: 5, changes: files.map((file) => ({ file, additions: 1, deletions: 0 })) });

/** A proven (QB-23 resolved) repair record for `criterion`, with the fields QB-24 records. */
function provenRepair(repoPath, criterion, extra = {}) {
  return {
    id: crypto.randomUUID(), ts: new Date().toISOString(), repo_path: repoPath, goal_keywords: ['deploy'],
    failed_criterion: 'AC-1', crit_keywords: ['deploy', 'runs', 'push'], criterion_text: criterion,
    diagnosis: 'the workflow has no push trigger', fix: 'add `on: push` to deploy.yml', resolved: true,
    schema: 2, run_id: 'run-1', source: 'model_suggestion', outcome: 'resolved', reason: 'met_on_changed_patch_and_approved_pass',
    from_attempt: 1, to_attempt: 2, ...extra,
  };
}

describe('collision-resistant repository identity', () => {
  test('/x/a/b and /x/a_b never share records (pre-fix: both mapped to "x_a_b")', async () => {
    const base = mk('paths');
    const ab = path.join(base, 'a', 'b');
    const a_b = path.join(base, 'a_b');
    fs.mkdirSync(ab, { recursive: true });
    fs.mkdirSync(a_b, { recursive: true });
    const m = createMemory({ root: mk('root') });
    await m.remember(ab, contract('Enable caching'), report(), exec([]));
    await m.remember(a_b, contract('Add a clamp helper'), report(), exec([]));
    assert.equal(m.stats(ab).total_runs, 1);
    assert.equal(m.stats(a_b).total_runs, 1);
    assert.notEqual(m.stats(ab).memory_dir, m.stats(a_b).memory_dir);
    assert.deepEqual(m.recallPrior(a_b, 'Enable caching').map((o) => o.goal), []);
  });
  test('the namespace carries the schema version and the repository identity it belongs to', async () => {
    const r = mk('ident');
    const root = mk('root');
    const m = createMemory({ root });
    await m.remember(r, contract('Enable caching'), report(), exec([]));
    const dir = m.stats(r).memory_dir;
    assert.match(path.basename(dir), /^r2-[0-9a-f]{64}$/);
    const id = JSON.parse(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'));
    assert.deepEqual([id.schema, id.repo_realpath], [2, fs.realpathSync(r)]);
  });
  test('a namespace whose identity file names another repository is refused, not merged', async () => {
    const r = mk('mismatch');
    const root = mk('root');
    const m = createMemory({ root, onWarning: () => {} });
    await m.remember(r, contract('Enable caching'), report(), exec([]));
    const dir = m.stats(r).memory_dir;
    fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ schema: 2, repo_realpath: '/somewhere/else' }));
    assert.equal(m.stats(r).total_runs, 0);
    assert.equal(m.stats(r).identity.status, 'mismatch');
    await assert.rejects(m.remember(r, contract('Enable caching'), report(), exec([])), /belongs to \/somewhere\/else/);
  });
  test('a pre-QB-24 path-sanitized namespace is ignored and reported, never read or merged', async () => {
    const r = mk('legacy');
    const root = mk('root');
    const legacy = path.join(root, fs.realpathSync(r).replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, ''));
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'outcomes.jsonl'), JSON.stringify({ id: crypto.randomUUID(), ts: 't', repo_path: r, goal: 'Enable caching', keywords: ['enable', 'caching'],
      verdict: 'pass', attempts: 1, changed_files: [], ac_count: 1, duration_ms: 1 }) + '\n');
    const m = createMemory({ root, onWarning: () => {} });
    assert.deepEqual(m.recallPrior(r, 'Enable caching'), []);
    const s = m.stats(r);
    assert.equal(s.total_runs, 0);
    assert.deepEqual([s.legacy_namespace.status, s.legacy_namespace.dir], ['ignored', legacy]);
  });
});

describe('negation and intent are preserved', () => {
  test('opposite requests are not similarity 1 and are flagged conflicting (pre-fix: "not" was a stop word → 1.0)', () => {
    const cases = [
      ['Enable caching for admins', 'Do not enable caching for admins'],
      ['Enable caching for admins', 'Disable caching for admins'],
      ['Deploy on every push', "Don't deploy on every push"],
      ['Allow guests to upload files', 'Block guests from uploading files'],
    ];
    for (const [a, b] of cases) {
      const c = compareIntent(intentOf(a), intentOf(b));
      assert.equal(c.conflicting, true, `${a} / ${b}`);
      assert.ok(c.score < 1, `${a} / ${b}: ${c.score}`);
    }
    // double negation and identical intent stay the same intent
    assert.equal(compareIntent(intentOf('Enable caching'), intentOf("Don't disable caching")).conflicting, false);
    assert.equal(compareIntent(intentOf('Enable caching'), intentOf('Enable caching')).score, 1);
  });
  test('an opposite-intent repair is never reused automatically; it is reported as conflicting (pre-fix: recalled at score 1)', () => {
    const r = mk('intent');
    const root = mk('root');
    const store = createStore({ root });
    store.appendRepair(r, provenRepair(r, 'the deploy runs on push'));
    const m = createMemory({ store });
    const same = m.recallRepairs(r, [{ id: 'AC-1', criterion: 'the deploy runs on push' }]);
    assert.equal(same.length, 1);
    const opposite = m.recallRepairsDetailed(r, [{ id: 'AC-1', criterion: 'the deploy does not run on push' }]);
    assert.deepEqual(opposite.usable, []);
    assert.deepEqual(opposite.excluded.map((x) => x.reason), ['conflicting_intent']);
    assert.deepEqual(m.recallRepairs(r, [{ id: 'AC-1', criterion: 'the deploy does not run on push' }]), []);
  });
  test('a repair whose intent cannot be established (no criterion text recorded) is not reused automatically', () => {
    const r = mk('unknown-intent');
    const store = createStore({ root: mk('root') });
    const { criterion_text, ...rec } = provenRepair(r, 'the deploy runs on push');
    store.appendRepair(r, rec);
    const d = createMemory({ store }).recallRepairsDetailed(r, [{ id: 'AC-1', criterion: 'the deploy runs on push' }]);
    assert.deepEqual([d.usable.length, d.excluded.map((x) => x.reason)], [0, ['intent_unknown']]);
  });
  test('recallPrior labels an opposite-intent past run and never ranks it as identical', async () => {
    const r = mk('prior');
    const m = createMemory({ root: mk('root') });
    await m.remember(r, contract('Enable caching for admins'), report(), exec([]));
    const [p] = m.recallPrior(r, 'Do not enable caching for admins');
    assert.equal(p.intent, 'conflicting');
    assert.ok(p.score < 1);
  });
});

describe('file hints, revisions and failed runs', () => {
  test('traversal, absolute and missing file hints are rejected with a reason; real files pass (pre-fix: passed through)', async () => {
    const repo = makeRepo({ 'src/app.js': 'x\n' });
    try {
      const store = createStore({ root: mk('root') });
      const m = createMemory({ store });
      await m.remember(repo.dir, contract('Enable caching'), report(), exec(['src/app.js', '../outside.js', '/etc/passwd', 'src/gone.js', 'src/../../escape.js']));
      const d = m.recallFilesDetailed(repo.dir, 'Enable caching');
      assert.deepEqual(d.hints.map((h) => h.file), ['src/app.js']);
      assert.deepEqual(Object.fromEntries(d.rejected.map((x) => [x.file, x.reason])),
        { '../outside.js': 'traversal', '/etc/passwd': 'absolute', 'src/gone.js': 'missing', 'src/../../escape.js': 'traversal' });
      assert.deepEqual(m.recallFiles(repo.dir, 'Enable caching').map((h) => h.file), ['src/app.js']);
    } finally { repo.cleanup(); }
  });
  test('records carry their base revision; a repair from an incompatible revision is stale and not reused; an ancestor is fine', async () => {
    const repo = makeRepo({ 'deploy.yml': 'on: workflow_dispatch\n' });
    try {
      const a = repo.head();
      const store = createStore({ root: mk('root') });
      const m = createMemory({ store });
      store.appendRepair(repo.dir, provenRepair(repo.dir, 'the deploy runs on push', { base_sha: a }));
      repo.write('deploy.yml', 'on: push\n');
      repo.commit('later');                                           // a descends from HEAD's history
      assert.equal(m.recallRepairs(repo.dir, [{ id: 'AC-1', criterion: 'the deploy runs on push' }]).length, 1);
      // an unrelated history: HEAD no longer contains `a`
      repo.git(['checkout', '-q', '--orphan', 'other']);
      repo.commit('unrelated root');
      const d = m.recallRepairsDetailed(repo.dir, [{ id: 'AC-1', criterion: 'the deploy runs on push' }]);
      assert.deepEqual([d.usable.length, d.excluded.map((x) => x.reason)], [0, ['stale_revision']]);
      // a revision unknown to this repository is stale too
      store.appendRepair(repo.dir, provenRepair(repo.dir, 'the deploy runs on push', { base_sha: 'f'.repeat(40) }));
      assert.ok(m.recallRepairsDetailed(repo.dir, [{ id: 'AC-1', criterion: 'the deploy runs on push' }]).excluded.every((x) => x.reason === 'stale_revision'));
    } finally { repo.cleanup(); }
  });
  test('remember() records the base revision it is given on outcomes and repairs', async () => {
    const r = mk('basesha');
    const root = mk('root');
    const m = createMemory({ root });
    await m.remember(r, contract('Enable caching'), report(), exec([]), { baseSha: 'a'.repeat(40) });
    const dir = m.stats(r).memory_dir;
    const [o] = fs.readFileSync(path.join(dir, 'outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(o.base_sha, 'a'.repeat(40));
  });
  test('file hints from failed runs are ranked and labelled apart from resolved ones, never mixed', async () => {
    const repo = makeRepo({ 'src/good.js': 'g\n', 'src/bad.js': 'b\n' });
    try {
      const m = createMemory({ root: mk('root') });
      await m.remember(repo.dir, contract('Enable caching for admins'), report('fail'), exec(['src/bad.js']));
      await m.remember(repo.dir, contract('Enable caching for admins'), report('pass'), exec(['src/good.js']));
      const hints = m.recallFiles(repo.dir, 'Enable caching for admins');
      assert.deepEqual(hints.map((h) => [h.file, h.tier]), [['src/good.js', 'resolved_run'], ['src/bad.js', 'failed_run']]);
      assert.match(hints[1].reason, /failed run/);
    } finally { repo.cleanup(); }
  });
});
