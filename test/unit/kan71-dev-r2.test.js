/**
 * KAN-71: the dev set's versioned re-qualification revision (bench/dev-r2/).
 *   - eb3fec6 changed verify/tests.js (grader code), so every v1 dev qualification records a stale
 *     grader hash. The fix is a NEW revision, never an in-place edit: bench/specs/ and
 *     bench/specs.lock.json (v1) stay byte-for-byte as frozen;
 *   - the revision uses the same curation and suites, and its own specs and lock;
 *   - each task's v2 may differ from v1 only by version, one disclosed changelog entry, the grader
 *     hash (old → current) and qualified_at; the base check must have run and passed;
 *   - on a fresh runner, re-qualification must reproduce the committed drafts exactly
 *     (scripts/kan71-requalify-check.js).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { curateDirs, DEFAULTS } = require('../../bench/curate');
const { checkTask } = require('../../scripts/kan71-requalify-check');

const BENCH = path.join(__dirname, '..', '..', 'bench');
const OLD = 'a'.repeat(64); const NEW = 'b'.repeat(64);
const clone = (o) => JSON.parse(JSON.stringify(o));

/** A v1 frozen spec and a matching v2 draft, as the checker reads them. */
function pair() {
  const frozen = {
    schema: 'qb-task-spec/1', id: 'T-1', version: 1, split: 'dev', prompt: 'p', requirement: 'r',
    repo: { source: 'qb-bench:x', base_rev: 'c'.repeat(40), lockfiles: {} },
    oracle: { acceptance_criteria: [{ id: 'AC-1', criterion: 'c' }], approved_by: 'A Person' },
    suite: { dir: 'T-1', files: {}, command: ['node'] },
    qualification: { grader_sha256: OLD, suite_sha256: 'd'.repeat(64), reference: { patch_sha256: 'e'.repeat(64), outcome: 'pass' },
      incorrect: [{ label: 'w1', patch_sha256: 'f'.repeat(64), outcome: 'fail' }, { label: 'w2', patch_sha256: '1'.repeat(64), outcome: 'fail' }],
      qualified_at: '2026-10-08T00:00:00.000Z' },
    changelog: [],
  };
  const { oracle, ...rest } = frozen;
  const entry = { version: 2, reason: 're-qualified', disclosed_at: '2026-10-16T00:00:00Z', after_viewing_results: true };
  const draft = {
    schema: 'qb-task-draft/1',
    spec: { ...rest, version: 2, oracle: null, changelog: [entry], qualification: { ...frozen.qualification, grader_sha256: NEW, qualified_at: '2026-10-16T01:00:00.000Z' } },
    oracle_draft: { acceptance_criteria: oracle.acceptance_criteria },
    source: { curation_sha256: '2'.repeat(64) },
    base_tests: { command: ['node', '--test'], outcome: 'passed' },
  };
  return { frozen, draft: clone(draft) };   // no shared objects: editing the draft never edits v1
}

describe('KAN-71: dev-set re-qualification revision', () => {
  test('curateDirs("dev-r2"): the dev curation and suites, with the revision\'s own specs and lock', () => {
    assert.deepEqual(curateDirs('dev-r2'), {
      curation: DEFAULTS.curation, suites: DEFAULTS.suites,
      specs: path.join(BENCH, 'dev-r2', 'specs'), lockFile: path.join(BENCH, 'dev-r2', 'specs.lock.json'),
    });
    assert.notEqual(curateDirs('dev-r2').lockFile, DEFAULTS.lockFile, 'never the v1 lock');
  });

  test('checkTask accepts a v2 that differs from v1 only by version, changelog, grader hash and qualified_at', () => {
    const { frozen, draft } = pair();
    assert.deepEqual(checkTask({ frozen, draft, graderSha: NEW }), []);
  });

  test('checkTask refuses anything else', () => {
    const cases = [
      ['suite hash', (d) => { d.spec.qualification.suite_sha256 = '9'.repeat(64); }, /qualification/],
      ['reference patch', (d) => { d.spec.qualification.reference.patch_sha256 = '9'.repeat(64); }, /qualification/],
      ['an incorrect implementation', (d) => { d.spec.qualification.incorrect.pop(); }, /qualification/],
      ['the prompt', (d) => { d.spec.prompt = 'changed'; }, /spec/],
      ['the base revision', (d) => { d.spec.repo.base_rev = '0'.repeat(40); }, /spec/],
      ['the oracle', (d) => { d.oracle_draft.acceptance_criteria[0].criterion = 'changed'; }, /oracle/],
      ['a stale grader', (d) => { d.spec.qualification.grader_sha256 = OLD; }, /grader/],
      ['the version', (d) => { d.spec.version = 3; }, /version/],
      ['no changelog entry', (d) => { d.spec.changelog = []; }, /changelog/],
      ['no base check', (d) => { delete d.base_tests; }, /base_tests/],
      ['a base check that did not pass', (d) => { d.base_tests = { declared: false }; }, /base_tests/],
    ];
    for (const [what, edit, re] of cases) {
      const { frozen, draft } = pair(); edit(draft);
      const diffs = checkTask({ frozen, draft, graderSha: NEW });
      assert.ok(diffs.length && diffs.some((x) => re.test(x)), `${what}: ${JSON.stringify(diffs)}`);
    }
  });

  test('checkTask with a committed draft: a fresh draft must match it exactly apart from qualified_at', () => {
    const { frozen, draft } = pair();
    const committed = clone(draft); committed.spec.qualification.qualified_at = '2026-10-15T00:00:00.000Z';
    assert.deepEqual(checkTask({ frozen, draft, committed, graderSha: NEW }), []);
    const other = clone(committed); other.spec.qualification.incorrect[0].patch_sha256 = '7'.repeat(64);
    assert.match(checkTask({ frozen, draft, committed: other, graderSha: NEW }).join('; '), /committed/);
    const otherBase = clone(committed); otherBase.base_tests.command = ['npm', 'test'];
    assert.match(checkTask({ frozen, draft, committed: otherBase, graderSha: NEW }).join('; '), /committed/);
  });

  test('v1 is preserved byte-for-byte: bench/specs.lock.json is the lock frozen on 2026-10-08', () => {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(BENCH, 'specs.lock.json'))).digest('hex');
    assert.equal(sha, 'ee79c548dfccbe41bd15e25ebbc0a45b981f8cbd9dfc72dfcef1f78d9c558849');
  });
});
