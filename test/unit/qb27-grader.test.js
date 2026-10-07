/**
 * QB-27: both arms are scored by an external grader against a frozen, human-written
 * task spec and a hidden suite — never against QB's generated contract.
 * Unit level: a host-side stand-in replaces the sandbox (fixture code only); the real
 * sandbox path is covered in test/integration/qb27-grader.test.js.
 */
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { grade, gradeArm, graderHash, patchPaths } = require('../../bench/grader');
const { qualify } = require('../../bench/qualify');
const { freeze, checkFrozen } = require('../../bench/spec');
const adj = require('../../bench/adjudicate');
const S = require('../../bench/schemas');
const { gradingFixture, hostRunner, INVENTED_CONTRACT } = require('../helpers/grading-fixture');

// The live node:test reporter needs test:summary (Node 22+; CI runs 22 and 24, the sandbox 24).
const MAJOR = Number(process.versions.node.split('.')[0]);
const LIVE = { skip: MAJOR < 22 && `node ${process.version} has no test:summary event` };

const fixtures = [];
const fx = (o) => { const f = gradingFixture(o); fixtures.push(f); return f; };
after(() => { for (const f of fixtures) f.cleanup(); });

/** A qualified copy of the fixture spec (reference + two incorrect implementations). */
async function qualified(f) {
  const q = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: hostRunner(),
    reference: f.patch('correct'), incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
  return { ...f.spec, qualification: q };
}
const g = (f, spec, patch, extra = {}) => grade({ spec, patch, suitesRoot: f.suitesRoot, runSandboxed: hostRunner(extra.calls), ...extra });

describe('QB-27: grading is independent of QB\'s contract', LIVE, () => {
  test('the review example: a correct 30s patch passes and the invented 5m patch fails, whatever the contract says', async () => {
    const f = fx(); const spec = await qualified(f);
    const ok = await grade({ spec, patch: f.patch('correct'), contract: INVENTED_CONTRACT, suitesRoot: f.suitesRoot, runSandboxed: hostRunner() });
    assert.deepEqual([ok.outcome, ok.reason], ['pass', 'tests_passed']);
    assert.deepEqual(ok.checks.map((c) => c.status), ['passed', 'passed']);
    const five = await grade({ spec, patch: f.patch('fiveMinutes'), contract: INVENTED_CONTRACT, suitesRoot: f.suitesRoot, runSandboxed: hostRunner() });
    assert.deepEqual([five.outcome, five.reason], ['fail', 'tests_failed']);
  });

  test('grader spy: no contract, criteria, briefing or checks reach the grading run', async () => {
    const f = fx(); const spec = await qualified(f); const calls = [];
    await grade({ spec, patch: f.patch('correct'), contract: INVENTED_CONTRACT, internal_verdict: 'pass', arm: 'E',
      suitesRoot: f.suitesRoot, runSandboxed: hostRunner(calls) });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.deepEqual(Object.keys(call).sort(), ['baseTests', 'briefing', 'noAgent', 'repoPath', 'verify']);
    assert.deepEqual([call.briefing, call.noAgent, call.baseTests], ['', true, false]);
    assert.doesNotMatch(JSON.stringify(call), /5m|AC-1|acceptance/);
  });

  test('the grade record is a valid qb-grade/1 bound to spec, patch and grader hashes; no network, no credentials', async () => {
    const f = fx(); const spec = await qualified(f); const patch = f.patch('correct');
    const r = await g(f, spec, patch);
    S.Grade.parse(r);
    assert.equal(r.spec_sha256, S.specHash(spec));
    assert.equal(r.patch_sha256, S.sha256(Buffer.from(patch)));
    assert.equal(r.grader_sha256, graderHash());
    assert.deepEqual([r.environment.network, r.environment.credentials], ['none', 'none']);
  });
});

