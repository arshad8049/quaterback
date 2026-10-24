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

// Review 10394: the summary must never be green on a broken replay, and must never pick between
// two records of the same patch or combine records from different commits, sets or spec versions.
describe('KAN-75 review 10394: integrity of the summary', () => {
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { validateRecords } = require('../../scripts/kan75-checker-summary');
  const CLI = path.join(__dirname, '../../scripts/kan75-checker-summary.js');
  const expected = [
    { task_id: 'T1', kind: 'reference', truth: 'correct', spec_version: 2 },
    { task_id: 'T1', kind: 'base', truth: 'wrong', spec_version: 2 },
  ];
  const good = (task_id, patch_kind, verdict, extra = {}) => ({ schema: 'qb-kan65-replay/1', set: 'dev-r2', task_id, patch_kind, spec_version: 2,
    qb: { commit: 'c'.repeat(40), dirty: false }, final: { verdict, attempts: 1, blocked: null }, attempts: [{ verification: { verdict } }], ...extra });

  test('two records of the same patch are refused, in either order', () => {
    const a = good('T1', 'reference', 'pass'); const b = good('T1', 'reference', 'fail');
    assert.throws(() => summarize(expected, [a, b, good('T1', 'base', 'fail')]), /duplicate replay T1 reference/);
    assert.throws(() => summarize(expected, [b, a, good('T1', 'base', 'fail')]), /duplicate replay T1 reference/);
  });

  test('records from another set, spec version or QB commit, or a dirty tree, are refused', () => {
    const ok = [good('T1', 'reference', 'pass'), good('T1', 'base', 'fail')];
    assert.doesNotThrow(() => validateRecords(expected, ok, 'dev-r2'));
    assert.throws(() => validateRecords(expected, [ok[0], { ...ok[1], set: 'screen' }], 'dev-r2'), /T1 base: set screen, expected dev-r2/);
    assert.throws(() => validateRecords(expected, [ok[0], { ...ok[1], spec_version: 1 }], 'dev-r2'), /T1 base: spec version 1, expected 2/);
    assert.throws(() => validateRecords(expected, [ok[0], { ...ok[1], qb: { commit: 'd'.repeat(40), dirty: false } }], 'dev-r2'), /more than one QB commit/);
    assert.throws(() => validateRecords(expected, [ok[0], { ...ok[1], qb: { commit: 'c'.repeat(40), dirty: true } }], 'dev-r2'), /T1 base: dirty QB tree/);
    assert.throws(() => validateRecords(expected, [ok[0], { ...ok[1], schema: 'other/1' }], 'dev-r2'), /T1 base: not a qb-kan65-replay\/1 record/);
  });

  test('an unknown or absent verdict is counted as invalid, never as a verdict', () => {
    const s = summarize(expected, [good('T1', 'reference', 'maybe'), good('T1', 'base', null)]);
    assert.deepEqual(s.final.correct, { invalid: 1 });
    assert.deepEqual(s.final.wrong, { invalid: 1 });
    assert.deepEqual(s.incomplete, ['T1 reference: invalid', 'T1 base: invalid']);
  });

  // The CLI on a directory of records: exit 0 only when every expected patch has a valid verdict.
  const cli = (records) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan75-cli-'));
    records.forEach((r, i) => fs.writeFileSync(path.join(dir, `${r.task_id}-${r.patch_kind.replace(':', '-')}${i ? `-${i}` : ''}.json`), JSON.stringify(r)));
    const p = spawnSync(process.execPath, [CLI, dir, '--set', 'dev-r2'], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return p;
  };
  const all = (fn) => expectedPatches('dev-r2').map((e) => fn(e));
  const valid = (e) => ({ ...good(e.task_id, e.kind, 'partial'), spec_version: e.spec_version });

  test('CLI: every one of the 128 with a valid verdict exits 0', () => {
    const p = cli(all(valid));
    assert.equal(p.status, 0, p.stderr);
  });

  test('CLI: every replay errored exits 1, with all 128 still in the denominators', () => {
    const p = cli(all((e) => ({ task_id: e.task_id, patch_kind: e.kind, error: 'controlled failure' })));
    assert.equal(p.status, 1);
    assert.match(p.stdout, /\| correct \|.*\b30\b/); assert.match(p.stdout, /\| wrong \|.*\b98\b/);
    assert.match(p.stdout, /Incomplete \(128\)/);
  });

  test('CLI: one error, one BLOCKED, one QB error verdict, one invalid verdict or one missing record each exits 1', () => {
    const cases = {
      error: (r, i) => (i === 0 ? { task_id: r.task_id, patch_kind: r.patch_kind, error: 'boom' } : r),
      blocked: (r, i) => (i === 0 ? { ...r, final: { verdict: null, attempts: 1, blocked: 'needs_contract_approval' } } : r),
      'qb error': (r, i) => (i === 0 ? { ...r, final: { ...r.final, verdict: 'error' } } : r),
      invalid: (r, i) => (i === 0 ? { ...r, final: { ...r.final, verdict: 'maybe' } } : r),
    };
    for (const [name, f] of Object.entries(cases)) {
      const p = cli(all(valid).map(f));
      assert.equal(p.status, 1, `${name}: ${p.stdout.slice(-300)}`);
    }
    assert.equal(cli(all(valid).slice(1)).status, 1, 'missing');
  });

  test('CLI: a duplicate record or mixed provenance exits nonzero without a table', () => {
    const recs = all(valid);
    const dup = cli([...recs, { ...recs[0], final: { ...recs[0].final, verdict: 'pass' } }]);
    assert.notEqual(dup.status, 0); assert.match(dup.stderr, /duplicate replay/); assert.doesNotMatch(dup.stdout, /\| truth \|/);
    const mixed = cli(recs.map((r, i) => (i === 5 ? { ...r, qb: { commit: 'd'.repeat(40), dirty: false } } : r)));
    assert.notEqual(mixed.status, 0); assert.match(mixed.stderr, /more than one QB commit/);
  });
});

