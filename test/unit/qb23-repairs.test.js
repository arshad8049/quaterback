/**
 * QB-23: successful repairs reach normal memory persistence, linked to the patch
 * that resolved them.
 * - a failed AC repaired on attempt 2 creates exactly ONE traceable resolved repair
 *   (attempt 1 failure + hint → attempt 2 patch hash → attempt 2 criterion met → final PASS);
 * - an unchanged patch, an abandoned task, an unrelated later success, or a run that
 *   did not end in an approved PASS never labels the hint as proven;
 * - recall distinguishes proven repairs from unconfirmed observations and from
 *   legacy (unverified) records.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MEM = fs.mkdtempSync(path.join(os.tmpdir(), 'qb23-mem-'));
process.env.QB_MEMORY_DIR = MEM;                       // memory/store captures this at import
const memory = require('../../memory');
const store = require('../../memory/store');
// memory/repairs is new in QB-23; loaded lazily so the qb.js reproduction also runs on pre-fix code
const attemptEntry = (...a) => require('../../memory/repairs').attemptEntry(...a);
const linkRepairs = (...a) => require('../../memory/repairs').linkRepairs(...a);
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const runStore = require('../../run/store');
const { makeRepo } = require('../helpers/tmprepo');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

after(() => fs.rmSync(MEM, { recursive: true, force: true }));

const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const sha = (s) => (s ? crypto.createHash('sha256').update(s).digest('hex') : null);
const DIFF = (line) => `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,0 +1,1 @@\n+${line}\n`;
const ACS = [
  { id: 'AC-1', criterion: 'README documents the --verbose flag', met: null, kind: 'non_behavioral' },
  { id: 'AC-2', criterion: 'README documents the --json flag', met: null, kind: 'non_behavioral' },
];
const contract = (approved = true) => {
  const c = { id: 'c-23', goal: 'Document the CLI flags', clarifying_question: null, scope: { allowed_changes: ['**'] }, acceptance_criteria: ACS };
  return approved ? approve(c, { via: 'test' }) : c;
};
const exec = (diff) => ({ id: 'e', status: 'completed', diff, changes: [{ file: 'README.md', status: 'M' }],
  sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT } } });

/** A judge that answers per criterion: votes[acId] = true | false. */
async function judged(c, diff, votes) {
  const m = mockFetch((url, init) => {
    const user = JSON.parse(init.body).messages.find((x) => x.role === 'user').content;
    const id = /ID: (AC-\d+)/.exec(user)[1];
    return votes[id] ? ollamaReply({ met: true, evidence: `${id} documented` })
      : ollamaReply({ met: false, evidence: `${id} missing`, repair: `Document the flag for ${id} in README.md` });
  });
  try { return await verify(c, null, exec(diff), {}); } finally { m.restore(); }
}

/** Run a scripted attempt sequence through real verify(); returns { history, final }. */
async function attempts(c, seq) {
  const history = [];
  let report;
  for (const [i, { diff, votes }] of seq.entries()) {
    report = await judged(c, diff, votes);
    history.push(attemptEntry(i + 1, report, sha(diff)));
  }
  return { history, final: report };
}
const repo = (name) => `/repos/${name}-${crypto.randomBytes(4).toString('hex')}`;

describe('a failed AC repaired on attempt two creates one traceable resolved repair', () => {
  test('pre-fix shape: remember() with only the final PASS report saves zero repairs; with the attempt history it saves exactly one, proven', async () => {
    const c = contract();
    const { history, final } = await attempts(c, [
      { diff: DIFF('flags: TODO'), votes: { 'AC-1': false, 'AC-2': true } },
      { diff: DIFF('--verbose prints every stage; --json prints JSON'), votes: { 'AC-1': true, 'AC-2': true } },
    ]);
    assert.equal(final.verdict, 'pass');
    const legacy = repo('legacy');
    await memory.remember(legacy, c, { ...final, attempts: 2 }, exec(DIFF('x')));
    assert.equal(store.readRepairs(legacy).length, 0, 'the final report alone carries no repair (pre-fix: and nothing else was passed)');

    const r = repo('linked');
    await memory.remember(r, c, { ...final, attempts: 2 }, exec(DIFF('x')), { history, runId: 'run-1' });
    const saved = store.readRepairs(r);
    assert.equal(saved.length, 1, JSON.stringify(saved, null, 1));
    const rec = saved[0];
    assert.deepEqual([rec.failed_criterion, rec.outcome, rec.resolved, rec.from_attempt, rec.to_attempt], ['AC-1', 'resolved', true, 1, 2]);
    assert.equal(rec.patch_before_sha256, sha(DIFF('flags: TODO')));
    assert.equal(rec.patch_after_sha256, sha(DIFF('--verbose prints every stage; --json prints JSON')));
    assert.deepEqual([rec.before.met, rec.after.met, rec.final.verdict, rec.final.oracle_approved], [false, true, 'pass', true]);
    assert.ok(rec.after.evidence_ids.length > 0, 'the re-evaluation evidence is linked');
    assert.equal(rec.source, 'model_suggestion');
    assert.match(rec.fix, /Document the flag for AC-1/);
    assert.equal(rec.run_id, 'run-1');
    // the attempt history (patch and evidence hashes) is kept with the outcome, append-only
    const outcome = store.readOutcomes(r).at(-1);
    assert.deepEqual(outcome.attempt_history.map((a) => [a.attempt, a.patch_sha256, a.verdict]),
      [[1, sha(DIFF('flags: TODO')), 'fail'], [2, sha(DIFF('--verbose prints every stage; --json prints JSON')), 'pass']]);
    assert.ok(outcome.attempt_history.every((a) => /^[0-9a-f]{64}$/.test(a.evidence_sha256)));
  });
});