describe('QB-27: the benchmark scores arms only through the grader', LIVE, () => {
  test('gradeArm: the score comes from the grader for every arm; the internal verdict and contract are never consulted', async () => {
    const f = fx(); const spec = await qualified(f); const calls = [];
    // QB's own pipeline said PASS for the 5m patch (its contract asked for 5m) — the score is still fail
    const qbArm = { patch: f.patch('fiveMinutes'), final_verdict: 'pass', contract: INVENTED_CONTRACT };
    const baseArm = { patch: f.patch('correct'), verdict: 'fail' };
    const q = await gradeArm(spec, qbArm, { suitesRoot: f.suitesRoot, runSandboxed: hostRunner(calls) });
    const b = await gradeArm(spec, baseArm, { suitesRoot: f.suitesRoot, runSandboxed: hostRunner(calls) });
    assert.deepEqual([q.outcome, b.outcome], ['fail', 'pass']);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(calls), /5m"|AC-1/);
  });
  test('no frozen spec, or a blocked arm, is ungraded — never a pass or a fail', async () => {
    assert.equal((await gradeArm(null, { patch: 'x', final_verdict: 'pass' })).outcome, 'ungraded');
    const f = fx();
    assert.equal((await gradeArm(f.spec, { blocked: 'needs_oracle' })).outcome, 'ungraded');
  });
});

describe('QB-27: precise grading outcomes', LIVE, () => {
  test('a syntax error, a patch that does not apply, and an empty (no-change) patch all FAIL', async () => {
    const f = fx(); const spec = await qualified(f);
    const syn = await g(f, spec, f.patch('syntaxError'));
    assert.deepEqual([syn.outcome, syn.reason], ['fail', 'syntax_or_load_error']);
    const bad = await g(f, spec, 'diff --git a/src/nope.js b/src/nope.js\n--- a/src/nope.js\n+++ b/src/nope.js\n@@ -1 +1 @@\n-x\n+y\n');
    assert.deepEqual([bad.outcome, bad.reason], ['fail', 'patch_does_not_apply']);
    const none = await g(f, spec, '');
    assert.deepEqual([none.outcome, none.reason], ['fail', 'tests_failed']);
  });

  test('a patch touching a grader-owned path fails before anything runs', async () => {
    const f = fx({ extra: {} }); const spec = await qualified(f);
    for (const files of [{ 'test/hidden/duration.test.js': 'cheat' }, { '.quarterback.json': '{}' }]) {
      const calls = [];
      const r = await g(f, spec, f.makePatch({ 'src/duration.js': 'x', ...files }), { calls });
      assert.deepEqual([r.outcome, r.reason], ['fail', 'grader_owned_path'], JSON.stringify(files));
      assert.equal(calls.length, 0);
    }
  });

  test('grader faults are grader_error, never a fail: unqualified suite, changed suite, changed grader, missing suite command', async () => {
    const f = fx(); const spec = await qualified(f);
    assert.equal((await g(f, { ...spec, qualification: null }, f.patch('correct'))).reason, 'suite_not_qualified');
    assert.equal((await g(f, { ...spec, qualification: { ...spec.qualification, grader_sha256: 'f'.repeat(64) } }, f.patch('correct'))).reason, 'grader_changed');
    fs.appendFileSync(path.join(f.suitesRoot, 'T-30S', 'duration.test.js'), '// edited\n');
    const changed = await g(f, spec, f.patch('correct'));
    assert.deepEqual([changed.outcome, changed.reason], ['grader_error', 'suite_changed']);
    const f2 = fx(); const s2 = await qualified(f2);
    const cmd = { ...s2, suite: { ...s2.suite, command: ['no-such-runner-qb27'] } };
    const missing = await grade({ spec: cmd, patch: f2.patch('correct'), suitesRoot: f2.suitesRoot, runSandboxed: hostRunner() });
    assert.deepEqual([missing.outcome, missing.reason], ['grader_error', 'suite_command_missing']);
  });

  test('an unavailable sandbox is infra_error, recorded separately from pass/fail', async () => {
    const f = fx(); const spec = await qualified(f);
    const r = await grade({ spec, patch: f.patch('correct'), suitesRoot: f.suitesRoot, runSandboxed: async () => ({ status: 'blocked', reason: 'sandbox_unavailable', sandbox: {} }) });
    assert.deepEqual([r.outcome, r.reason], ['infra_error', 'infra_error']);
    assert.ok(!S.SCORED_OUTCOMES.includes(r.outcome));
  });

  test('needs_adjudication only for checks the frozen spec reserves — never as a catch-all', async () => {
    const f = fx(); const base = await qualified(f);
    const spec = { ...base, suite: { ...base.suite, adjudicate_checks: ['90,000 ms is 1m 30s'] } };
    const r = await g(f, spec, f.patch('correct'));
    assert.deepEqual([r.outcome, r.reason], ['needs_adjudication', 'adjudication_required']);
    assert.deepEqual(r.checks.map((c) => c.status), ['passed', 'adjudicate']);
    const wrong = await g(f, spec, f.patch('fiveMinutes'));   // a non-reserved check fails → plain fail
    assert.equal(wrong.outcome, 'fail');
    const syn = await g(f, spec, f.patch('syntaxError'));
    assert.equal(syn.outcome, 'fail');
  });
});