// The owner's request (2026-10-23): the exact result of every patch, with correct patches,
// incorrect implementations and unchanged broken code kept apart.
describe('KAN-75: results by patch group and per patch', () => {
  const { groupOf, render } = require('../../scripts/kan75-checker-summary');
  const expected = [
    { task_id: 'T1', kind: 'reference', truth: 'correct' },
    { task_id: 'T1', kind: 'incorrect:a', truth: 'wrong' },
    { task_id: 'T1', kind: 'base', truth: 'wrong' },
    { task_id: 'T2', kind: 'base', truth: 'correct' },
  ];
  const rec = (task_id, patch_kind, verdict, outcome) => ({ task_id, patch_kind, final: { verdict, attempts: 1, blocked: null },
    attempts: [{ verification: { verdict, test_outcome: outcome && { outcome, reason: `r-${outcome}` } } }] });

  test('four groups: reference, already-satisfied base, incorrect implementation, unchanged base that needs a change', () => {
    assert.deepEqual(expected.map(groupOf), ['reference', 'incorrect', 'base_unchanged_broken', 'base_already_satisfied']);
  });

  test('the summary has a group table and one row per patch with its first test outcome', () => {
    const s = summarize(expected, [rec('T1', 'reference', 'partial', 'passed'), rec('T1', 'incorrect:a', 'fail', 'failed'),
      rec('T1', 'base', 'unresolved', null), rec('T2', 'base', 'unresolved', null)]);
    assert.deepEqual(s.groups.reference, { partial: 1 });
    assert.deepEqual(s.groups.incorrect, { fail: 1 });
    assert.deepEqual(s.groups.base_unchanged_broken, { unresolved: 1 });
    assert.deepEqual(s.groups.base_already_satisfied, { unresolved: 1 });
    assert.equal(s.rows.find((r) => r.kind === 'incorrect:a').test_outcome, 'failed (r-failed)');
    const md = render(s);
    assert.match(md, /\| incorrect implementation \(wrong\) \| 0 \| 0 \| 1 \| 0 \|/);
    assert.match(md, /\| T1 \| incorrect:a \| wrong \| fail \| fail \| 1 \| failed \(r-failed\) \|/);
  });
});

// Review 10425: the reader must not drop a replay-named file it cannot use. Every candidate reaches
// validation; an unsupported schema is refused with its file name, not silently filtered out.
describe('KAN-75 review 10425: every replay candidate reaches validation', () => {
  const fs = require('fs');
  const os = require('os');
  const { spawnSync } = require('child_process');
  const CLI = path.join(__dirname, '../../scripts/kan75-checker-summary.js');
  const valid = () => expectedPatches('dev-r2').map((e) => ({ schema: 'qb-kan65-replay/1', set: 'dev-r2', task_id: e.task_id, patch_kind: e.kind,
    spec_version: e.spec_version, qb: { commit: 'c'.repeat(40), dirty: false },
    final: { verdict: 'partial', attempts: 1, blocked: null }, attempts: [{ verification: { verdict: 'partial' } }] }));
  const cli = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan75-reader-'));
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
    const p = spawnSync(process.execPath, [CLI, dir, '--set', 'dev-r2'], { encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return p;
  };
  const base = () => Object.fromEntries(valid().map((r, i) => [`${r.task_id}-record-${i}.json`, r]));

  test('128 valid records plus an unsupported-schema duplicate: exit 2, no table, the file and schema named', () => {
    const recs = valid();
    const p = cli({ ...base(), 'AV-01-extra.json': { ...recs[0], schema: 'other/1' } });
    assert.equal(p.status, 2, p.stdout.slice(0, 300));
    assert.doesNotMatch(p.stdout, /\| truth \|/);
    assert.match(p.stderr, /AV-01-extra\.json/); assert.match(p.stderr, /other\/1/);
  });

  test('an unsupported-schema candidate for a patch that is not expected: exit 2, named', () => {
    const p = cli({ ...base(), 'ZZ-99-base.json': { schema: 'other/1', task_id: 'ZZ-99', patch_kind: 'base' } });
    assert.equal(p.status, 2); assert.doesNotMatch(p.stdout, /\| truth \|/); assert.match(p.stderr, /ZZ-99-base\.json/);
  });

  test('a candidate with no schema and no error, or one that is not JSON: exit 2, named', () => {
    const recs = valid();
    const { schema, ...noSchema } = recs[0];
    let p = cli({ ...base(), 'AV-01-noschema.json': noSchema });
    assert.equal(p.status, 2); assert.match(p.stderr, /AV-01-noschema\.json/);
    p = cli({ ...base(), 'AV-01-broken.json': '{ not json' });
    assert.equal(p.status, 2); assert.match(p.stderr, /AV-01-broken\.json/);
  });

  test('an error record with a foreign schema is refused; a workflow error-only record is still counted (exit 1)', () => {
    const recs = valid();
    const files = base();
    const first = Object.keys(files)[0];
    let p = cli({ ...files, [first]: { schema: 'other/1', task_id: recs[0].task_id, patch_kind: recs[0].patch_kind, error: 'x' } });
    assert.equal(p.status, 2); assert.match(p.stderr, /other\/1/);
    p = cli({ ...files, [first]: { task_id: recs[0].task_id, patch_kind: recs[0].patch_kind, error: 'replay crashed' } });
    assert.equal(p.status, 1); assert.match(p.stdout, /Incomplete \(1\)/);
  });
});
