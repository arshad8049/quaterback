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

describe('QB-24 re-review: intent is per clause; compound ambiguity is never actionable', () => {
  const rel = (a, b) => compareIntent(intentOf(a), intentOf(b));
  const { tokenize } = require('../../memory/scorer');
  const repairFor = (repo, criterion) => provenRepair(repo, criterion, { crit_keywords: tokenize(criterion) });

  test('senior repro: two independent reversals no longer cancel out (pre-fix: score 1, not conflicting)', () => {
    const c = rel('Enable caching and allow uploads', 'Disable caching and block uploads');
    assert.equal(c.conflicting, true);
    assert.equal(c.relation, 'conflicting');
    assert.ok(c.score < 1);
  });
  test('changed action/target association is conflicting: enable A + disable B vs disable A + enable B', () => {
    assert.equal(rel('Enable caching and disable uploads', 'Disable caching and enable uploads').relation, 'conflicting');
    assert.equal(rel('enable caching, block uploads', 'enable caching, allow uploads').relation, 'conflicting');
  });
  test('a partly negated compound ("… but not for guests") is ambiguous, never "same"', () => {
    const c = rel('Enable caching', 'Enable caching but not for guests');
    assert.equal(c.relation, 'ambiguous');
    assert.equal(c.actionable, false);
  });
  test('guards: identical, double-negated and harmlessly extended requests stay actionable', () => {
    assert.deepEqual([rel('Enable caching and allow uploads', 'Enable caching and allow uploads').relation, rel('enable caching', "don't disable caching").relation], ['same', 'same']);
    const ext = rel('Add retry to uploads', 'Add retry to uploads and log errors');
    assert.equal(ext.conflicting, false);
    assert.equal(ext.actionable, true);
  });
  test('real store: a proven repair is never reused across reversed or ambiguous compound criteria (pre-fix: proven:true, usable)', () => {
    const r = mk('compound');
    const store = createStore({ root: mk('root') });
    store.appendRepair(r, repairFor(r, 'enable caching and allow uploads'));
    const m = createMemory({ store });
    const q = (criterion) => m.recallRepairsDetailed(r, [{ id: 'AC-1', criterion }]);
    assert.equal(q('enable caching and allow uploads').usable.length, 1);
    for (const [criterion, reason] of [
      ['disable caching and block uploads', 'conflicting_intent'],           // the double reversal (pre-fix: usable, proven)
      ['enable caching and block uploads', 'conflicting_intent'],
      ['caching is disabled and uploads are blocked', 'conflicting_intent'], // inflected forms
      ['enable caching and allow uploads but not for guests', 'ambiguous_intent'],
    ]) {
      const d = q(criterion);
      assert.deepEqual([d.usable.length, d.excluded.map((x) => x.reason)], [0, [reason]], criterion);
    }
  });
  test('qb.js end-to-end: the agent briefing carries a proven fix only for the same intent, never for the reversed one', () => {
    const { spawnSync, execFileSync } = require('child_process');
    const ROOT = path.join(__dirname, '..', '..');
    const tmp = mk('brief');
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: repo });
    const memDir = path.join(tmp, 'mem');
    const store = createStore({ root: memDir });
    const FIX = 'UNIQUE-FIX-MARKER: set cache.enabled=true and uploads.allow=true';
    store.appendRepair(repo, { ...repairFor(repo, 'enable caching and allow uploads'), fix: FIX, base_sha: null });
    const briefingFor = (criterion, tag) => {
      const file = path.join(tmp, `${tag}.json`);
      fs.writeFileSync(file, JSON.stringify({ goal: 'Configure caching and uploads', required_behavior: [criterion],
        acceptance_criteria: [{ id: 'AC-1', criterion, kind: 'non_behavioral', requirement_ids: ['R-1'] }],
        verification_plan: ['read config'], requirements: [{ id: 'R-1', quote: 'Configure caching and uploads' }], scope: { allowed_changes: ['**'] } }));
      const script = path.join(tmp, `${tag}-agent.json`);
      fs.writeFileSync(script, JSON.stringify({ steps: [{ write: 'config.txt', content: 'x\n' }] }));
      const log = path.join(tmp, `${tag}-briefing.log`);
      const env = { ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_FAKE_AGENT_BRIEFING_LOG: log, QB_RUNS_DIR: path.join(tmp, 'runs'),
        QB_MEMORY_DIR: memDir, QB_JUDGE_CACHE_DIR: path.join(tmp, 'jc'), QB_TEST_OLLAMA_REPLY: JSON.stringify({ met: true, evidence: 'ok' }) };
      delete env.NODE_TEST_CONTEXT;
      spawnSync(process.execPath, ['--require', path.join(ROOT, 'test', 'helpers', 'preload-ollama.js'), '--require', path.join(ROOT, 'test', 'helpers', 'preload-fake-sandbox.js'),
        path.join(ROOT, 'qb.js'), 'Configure caching and uploads', '--repo', repo, '--agent', 'claude-code', '--no-llm-context', '--max-retries', '1', '--contract-file', file],
      { encoding: 'utf8', timeout: 60_000, env });
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
    };
    const same = briefingFor('enable caching and allow uploads', 'same');
    assert.ok(same.length > 0, 'the fake agent recorded its briefing');
    assert.match(same, /UNIQUE-FIX-MARKER/);
    assert.doesNotMatch(briefingFor('disable caching and block uploads', 'reversed'), /UNIQUE-FIX-MARKER/);   // pre-fix: the double reversal briefed the fix
  });
});

describe('QB-24 re-review: a stale-revision record cannot re-enter through the churn fallback', () => {
  test('senior repro through remember(): app.js from a run on an unknown revision is rejected and NOT a churn hint (pre-fix: both)', async () => {
    const repo = makeRepo({ 'app.js': 'a\n' });
    try {
      const m = createMemory({ root: mk('root') });
      await m.remember(repo.dir, contract('Enable caching for admins'), report('pass'), exec(['app.js']), { baseSha: '1'.repeat(40) });
      const d = m.recallFilesDetailed(repo.dir, 'Enable caching for admins');
      assert.deepEqual(d.rejected.map((x) => [x.file, x.reason]), [['app.js', 'stale_revision']]);
      assert.deepEqual(d.hints.map((h) => h.file), []);
      assert.deepEqual(d.hints.filter((h) => h.tier === 'churn'), []);
    } finally { repo.cleanup(); }
  });
  test('guard: churn is recomputed from compatible records only — a compatible run still contributes', async () => {
    const repo = makeRepo({ 'app.js': 'a\n', 'lib.js': 'l\n' });
    try {
      const m = createMemory({ root: mk('root') });
      await m.remember(repo.dir, contract('Rename the logger'), report('pass'), exec(['lib.js']), { baseSha: repo.head() });
      await m.remember(repo.dir, contract('Something unrelated entirely'), report('pass'), exec(['app.js']), { baseSha: '1'.repeat(40) });
      const d = m.recallFilesDetailed(repo.dir, 'Enable caching for admins');
      assert.deepEqual(d.hints.map((h) => [h.file, h.tier]), [['lib.js', 'churn']]);
      assert.match(d.hints[0].reason, /compatible/);
    } finally { repo.cleanup(); }
  });
});