describe('QB-27: the hidden suite stays hidden', () => {
  test('a suite inside the task repository is refused (suite_leaked)', LIVE, async () => {
    const f = fx(); const spec = await qualified(f);
    const inner = path.join(f.repo.dir, 'hidden-suites');   // untracked, but inside the checkout the agent works on
    fs.cpSync(path.join(f.suitesRoot, 'T-30S'), path.join(inner, 'T-30S'), { recursive: true });
    const r = await grade({ spec, patch: f.patch('correct'), suitesRoot: inner, runSandboxed: hostRunner() });
    assert.deepEqual([r.outcome, r.reason], ['grader_error', 'suite_leaked']);
    assert.match(r.detail, /inside the task repository/);
  });

  test('a suite file present anywhere in the task repository history is refused (suite_leaked)', LIVE, async () => {
    const f = fx(); const spec = await qualified(f);
    const suiteText = fs.readFileSync(path.join(f.suitesRoot, 'T-30S', 'duration.test.js'));
    spawnSync('git', ['checkout', '-q', '-b', 'old-branch'], { cwd: f.repo.dir });
    f.repo.write('notes/copy.js', suiteText); f.repo.commit('leak');
    spawnSync('git', ['rm', '-q', 'notes/copy.js'], { cwd: f.repo.dir }); f.repo.commit('remove leak');
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: f.repo.dir });
    const r = await g(f, spec, f.patch('correct'));
    assert.deepEqual([r.outcome, r.reason], ['grader_error', 'suite_leaked']);
    assert.match(r.detail, /object database/);
  });

  test('the agent-visible workspace (pinned checkout) never contains the suite or the grader test plan', async () => {
    const f = fx();
    const { createWorkspace } = require('../../lib/workspace');
    const ws = createWorkspace(f.repo.dir, { baseRev: f.spec.repo.base_rev });
    try {
      assert.ok(!fs.existsSync(path.join(ws.dir, 'test/hidden')));
      assert.ok(!fs.existsSync(path.join(ws.dir, '.quarterback.json')));
      const all = spawnSync('git', ['log', '--all', '-p'], { cwd: ws.dir, encoding: 'utf8' }).stdout;
      assert.doesNotMatch(all, /30,000 ms is 30s/);
    } finally { ws.cleanup(); }
  });

  test('patchPaths reads both sides of renames and refuses an unparseable header', () => {
    assert.deepEqual(patchPaths('diff --git a/x.js b/test/hidden/x.js\nsimilarity index 100%\n'), ['test/hidden/x.js', 'x.js']);
    assert.equal(patchPaths('diff --git garbage\n'), null);
  });
});

