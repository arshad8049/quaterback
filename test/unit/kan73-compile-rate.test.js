/**
 * KAN-73 step 1: a fixed, versioned set of requests and a script that compiles each one N times
 * through the real entry point (intent/session.js compileIntent, as qb.js uses it, with no
 * clarification answers) and reports how often the result is a valid (finalized) contract, and why
 * the rest are not. No agent and no spend: only the intent model is called.
 *
 * These tests replace the model with a stand-in compile function, so they need no Ollama.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { curateDirs } = require('../../bench/curate');
const { readLock } = require('../../bench/spec');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'kan73-compile-rate.js');
const SET = path.join(ROOT, 'bench', 'compile-requests', 'v1.json');
const lib = () => require(SCRIPT);

describe('KAN-73: the request set (bench/compile-requests/v1.json)', () => {
  test('it is version 1 and holds the two KAN-73 wordings on the hero-demo fixture, verbatim', () => {
    const set = JSON.parse(fs.readFileSync(SET, 'utf8'));
    assert.equal(set.format, 'qb-compile-requests/1');
    assert.equal(set.version, 1);
    const hero = set.requests.filter((r) => r.repo.fixture === 'hero-demo').map((r) => r.request);
    assert.deepEqual(hero, [
      'formatDuration should show durations under one minute as seconds only, for example 30000 ms as "30s" instead of "0m 30s". Durations of one minute or more keep the current format.',
      'In src/duration.js, formatDuration(30000) should return "30s" instead of "0m 30s"; formatDuration(90000) should still return "1m 30s".',
    ]);
  });

  test('loadSet expands the frozen dev-r2 prompts: 32 requests, unique ids, prompts verbatim at each base_rev', () => {
    const { requests, sha256 } = lib().loadSet(SET);
    assert.equal(requests.length, 32);
    assert.equal(new Set(requests.map((r) => r.id)).size, 32);
    assert.match(sha256, /^[0-9a-f]{64}$/);
    const lock = readLock(curateDirs('dev-r2').lockFile);
    for (const id of Object.keys(lock.specs)) {
      const spec = JSON.parse(fs.readFileSync(path.join(curateDirs('dev-r2').specs, `${id}.json`), 'utf8'));
      const r = requests.find((x) => x.id === `dev-r2/${id}`);
      assert.ok(r, id);
      assert.equal(r.request, spec.prompt);
      assert.deepEqual(r.repo, { source: spec.repo.source, rev: spec.repo.base_rev });
    }
  });

  test('a set naming an unknown include or a duplicate id is refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan73-'));
    const bad = (body) => { const f = path.join(dir, `${Math.random()}.json`); fs.writeFileSync(f, JSON.stringify(body)); return f; };
    const base = { format: 'qb-compile-requests/1', version: 1 };
    assert.throws(() => lib().loadSet(bad({ ...base, requests: [], include: [{ set: 'screen' }] })), /unknown include/);
    const r = { id: 'X', repo: { fixture: 'hero-demo' }, request: 'x' };
    assert.throws(() => lib().loadSet(bad({ ...base, requests: [r, r] })), /duplicate id X/);
  });

  test('the fixture becomes a git repository with exactly the fixture files', () => {
    const dir = lib().prepareRepo({ fixture: 'hero-demo' });
    const files = execFileSync('git', ['ls-files'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort();
    assert.deepEqual(files, ['.quarterback.json', 'package-lock.json', 'package.json', 'src/duration.js', 'test/duration.test.js']);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }), '');
  });
});

describe('KAN-73: attempts, reasons and the summary', () => {
  test('normalizeReason groups messages that differ only in ids and quoted values', () => {
    const n = lib().normalizeReason;
    assert.equal(n('constraint C-1 refers to unknown check "CHECK-1"'), n('constraint C-3 refers to unknown check "checks/AC-1"'));
    assert.equal(n('R-2 quote is not in the request verbatim: "foo"'), n('R-1 quote is not in the request verbatim: "bar baz"'));
    assert.notEqual(n('constraint C-1 refers to unknown check "X"'), n('constraint C-1 must be enforced_by something or be advisory'));
    assert.equal(n('Intent compiler returned non-JSON for: "abc..."\n\nRaw:\n{oops'), 'Intent compiler returned non-JSON');
    // a wrong worked example names its values; the cause is the same
    assert.equal(n("AC-1 example is wrong: 30000 minute → '30s' (correct: 20d 20h)"), '<where> example is wrong');
    assert.equal(n("requirement R-2 example is wrong: 90000 ms → '1m' (correct: 1m 30s)"), n("AC-3 example is wrong: 5 s → '5000' (correct: 5s)"));
  });

  test('runAttempts: finalized is valid; invalid, needs_clarification, blocked and thrown errors are not, each with its reason', async () => {
    const outcomes = [
      { state: 'finalized', contract: { goal: 'g' } },
      { state: 'invalid', errors: ['constraint C-1 refers to unknown check "CHECK-1"', 'no acceptance criteria'] },
      { state: 'needs_clarification', unresolved: [{ id: 'Q-1', question: 'Which unit?' }] },
      new Error('Intent compiler returned non-JSON for: "x"\n\nRaw:\nzz'),
      { state: 'blocked', reason: 'clarification_rounds_exhausted', unresolved: [] },
    ];
    let i = 0;
    const calls = [];
    const compileFn = async (request, o) => { calls.push({ request, o }); const r = outcomes[i++]; if (r instanceof Error) throw r; return r; };
    const records = await lib().runAttempts({ requests: [{ id: 'R1', request: 'do x', repoPath: '/tmp/r' }], n: 5, compileFn });
    assert.equal(records.length, 5);
    assert.deepEqual(records.map((r) => [r.attempt, r.state, r.valid]), [[1, 'finalized', true], [2, 'invalid', false], [3, 'needs_clarification', false], [4, 'error', false], [5, 'blocked', false]]);
    assert.equal(records[0].first_reason, null);
    assert.equal(records[1].first_reason, lib().normalizeReason('constraint C-1 refers to unknown check "CHECK-1"'));
    assert.deepEqual(records[1].errors, ['constraint C-1 refers to unknown check "CHECK-1"', 'no acceptance criteria']);
    assert.equal(records[2].first_reason, 'needs_clarification');
    assert.equal(records[3].first_reason, 'Intent compiler returned non-JSON');
    assert.equal(records[4].first_reason, 'blocked: clarification_rounds_exhausted');
    // the real entry point's options: the repository, no answers, never an interactive ask
    for (const c of calls) assert.deepEqual(c.o, { repoPath: '/tmp/r', answers: [], ask: null });
    for (const r of records) assert.equal(typeof r.duration_ms, 'number');
  });

  test('a hung attempt is recorded as timeout after attemptTimeoutMs, and the run waits for it before the next one', async () => {
    let settled = false; const order = [];
    const compileFn = async (request) => {
      order.push(`start ${request}`);
      if (request === 'hang') { await new Promise((r) => setTimeout(r, 80)); settled = true; order.push('hang settled'); return { state: 'finalized', contract: {} }; }
      return { state: 'finalized', contract: {} };
    };
    const records = await lib().runAttempts({ requests: [{ id: 'H', request: 'hang', repoPath: '/r' }, { id: 'N', request: 'next', repoPath: '/r' }], n: 1, compileFn, attemptTimeoutMs: 20 });
    assert.deepEqual(records.map((r) => [r.id, r.state, r.valid]), [['H', 'timeout', false], ['N', 'finalized', true]]);
    assert.equal(records[0].first_reason, 'timeout');
    assert.ok(settled);
    assert.deepEqual(order, ['start hang', 'hang settled', 'start next'], 'no two compile calls overlap');
    assert.ok(records[0].drain_ms >= 0);
  });

  test('past runTimeoutMs the remaining attempts are recorded as not_run, so the denominator stays explicit', async () => {
    const compileFn = async () => { await new Promise((r) => setTimeout(r, 30)); return { state: 'invalid', errors: ['no acceptance criteria'] }; };
    const records = await lib().runAttempts({ requests: [{ id: 'A', request: 'a', repoPath: '/r' }], n: 4, compileFn, runTimeoutMs: 45 });
    assert.equal(records.length, 4);
    assert.deepEqual(records.map((r) => r.state), ['invalid', 'invalid', 'not_run', 'not_run']);
    assert.ok(records.slice(2).every((r) => r.first_reason === 'run_timeout' && r.valid === false));
  });

  test('summarize reports each group separately (hero fixture vs dev-r2) and keeps schema-valid apart from usability', () => {
    const rec = (id, group, valid) => ({ id, group, valid, state: valid ? 'finalized' : 'invalid', first_reason: valid ? null : 'x' });
    const s = lib().summarize([rec('HERO-1', 'fixture:hero-demo', true), rec('HERO-1', 'fixture:hero-demo', false), rec('dev-r2/AV-01', 'dev-r2', false)]);
    assert.deepEqual(s.groups, {
      'fixture:hero-demo': { attempts: 2, schema_valid: 1, not_run: 0 },
      'dev-r2': { attempts: 1, schema_valid: 0, not_run: 0 },
    });
    assert.deepEqual(s.semantic, { reviewed: 0, usable: null, note: 'schema-valid contracts need a separate human review for usability; see contracts/' });
  });

  test('loadSet labels each request with its group', () => {
    const { requests } = lib().loadSet(SET);
    assert.ok(requests.filter((r) => r.id.startsWith('HERO-')).every((r) => r.group === 'fixture:hero-demo'));
    assert.ok(requests.filter((r) => r.id.startsWith('dev-r2/')).every((r) => r.group === 'dev-r2'));
  });

  test('summarize: per-request and overall valid rates, and first-reason counts', () => {
    const rec = (id, valid, first_reason, state = valid ? 'finalized' : 'invalid') => ({ id, valid, state, first_reason });
    const s = lib().summarize([rec('A', true, null), rec('A', false, 'x'), rec('B', false, 'x'), rec('B', false, 'y', 'error')]);
    assert.deepEqual(s.overall, { attempts: 4, valid: 1 });
    assert.deepEqual(s.requests, [{ id: 'A', attempts: 2, valid: 1 }, { id: 'B', attempts: 2, valid: 0 }]);
    assert.deepEqual(s.reasons, [{ reason: 'x', count: 2 }, { reason: 'y', count: 1 }]);
    assert.deepEqual(s.states, { finalized: 1, invalid: 2, error: 1 });
  });

  test('the script never loads an agent or the sandbox, even indirectly: compile only, no spend', () => {
    const code = `
      const before = new Set(Object.keys(require.cache));
      require(${JSON.stringify(SCRIPT)}); require(${JSON.stringify(path.join(ROOT, 'intent', 'session'))});
      const loaded = Object.keys(require.cache).filter((f) => !before.has(f) && !f.includes('node_modules'));
      console.log(JSON.stringify(loaded));`;
    const loaded = JSON.parse(execFileSync(process.execPath, ['-e', code], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n').pop());
    assert.ok(loaded.some((f) => f.endsWith(path.join('intent', 'compiler.js'))), 'the real compiler is loaded');
    for (const f of loaded) assert.doesNotMatch(f, /lib[\\/]sandbox|[\\/]agent[\\/]|qb-pipeline|experiment-run/, `${f} is agent or sandbox code`);
  });

  test("its dev-r2 paths are the curated set's", () => {
    assert.deepEqual(lib().SETS['dev-r2'], { specs: curateDirs('dev-r2').specs, lockFile: curateDirs('dev-r2').lockFile });
  });

});
