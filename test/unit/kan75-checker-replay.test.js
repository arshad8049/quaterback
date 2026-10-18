/**
 * KAN-75: QB's verdict on every known-correct and known-wrong dev-r2 patch, with no agent.
 *   - scripts/kan65-replay.js replays a set's frozen task (--set screen|dev-r2), finding its spec
 *     and curation through curateDirs;
 *   - scripts/kan75-checker-summary.js lists the patches a set should have replayed, labels each
 *     with its known truth, and cross-tabulates QB's verdict against it. A missing or errored
 *     replay is counted as such and never dropped.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { curateDirs } = require('../../bench/curate');
const { setPaths } = require('../../scripts/kan65-replay');
const { expectedPatches, truthOf, summarize } = require('../../scripts/kan75-checker-summary');

describe('KAN-75: the replay finds a set\'s spec and curation', () => {
  test('dev-r2: its own frozen specs, the shared curation; screen: unchanged; others refused', () => {
    assert.deepEqual(setPaths('dev-r2'), { specs: curateDirs('dev-r2').specs, curation: curateDirs('dev-r2').curation });
    assert.deepEqual(setPaths('screen'), { specs: curateDirs('screen').specs, curation: curateDirs('screen').curation });
    assert.deepEqual(setPaths(), setPaths('screen'), 'screen stays the default, as the KAN-65 workflow uses it');
    assert.throws(() => setPaths('dev'), /dev-r2|screen/);
  });
});

describe('KAN-75: the patches to replay and their known truth', () => {
  test('dev-r2: 30 bases, 25 references (none for the 5 already_satisfied tasks), 73 incorrect: 128', () => {
    const p = expectedPatches('dev-r2');
    assert.equal(p.length, 128);
    const by = (k) => p.filter((x) => x.kind === k || x.kind.startsWith(`${k}:`)).length;
    assert.equal(by('base'), 30); assert.equal(by('reference'), 25); assert.equal(by('incorrect'), 73);
    assert.equal(p.filter((x) => x.truth === 'correct').length, 30);
    assert.equal(p.filter((x) => x.truth === 'wrong').length, 98);
  });

  test('truth: reference correct, incorrect wrong, base correct only when the task is already_satisfied', () => {
    const spec = (type) => ({ stratum: { type } });
    assert.equal(truthOf(spec('bug_fix'), 'reference'), 'correct');
    assert.equal(truthOf(spec('bug_fix'), 'incorrect:off-by-one'), 'wrong');
    assert.equal(truthOf(spec('bug_fix'), 'base'), 'wrong');
    assert.equal(truthOf(spec('already_satisfied'), 'base'), 'correct');
    assert.throws(() => truthOf(spec('bug_fix'), 'other'), /unknown patch kind/);
  });
});

describe('KAN-75: the summary', () => {
  const rec = (task_id, patch_kind, first, final, extra = {}) => ({ task_id, patch_kind,
    final: { verdict: final, attempts: 3, blocked: null }, attempts: [{ verification: first ? { verdict: first } : undefined }], ...extra });
  const expected = [
    { task_id: 'T1', kind: 'reference', truth: 'correct' },
    { task_id: 'T1', kind: 'incorrect:a', truth: 'wrong' },
    { task_id: 'T1', kind: 'incorrect:b', truth: 'wrong' },
    { task_id: 'T1', kind: 'base', truth: 'wrong' },
    { task_id: 'T2', kind: 'base', truth: 'correct' },
  ];

  test('cross-tabulates first and final verdicts against truth, with the headline measures', () => {
    const s = summarize(expected, [
      rec('T1', 'reference', 'fail', 'pass'),
      rec('T1', 'incorrect:a', 'pass', 'pass'),
      rec('T1', 'incorrect:b', 'partial', 'fail'),
      rec('T1', 'base', 'fail', 'fail'),
      rec('T2', 'base', 'no-diff', 'no-diff'),
    ]);
    assert.deepEqual(s.final.correct, { pass: 1, 'no-diff': 1 });
    assert.deepEqual(s.final.wrong, { pass: 1, fail: 2 });
    assert.deepEqual(s.first.correct, { fail: 1, 'no-diff': 1 });
    assert.deepEqual(s.first.wrong, { pass: 1, partial: 1, fail: 1 });
    assert.deepEqual(s.headline.final, { false_accept: 1, catch: 2, false_fail: 0, correct_pass: 1, wrong_total: 3, correct_total: 2 });
    assert.deepEqual(s.headline.first, { false_accept: 1, catch: 1, false_fail: 1, correct_pass: 0, wrong_total: 3, correct_total: 2 });
    assert.deepEqual(s.missing, []);
  });

  test('a missing replay, an errored one and a BLOCKED one are counted, never dropped', () => {
    const s = summarize(expected, [
      rec('T1', 'reference', null, null, { error: 'ERROR boom' }),
      rec('T1', 'incorrect:a', 'fail', null, { final: { verdict: null, attempts: 1, blocked: 'needs_contract_approval' } }),
      rec('T1', 'base', 'fail', 'fail'),
      rec('T2', 'base', 'pass', 'pass'),
    ]);
    assert.deepEqual(s.missing, ['T1 incorrect:b']);
    assert.deepEqual(s.final.correct, { error: 1, pass: 1 });
    assert.deepEqual(s.final.wrong, { blocked: 1, fail: 1, missing: 1 });
    assert.equal(s.headline.final.wrong_total, 3, 'the missing replay stays in the denominator');
  });

  test('a replay of a patch that was not expected is refused', () => {
    assert.throws(() => summarize(expected, [rec('T9', 'base', 'fail', 'fail')]), /unexpected replay T9 base/);
  });
});