describe('QB-27: qualification and freezing', LIVE, () => {
  test('a suite is qualified only if the reference passes and every incorrect implementation fails its tests', async () => {
    const f = fx(); const spec = await qualified(f);
    assert.equal(spec.qualification.incorrect.length, 2);
    assert.equal(spec.qualification.grader_sha256, graderHash());
    // a suite too weak to tell "5m" apart is NOT qualified
    const weak = fx({ suite: { 'duration.test.js': "const { test } = require('node:test');\ntest('loads', () => require('../../src/duration'));\n" } });
    await assert.rejects(qualify({ spec: weak.spec, suitesRoot: weak.suitesRoot, runSandboxed: hostRunner(), reference: weak.patch('correct'),
      incorrect: [{ label: '5m', patch: weak.patch('fiveMinutes') }, { label: 'off-by-one', patch: weak.patch('offByOne') }] }), /5m: expected fail/);
    await assert.rejects(qualify({ spec: f.spec, suitesRoot: f.suitesRoot, runSandboxed: hostRunner(), reference: f.patch('correct'),
      incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }] }), /at least two/);
  });

  test('freezing needs qualification; a frozen spec cannot be edited; a new version needs a disclosed changelog entry', async () => {
    const f = fx(); const lockFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qb-lock-')), 'specs.lock.json');
    assert.throws(() => freeze(f.spec, { lockFile, suitesRoot: f.suitesRoot }), /not qualified/);
    const spec = await qualified(f);
    freeze(spec, { lockFile, suitesRoot: f.suitesRoot });
    checkFrozen(spec, JSON.parse(fs.readFileSync(lockFile, 'utf8')));
    const edited = { ...spec, requirement: `${spec.requirement} (revised after viewing results)` };
    assert.throws(() => freeze(edited, { lockFile, suitesRoot: f.suitesRoot }), /new version/);
    assert.throws(() => checkFrozen(edited, JSON.parse(fs.readFileSync(lockFile, 'utf8'))), /does not match the frozen/);
    assert.throws(() => freeze({ ...edited, version: 2 }, { lockFile, suitesRoot: f.suitesRoot }), /changelog/);
    freeze({ ...edited, version: 2, changelog: [{ version: 2, reason: 'clarified wording', disclosed_at: '2026-10-07T01:00:00Z', after_viewing_results: true }] },
      { lockFile, suitesRoot: f.suitesRoot });
  });
});

describe('QB-27: blinded adjudication', LIVE, () => {
  test('packets carry no arm, trial, or internal verdict; order is seeded; verdicts are never overwritten; disagreement stays visible', async () => {
    const f = fx(); const base = await qualified(f);
    const spec = { ...base, suite: { ...base.suite, adjudicate_checks: ['90,000 ms is 1m 30s'] } };
    const items = [];
    for (const [trial_id, arm] of [['t1', 'A'], ['t1', 'E'], ['t2', 'A'], ['t2', 'E']]) {
      const patch = f.patch('correct');
      items.push({ trial_id, arm, spec, patch, internal_verdict: arm === 'E' ? 'pass' : null, grade: await g(f, spec, patch) });
    }
    const { packets, blindMap } = adj.prepare(items, { seed: 's1' });
    const text = JSON.stringify(packets);
    assert.doesNotMatch(text, /"arm"|"trial_id"|internal_verdict|"E"|"t1"/);
    assert.deepEqual(adj.prepare(items, { seed: 's1' }).packets.map((p) => p.item_id), packets.map((p) => p.item_id));
    assert.equal(Object.keys(blindMap.items).length, 4);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-adj-'));
    const v = (adjudicator, verdict) => ({ experiment_id: 'exp-1', item_id: packets[0].item_id, adjudicator, verdict, rationale: 'r', at: '2026-10-07T00:00:00Z' });
    adj.record(dir, v('alice', 'pass'));
    assert.throws(() => adj.record(dir, v('alice', 'fail')), /EEXIST/);
    adj.record(dir, v('bob', 'fail'));
    const sum = adj.summarize(dir)[packets[0].item_id];
    assert.deepEqual([sum.agreed, sum.disagreement, sum.verdicts.length], [null, true, 2]);
    assert.throws(() => adj.prepare([{ ...items[0], grade: { ...items[0].grade, outcome: 'fail' } }], { seed: 's' }), /not awaiting adjudication/);
  });
});