describe('nothing else labels a hint as proven', () => {
  test('an unchanged patch: the hint is unresolved (unchanged_patch), even if the vote flipped', async () => {
    const c = contract();
    const { history } = await attempts(c, [
      { diff: DIFF('flags: TODO'), votes: { 'AC-1': false, 'AC-2': true } },
      { diff: DIFF('flags: TODO'), votes: { 'AC-1': true, 'AC-2': true } },
    ]);
    const [link] = linkRepairs(history);
    assert.deepEqual([link.outcome, link.reason], ['unresolved', 'unchanged_patch']);
  });
  test('an abandoned task (no later attempt): not_attempted', async () => {
    const c = contract();
    const { history } = await attempts(c, [{ diff: DIFF('flags: TODO'), votes: { 'AC-1': false, 'AC-2': true } }]);
    const [link] = linkRepairs(history);
    assert.deepEqual([link.outcome, link.reason], ['not_attempted', 'no_later_attempt']);
  });
  test('an unrelated later success: a different criterion fixed does not prove the hint; the hint that did fix it is the one proven', async () => {
    const c = contract();
    const { history, final } = await attempts(c, [
      { diff: DIFF('a'), votes: { 'AC-1': false, 'AC-2': false } },
      { diff: DIFF('b'), votes: { 'AC-1': false, 'AC-2': true } },   // AC-2 fixed, AC-1 still failing
      { diff: DIFF('c'), votes: { 'AC-1': true, 'AC-2': true } },    // AC-1 fixed by the attempt-2 hint
    ]);
    assert.equal(final.verdict, 'pass');
    const links = linkRepairs(history).map((l) => [l.criterion_id, l.from_attempt, l.outcome]);
    assert.deepEqual(links, [['AC-1', 1, 'unresolved'], ['AC-2', 1, 'resolved'], ['AC-1', 2, 'resolved']]);
    const r = repo('unrelated');
    await memory.remember(r, c, { ...final, attempts: 3 }, exec(DIFF('c')), { history });
    assert.equal(store.readRepairs(r).filter((x) => x.failed_criterion === 'AC-1' && x.resolved).length, 1);
  });
  test('a criterion that flips to met but the run does not end in an approved PASS: observed, unconfirmed — never proven', async () => {
    const c = contract(false);                                       // oracle not approved → never PASS
    const { history, final } = await attempts(c, [
      { diff: DIFF('a'), votes: { 'AC-1': false, 'AC-2': true } },
      { diff: DIFF('b'), votes: { 'AC-1': true, 'AC-2': true } },
    ]);
    assert.notEqual(final.verdict, 'pass');
    const [link] = linkRepairs(history);
    assert.deepEqual([link.outcome, link.resolved], ['observed_resolved_unconfirmed', false]);
  });
  test('a hint for something that was not a failing criterion (test / policy / not failing) is not tracked as resolved', () => {
    const h = [
      { attempt: 1, patch_sha256: 'a'.repeat(64), evidence_sha256: 'e'.repeat(64), report_id: 'r1', verdict: 'fail', oracle_approved: true,
        criteria: [{ id: 'AC-1', met: null, method: 'llm-vote-3', evidence_ids: [] }],
        repair_hints: [{ criterion_id: 'TEST:test/x.test.js:a', diagnosis: 'd', suggested_fix: 'f' }, { criterion_id: 'AC-1', diagnosis: 'd', suggested_fix: 'f' }] },
      { attempt: 2, patch_sha256: 'b'.repeat(64), evidence_sha256: 'f'.repeat(64), report_id: 'r2', verdict: 'pass', oracle_approved: true,
        criteria: [{ id: 'AC-1', met: true, method: 'llm-vote-3', evidence_ids: [] }], repair_hints: [] },
    ];
    assert.deepEqual(linkRepairs(h).map((l) => [l.criterion_id, l.outcome, l.reason]),
      [['TEST:test/x.test.js:a', 'not_tracked', 'not_an_acceptance_criterion'], ['AC-1', 'unresolved', 'criterion_was_not_failing']]);
  });
});

