/**
 * QB-09: scope and constraints are enforced policy, from the approved contract.
 * - a forbidden (protected) file change blocks PASS even when every judge vote is positive;
 * - a newly relevant file is not silently authorized (retrieval relevance is not
 *   authorization; widening scope means a new approval);
 * - each declared constraint maps to evidence (scope / executable check) or is
 *   explicitly advisory, else it is an explicit unresolved item.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { evaluatePolicy, policyErrors, changedFiles } = require('../../verify/policy');
const { contractState, approve, approvalState } = require('../../intent/contract-state');
const { aggregate, inputFromReport } = require('../../verify/verdict');
const { verify } = require('../../verify/verifier');
const { buildBriefing } = require('../../agent/briefing');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const CHANGE = (file) => ({ file, status: 'M', additions: 1, deletions: 0 });
const DIFF = (...files) => files.map((f) => `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-x\n+y\n`).join('');
const contract = (extra = {}) => approve({ id: 'c', goal: 'Add clamp', clarifying_question: null,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'README explains clamp', met: null, kind: 'non_behavioral' }],
  scope: { allowed_changes: ['src/**', 'README.md'], protected_paths: ['src/legacy/**', 'package-lock.json'] }, ...extra }, { via: 'test' });
const exec = (files, extra = {}) => ({ id: 'e', status: 'completed', diff: DIFF(...files), changes: files.map(CHANGE),
  sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT } }, ...extra });

async function run(c, e, ctx = null) {
  const m = mockFetch(ollamaReply({ met: true, evidence: 'README.md explains clamp' }));     // every judge vote positive
  try { return await verify(c, ctx, e, {}); } finally { m.restore(); }
}

describe('scope: forbidden and unauthorized changes', () => {
  test('in scope, every vote positive, tests pass → PASS (the baseline for the cases below)', async () => {
    const r = await run(contract(), exec(['src/clamp.js', 'README.md']));
    assert.equal(r.verdict, 'pass');
    assert.equal(r.policy.effect, 'ok');
  });
  test('a protected path changed → FAIL even though every judge vote is positive', async () => {
    const r = await run(contract(), exec(['src/clamp.js', 'src/legacy/old.js']));
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(r.policy.protected_touched, ['src/legacy/old.js']);
    assert.ok(r.repair_hints.some((h) => /Revert all changes to src\/legacy\/old\.js/.test(h.suggested_fix)));
  });
  test('a newly relevant file outside allowed_changes is not silently authorized → unresolved', async () => {
    const ctx = { relevant_files: [{ path: 'lib/new-helper.js' }], patterns: {} };                // L2 found it relevant
    const r = await run(contract(), exec(['src/clamp.js', 'lib/new-helper.js']), ctx);
    assert.equal(r.verdict, 'unresolved');
    assert.deepEqual(r.policy.out_of_scope, ['lib/new-helper.js']);
    assert.deepEqual(r.scope_violations, ['lib/new-helper.js']);
  });
  test('widening the scope after approval voids the approval (an explicit policy update needs a new approval)', async () => {
    const widened = { ...contract(), scope: { allowed_changes: ['src/**', 'README.md', 'lib/**'], protected_paths: ['src/legacy/**'] } };
    assert.deepEqual(approvalState(widened), { approved: false, reason: 'changed_after_approval' });
    assert.notEqual((await run(widened, exec(['src/clamp.js', 'lib/new-helper.js']))).verdict, 'pass');
    const reapproved = approve(widened, { via: 'interactive' });
    assert.equal((await run(reapproved, exec(['src/clamp.js', 'lib/new-helper.js']))).verdict, 'pass');
  });
  test('no declared scope: any change is unauthorized (relevance is never an allowlist)', async () => {
    const c = contract({ scope: undefined });
    assert.equal((await run(c, exec(['src/clamp.js']), { relevant_files: [{ path: 'src/clamp.js' }], patterns: {} })).verdict, 'unresolved');
  });
  test('changed files come from the captured changes AND the diff (both sides of a rename)', () => {
    assert.deepEqual(changedFiles({ changes: [], diff: 'diff --git a/src/a.js b/src/legacy/a.js\n' }), ['src/a.js', 'src/legacy/a.js']);
    assert.deepEqual(changedFiles({ changes: [CHANGE('x.js')], unsupported_changes: ['vendor/.git/config'], diff: '' }), ['vendor/.git/config', 'x.js']);
    const p = evaluatePolicy(contract(), { changes: [], diff: 'diff --git a/src/a.js b/src/legacy/a.js\n' });
    assert.equal(p.effect, 'fail');
  });
});

describe('constraints: evidence or an explicit unresolved item', () => {
  const CHK = { id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/clamp.js', export: 'clamp', args: [5, 0, 3], expect: 3 } };
  const C = (policy, checks = []) => contract({ constraints: ['Do not touch the legacy module', 'clamp must not throw on min > max', 'Keep the code readable'],
    constraint_policy: policy, checks });
  test('each constraint is enforced by the scope, by a check, or explicitly advisory', () => {
    const c = C([{ constraint: 0, enforced_by: [{ kind: 'protected_paths', ref: 'src/legacy/**' }] },
      { constraint: 1, enforced_by: [{ kind: 'check', ref: 'CHK-1' }] }, { constraint: 2, advisory: true }], [CHK]);
    const ok = evaluatePolicy(c, exec(['src/clamp.js']), [{ id: 'CHK-1', status: 'pass' }]);
    assert.deepEqual(ok.constraints.map((x) => x.status), ['enforced', 'enforced', 'advisory']);
    assert.equal(ok.effect, 'ok');
    assert.deepEqual(evaluatePolicy(c, exec(['src/legacy/x.js']), [{ id: 'CHK-1', status: 'pass' }]).constraints[0].status, 'violated');
    assert.equal(evaluatePolicy(c, exec(['src/clamp.js']), [{ id: 'CHK-1', status: 'fail' }]).effect, 'fail');
    assert.equal(evaluatePolicy(c, exec(['src/clamp.js']), []).constraints[1].status, 'unresolved', 'a check that never ran is no evidence');
  });
  test('a constraint without enforcement is an explicit unresolved item and blocks PASS', async () => {
    const c = C([{ constraint: 0, enforced_by: [{ kind: 'protected_paths', ref: 'src/legacy/**' }] }, { constraint: 2, advisory: true }]);
    const r = await run(c, exec(['src/clamp.js']));
    assert.equal(r.verdict, 'unresolved');
    assert.deepEqual(r.policy.constraints.map((x) => [x.index, x.status]), [[0, 'enforced'], [1, 'unresolved'], [2, 'advisory']]);
  });
  test('a violated constraint fails the task with a repair hint', async () => {
    const c = C([{ constraint: 0, enforced_by: [{ kind: 'protected_paths', ref: 'src/legacy/**' }] }, { constraint: 1, advisory: true }, { constraint: 2, advisory: true }]);
    const r = await run(c, exec(['src/legacy/x.js']));
    assert.equal(r.verdict, 'fail');
    assert.ok(r.repair_hints.some((h) => h.criterion_id === 'CONSTRAINT-0'));
  });
});

describe('the policy is validated before anything runs', () => {
  const BAD = {
    'escaping glob':              { scope: { allowed_changes: ['../outside/**'] } },
    'absolute glob':              { scope: { protected_paths: ['/etc/**'] } },
    'not an array':               { scope: { allowed_changes: 'src/**' } },
    'policy for no constraint':   { constraints: ['a'], constraint_policy: [{ constraint: 3, advisory: true }] },
    'enforced by nothing':        { constraints: ['a'], constraint_policy: [{ constraint: 0 }] },
    'unknown check':              { constraints: ['a'], constraint_policy: [{ constraint: 0, enforced_by: [{ kind: 'check', ref: 'NOPE' }] }] },
    'undeclared protected path':  { constraints: ['a'], constraint_policy: [{ constraint: 0, enforced_by: [{ kind: 'protected_paths', ref: 'db/**' }] }] },
    'unknown enforcement':        { constraints: ['a'], constraint_policy: [{ constraint: 0, enforced_by: [{ kind: 'shell', ref: 'grep x' }] }] },
    'duplicate entries':          { constraints: ['a'], constraint_policy: [{ constraint: 0, advisory: true }, { constraint: 0, advisory: true }] },
  };
  for (const [name, extra] of Object.entries(BAD)) {
    test(`${name} → the contract is invalid`, () => {
      const c = { id: 'c', goal: 'g', clarifying_question: null, acceptance_criteria: [{ id: 'AC-1', criterion: 'x' }], ...extra };
      assert.ok(policyErrors(c).length, name);
      assert.equal(contractState(c).state, 'invalid');
    });
  }
});

describe('agent briefing, replay', () => {
  test('the agent is told the enforced scope', () => {
    const b = buildBriefing(contract(), null);
    assert.match(b, /## Scope — enforced/);
    assert.match(b, /You may change only: `src\/\*\*`, `README\.md`/);
    assert.match(b, /Never change: `src\/legacy\/\*\*`, `package-lock\.json`/);
  });
  test('rules 4 is stored and replays; older inputs replay without the policy rule', async () => {
    const e = exec(['src/legacy/old.js']);
    const r = await run(contract(), e);
    const input = inputFromReport(r, e);
    assert.deepEqual([input.rules, input.policyEffect, aggregate(input).verdict], [5, 'fail', 'fail']);
    assert.equal(aggregate({ ...input, rules: 3 }).verdict, 'pass', 'the same evidence under rules 3 (pre-QB-09)');
  });
});

describe('QB-09 re-review: one exact path semantics for every captured name', () => {
  // Every JS line terminator plus other control characters a real Git path may contain.
  const ODD = { newline: 'src/a\nb.js', cr: 'src/a\rb.js', crlf: 'src/a\r\nb.js', ls: 'src/a b.js', ps: 'src/a b.js', tab: 'src/a\tb.js', esc: 'src/a\u001bb.js' };
  const overlap = (extra = {}) => contract({ scope: { allowed_changes: ['src/*'], protected_paths: ['src/**'] }, ...extra });

  for (const [name, file] of Object.entries(ODD)) {
    test(`${name} in a changed filename: overlapping allow "src/*" / protect "src/**" → protected wins (FAIL)`, () => {
      const p = evaluatePolicy(overlap(), { changes: [CHANGE(file)], diff: '' });
      assert.equal(p.effect, 'fail');
      assert.deepEqual(p.protected_touched, [file]);
      assert.deepEqual(p.unsupported_paths, [file]);
    });
    test(`${name} in a changed filename that is only allowed (not protected) → never ok: unsupported, unresolved`, () => {
      const c = contract({ scope: { allowed_changes: ['src/**'], protected_paths: ['docs/**'] } });
      const p = evaluatePolicy(c, { changes: [CHANGE(file)], diff: '' });
      assert.equal(p.effect, 'unresolved');
      assert.deepEqual(p.unsupported_paths, [file]);
    });
  }

  test('every wildcard matches line terminators the same way (whole-string, no partial-line match)', () => {
    for (const file of Object.values(ODD)) {
      const globs = ['src/**', 'src/*', '**', '**/*.js', ...([...file].length === 9 ? ['src/a?b.js'] : [])];   // `?` = exactly one character (CRLF is two)
      for (const g of globs) {
        const p = evaluatePolicy(contract({ scope: { allowed_changes: [], protected_paths: [g] } }), { changes: [CHANGE(file)], diff: '' });
        assert.deepEqual(p.protected_touched, [file], `${JSON.stringify(g)} must match ${JSON.stringify(file)}`);
      }
    }
    // whole-string: a protected "src/x.js" does not match a name that only CONTAINS it on one line
    const p = evaluatePolicy(contract({ scope: { allowed_changes: ['**'], protected_paths: ['src/x.js'] } }), { changes: [CHANGE('src/x.js\nother')], diff: '' });
    assert.deepEqual(p.protected_touched, []);
    assert.equal(p.effect, 'unresolved');
  });

  test('git-quoted diff headers are decoded, so a quoted protected path is still seen', () => {
    const diff = 'diff --git "a/src/legacy/a\\nb.js" "b/src/legacy/a\\nb.js"\n';
    assert.deepEqual(changedFiles({ changes: [], diff }), ['src/legacy/a\nb.js']);
    const octal = 'diff --git "a/src/legacy/sp\\303\\244ce.js" "b/src/legacy/sp\\303\\244ce.js"\n';
    assert.deepEqual(changedFiles({ changes: [], diff: octal }), ['src/legacy/späce.js']);
    assert.equal(evaluatePolicy(contract(), { changes: [], diff }).effect, 'fail');
  });

  test('verifier: affirmative AC votes and passing tests cannot approve the newline bypass', async () => {
    const file = 'src/a\nb.js';
    const QDIFF = 'diff --git "a/src/a\\nb.js" "b/src/a\\nb.js"\n--- "a/src/a\\nb.js"\n+++ "b/src/a\\nb.js"\n@@ -1 +1 @@\n-x\n+y\n';  // as Git writes it
    const r = await run(overlap(), exec([], { changes: [CHANGE(file)], diff: QDIFF }));
    assert.equal(r.verdict, 'fail');
    assert.deepEqual(r.policy.protected_touched, [file]);
    const r2 = await run(contract({ scope: { allowed_changes: ['src/**', 'README.md'], protected_paths: [] } }), exec([], { changes: [CHANGE('src/clamp.js'), CHANGE(file)], diff: DIFF('src/clamp.js') + QDIFF }));
    assert.notEqual(r2.verdict, 'pass');
  });
});
