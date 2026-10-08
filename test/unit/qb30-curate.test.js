/**
 * QB-30 (curation): bench/curate.js turns a task definition into a frozen qb-task-spec/1.
 *   - patches are generated from file trees against the pinned base (reference + ≥2 incorrect);
 *   - the suite is qualified with the real grader before anything is written;
 *   - the draft carries NO approved oracle: only a named person approves it at freeze time,
 *     and freezing without an approver is refused (QB-13: an oracle is human-approved);
 *   - a suite that cannot tell a wrong implementation from the reference is refused.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const { hostRunner } = require('../helpers/grading-fixture');
const C = require('../../bench/curate');

const MAJOR = Number(process.versions.node.split('.')[0]);
// Grading reads the node:test summary event (QB-06), which Node 20 does not emit — as in qb27-grader.
const LIVE = { skip: MAJOR < 22 && `node ${process.version} has no test:summary event` };

const BASE = {
  'package.json': JSON.stringify({ name: 'dur', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2) + '\n',
  'package-lock.json': JSON.stringify({ name: 'dur', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'dur', version: '1.0.0' } } }, null, 2) + '\n',
  'src/duration.js': 'module.exports.formatDuration = (ms) => `${ms}ms`;\n',
};
const write = (root, files) => { for (const [rel, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), c); } };

let tmp, repo, dirs;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb30-curate-'));
  repo = makeRepo(BASE);
  dirs = { curation: path.join(tmp, 'curation'), suites: path.join(tmp, 'suites'), specs: path.join(tmp, 'specs'), lockFile: path.join(tmp, 'specs.lock.json') };
  write(dirs.curation, {
    'DUR-1/task.json': JSON.stringify({ id: 'DUR-1', split: 'dev', stratum: { type: 'bug_fix', repository: 'dur' }, repo: repo.dir, base_rev: repo.head(),
      prompt: 'formatDuration should show 30,000 ms as 30s', requirement: 'whole seconds below a minute render as "<s>s"; above as "<m>m <s>s"',
      oracle: { acceptance_criteria: [{ id: 'AC-1', criterion: 'formatDuration(30000) returns "30s"' }] },
      suite: { command: ['node', '--test', 'test/hidden/duration.test.js'] },
      adjudication_rules: 'Exact string match only.', provenance: { author: 'qb-test', created_at: '2026-10-08T00:00:00Z', tuned_during_development: false } }),
    'DUR-1/reference/src/duration.js': 'module.exports.formatDuration = (ms) => { const s = Math.round(ms / 1000); const m = Math.floor(s / 60); const r = s % 60; return m ? (r ? `${m}m ${r}s` : `${m}m`) : `${r}s`; };\n',
    'DUR-1/incorrect/five-minutes/src/duration.js': "module.exports.formatDuration = (ms) => '5m';\n",
    'DUR-1/incorrect/seconds-only/src/duration.js': 'module.exports.formatDuration = (ms) => `${Math.round(ms / 1000)}s`;\n',
  });
  write(dirs.suites, { 'DUR-1/duration.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n"
    + "const { formatDuration } = require('../../src/duration');\n"
    + "test('30,000 ms is 30s', () => assert.equal(formatDuration(30000), '30s'));\n"
    + "test('90,000 ms is 1m 30s', () => assert.equal(formatDuration(90000), '1m 30s'));\n" });
});
after(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

const opts = () => ({ ...dirs, runSandboxed: hostRunner(), now: new Date('2026-10-08T01:00:00Z') });

describe('QB-30: curation', () => {
  test('qualify → a draft spec with qualification and NO approved oracle', LIVE, async () => {
    const d = await C.qualifyTask('DUR-1', opts());
    assert.equal(d.spec.schema, 'qb-task-spec/1');
    assert.equal(d.spec.oracle, null, 'the draft is never approved by the tool');
    assert.deepEqual(d.oracle_draft.acceptance_criteria.map((a) => a.id), ['AC-1']);
    assert.equal(d.spec.qualification.incorrect.length, 2);
    assert.deepEqual(Object.keys(d.spec.repo.lockfiles), ['package-lock.json']);
    assert.deepEqual(d.spec.suite.owned_paths, ['test/hidden/**']);
    assert.ok(fs.existsSync(path.join(dirs.specs, 'DUR-1.draft.json')));
    assert.equal(fs.existsSync(path.join(dirs.specs, 'DUR-1.json')), false, 'nothing is frozen by qualify');
  });

  test('freeze without a named approver is refused', () => {
    assert.throws(() => C.freezeTask('DUR-1', { ...opts(), approver: '' }), /approver/);
    assert.throws(() => C.freezeTask('DUR-1', { ...opts(), approver: 'qb' }), /person/);
  });

  test('freeze with an approver: the oracle names them, the spec is frozen in the lock', LIVE, () => {
    const spec = C.freezeTask('DUR-1', { ...opts(), approver: 'Arshad Ahmed Shaik' });
    assert.equal(spec.oracle.approved_by, 'Arshad Ahmed Shaik');
    const lock = JSON.parse(fs.readFileSync(dirs.lockFile, 'utf8'));
    assert.equal(lock.specs['DUR-1'].version, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.specs, 'DUR-1.json'), 'utf8')), spec);
  });

  test('a suite that passes a wrong implementation is refused (not qualified, no draft)', LIVE, async () => {
    write(dirs.curation, { 'WEAK-1/task.json': fs.readFileSync(path.join(dirs.curation, 'DUR-1/task.json'), 'utf8').replace('"DUR-1"', '"WEAK-1"').replace('duration.test.js', 'weak.test.js') });
    fs.cpSync(path.join(dirs.curation, 'DUR-1/reference'), path.join(dirs.curation, 'WEAK-1/reference'), { recursive: true });
    fs.cpSync(path.join(dirs.curation, 'DUR-1/incorrect'), path.join(dirs.curation, 'WEAK-1/incorrect'), { recursive: true });
    write(dirs.suites, { 'WEAK-1/weak.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n"
      + "test('returns a string', () => assert.equal(typeof require('../../src/duration').formatDuration(30000), 'string'));\n" });
    await assert.rejects(C.qualifyTask('WEAK-1', opts()), /not qualified.*five-minutes/s);
    assert.equal(fs.existsSync(path.join(dirs.specs, 'WEAK-1.draft.json')), false);
  });

  test('already_satisfied: no reference tree means the correct change is NO change (empty patch passes)', LIVE, async () => {
    const t = JSON.parse(fs.readFileSync(path.join(dirs.curation, 'DUR-1/task.json'), 'utf8'));
    write(dirs.curation, { 'SAT-1/task.json': JSON.stringify({ ...t, id: 'SAT-1', stratum: { type: 'already_satisfied', repository: 'dur' }, suite: { command: ['node', '--test', 'test/hidden/sat.test.js'] } }) });
    fs.cpSync(path.join(dirs.curation, 'DUR-1/incorrect'), path.join(dirs.curation, 'SAT-1/incorrect'), { recursive: true });
    write(dirs.suites, { 'SAT-1/sat.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n"
      + "test('base behaviour kept', () => assert.equal(require('../../src/duration').formatDuration(30000), '30000ms'));\n" });
    const d = await C.qualifyTask('SAT-1', opts());
    assert.equal(d.spec.qualification.reference.patch_sha256, require('../../bench/schemas').sha256(Buffer.from('')));
    // …but only for already_satisfied: any other type still needs a real reference
    write(dirs.curation, { 'NOREF-1/task.json': JSON.stringify({ ...t, id: 'NOREF-1' }) });
    fs.cpSync(path.join(dirs.suites, 'DUR-1'), path.join(dirs.suites, 'NOREF-1'), { recursive: true });
    await assert.rejects(C.qualifyTask('NOREF-1', opts()), /reference/);
  });
});