describe('recall distinguishes proven repairs from suggestions', () => {
  test('resolved → proven; observed → unconfirmed; unresolved / not_attempted are not recalled; legacy records are labeled unverified', async () => {
    const r = repo('recall');
    const base = { ts: new Date().toISOString(), repo_path: r, goal_keywords: ['readme'], crit_keywords: ['readme', 'verbose', 'flag'], diagnosis: 'README misses --verbose', contract_id: 'c' };
    store.appendRepair(r, { ...base, id: crypto.randomUUID(), failed_criterion: 'AC-1', fix: 'legacy fix', resolved: true });   // pre-QB-23 record
    const c = contract();
    const { history, final } = await attempts(c, [
      { diff: DIFF('a'), votes: { 'AC-1': false, 'AC-2': false } },
      { diff: DIFF('b'), votes: { 'AC-1': true, 'AC-2': false } },
    ]);
    await memory.remember(r, c, { ...final, attempts: 2 }, exec(DIFF('b')), { history });   // AC-1 observed (run failed), AC-2 unresolved
    const got = memory.recallRepairs(r, [{ id: 'AC-9', criterion: 'README documents the --verbose flag' }, { id: 'AC-8', criterion: 'README documents the --json flag' }]);
    const statuses = got.map((g) => g.status).sort();
    assert.ok(!statuses.includes('unresolved') && !statuses.includes('not_attempted'), JSON.stringify(got));
    assert.ok(got.every((g) => g.proven === (g.status === 'resolved')));
    assert.ok(statuses.includes('observed_resolved_unconfirmed') || statuses.includes('legacy_unverified'), JSON.stringify(got));
  });
});

describe('through qb.js: the real run loop links the repair to the patch that followed it', () => {
  const ROOT = path.join(__dirname, '..', '..');
  const PRELOAD = path.join(ROOT, 'test', 'helpers', 'preload-ollama.js');
  const PRELOAD_AGENT = path.join(ROOT, 'test', 'helpers', 'preload-fake-sandbox.js');
  let tmp, r;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb23-cli-'));
    r = makeRepo({ 'README.md': '# demo\n' });
  });
  after(() => { r.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('fail on attempt 1, criterion met on attempt 2 (no sandbox tests → not an approved PASS): one repair, observed and unconfirmed, with both patch hashes from the run record (pre-fix: zero)', () => {
    const file = path.join(tmp, 'contract.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'Document --verbose', required_behavior: ['README documents --verbose'],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'README documents the --verbose flag', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
      verification_plan: ['read README'], requirements: [{ id: 'R-1', quote: 'Document --verbose' }], scope: { allowed_changes: ['**'] } }));
    const script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ attempts: [{ steps: [{ write: 'docs/a.md', content: 'TODO\n' }] }, { steps: [{ write: 'docs/b.md', content: '--verbose prints stages\n' }] }] }));
    const no = JSON.stringify({ met: false, evidence: 'README lacks --verbose', repair: 'Document --verbose in README.md' });
    const yes = JSON.stringify({ met: true, evidence: 'README documents --verbose' });
    const res = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'qb.js'), 'Document --verbose',
      '--repo', r.dir, '--agent', 'claude-code', '--no-llm-context', '--max-retries', '3', '--contract-file', file],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_FAKE_AGENT_COUNTER: path.join(tmp, 'counter'),
      QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_JUDGE_CACHE_DIR: path.join(tmp, 'judge-cache'),
      QB_TEST_OLLAMA_SEQUENCE: JSON.stringify([no, no, no, yes]) } });
    const [id] = fs.readdirSync(path.join(tmp, 'runs'));
    const run = runStore.loadRun(id, path.join(tmp, 'runs'));
    assert.equal(run.manifest.attempts.length, 2, res.stdout + res.stderr);
    const memDir = path.join(tmp, 'mem');
    const lines = fs.readdirSync(memDir).flatMap((d) => {
      const f = path.join(memDir, d, 'repairs.jsonl');
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    });
    assert.equal(lines.length, 1, res.stdout + res.stderr);
    const [rec] = lines;
    assert.deepEqual([rec.failed_criterion, rec.outcome, rec.resolved, rec.from_attempt, rec.to_attempt], ['AC-1', 'observed_resolved_unconfirmed', false, 1, 2]);
    assert.equal(rec.patch_before_sha256, run.manifest.attempts[0].patch_sha256);
    assert.equal(rec.patch_after_sha256, run.manifest.attempts[1].patch_sha256);
    assert.equal(rec.run_id, run.manifest.run_id);
  });
});
