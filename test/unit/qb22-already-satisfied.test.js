/**
 * QB-22: no-change success only when the original requirement is independently
 * verified. An agent that changed nothing passes only if (a) the repository's
 * own tests, run in the sandbox on the unchanged tree, classify as passed
 * (QB-06), and (b) the independent judge finds every criterion met in the
 * CURRENT repository files (no diff exists). Otherwise: a criterion judged unmet
 * or failing tests → fail; anything else → unresolved. Also: timeout,
 * authentication failure, nonzero exit and a genuine dry run stay distinct.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { verify } = require('../../verify/verifier');
const { aggregate, inputFromReport } = require('../../verify/verdict');
const { execute } = require('../../agent/runner');
const { outcomeFor } = require('../../run/store');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');

const REPORT = (n) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', `${n}.ndjson`), 'utf8');
const ran = (exit_code, report) => ({ status: 'ran', state: exit_code === 0 ? 'completed' : 'execution_error', exit_code, output: '', report });
const CONTRACT = { id: 'c', goal: 'Add clamp', clarifying_question: null,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp(n, min, max) is exported from src/utils.js', met: null }] };
const SATISFIED = 'function clamp(n, a, b) { return Math.min(Math.max(n, a), b); }\nmodule.exports = { clamp };\n';

let repo;
beforeEach(() => { repo = makeRepo({ 'src/utils.js': SATISFIED, 'README.md': '# x\n' }); });
afterEach(() => repo.cleanup());

const TREE = 'a'.repeat(40);
const context = () => ({ repo_path: repo.dir, relevant_files: [{ path: 'src/utils.js' }], patterns: {} });
/** A no-change execution whose judgment material is the trusted snapshot of the tested tree. */
const noChange = (verification, snapshot = { tree: TREE, files: [{ path: 'src/utils.js', oid: 'b'.repeat(40), size: SATISFIED.length, text: SATISFIED }], skipped: [] }) => ({
  id: 'e', status: 'no_change', diff: null, changes: [], base_tree: TREE, candidate_tree: TREE,
  sandbox: { verification: verification && { ...verification, tree: TREE }, ...(snapshot ? { snapshot } : {}) },
});
/** A judge that answers only from the material it was given (met iff it sees "clamp"). */
const contentJudge = (url, init) => {
  const user = JSON.parse(init.body).messages.find((x) => x.role === 'user').content;
  return ollamaReply(/function clamp/.test(user) ? { met: true, evidence: 'src/utils.js defines clamp' }
    : { met: false, evidence: 'src/utils.js has no clamp', repair: 'add clamp' });
};

async function judged(judge, execution, ctx = context()) {
  const m = mockFetch(judge);
  try { return { report: await verify(CONTRACT, ctx, execution, { repoPath: repo.dir }), calls: m.calls }; } finally { m.restore(); }
}

describe('already-satisfied requirement (agent changed nothing)', () => {
  test('passing tests + every criterion met in the tested snapshot → PASS, with no fabricated change', async () => {
    const { report, calls } = await judged(ollamaReply({ met: true, evidence: 'src/utils.js exports clamp' }), noChange(ran(0, REPORT('pass'))));
    assert.equal(report.verdict, 'pass');
    assert.equal(outcomeFor(report.verdict), 'VERIFIED');
    const body = JSON.parse(calls[0].init.body);
    const user = body.messages.find((x) => x.role === 'user').content;
    assert.match(user, /## Current repository files \(the agent changed nothing\)/);
    assert.match(user, /module\.exports = \{ clamp \}/);
    assert.doesNotMatch(user, /## Git diff/);
    assert.match(body.messages[0].content, /already satisf/i);
    assert.deepEqual(report.judgment_material, { source: 'sandbox_snapshot', tree: TREE, files: [{ path: 'src/utils.js', oid: 'b'.repeat(40) }] });
    assert.equal(report.test_outcome.tree, TREE, 'tests and judgment name the same tree');
  });

  test('KAN-22 review: a host edit after seeding is never judged — the snapshot without clamp is', async () => {
    // The live checkout now HAS clamp (an editor changed it during the run); the tested snapshot does not.
    fs.writeFileSync(path.join(repo.dir, 'src/utils.js'), SATISFIED);
    const tested = 'module.exports = {};\n';
    const ex = noChange(ran(0, REPORT('pass')), { tree: TREE, files: [{ path: 'src/utils.js', oid: 'c'.repeat(40), size: tested.length, text: tested }], skipped: [] });
    const { report } = await judged(contentJudge, ex);
    assert.notEqual(report.verdict, 'pass');
    assert.equal(report.verdict, 'fail');
  });

  test('a criterion judged unmet → fail (the task is not done)', async () => {
    assert.equal((await judged(ollamaReply({ met: false, evidence: 'no clamp', repair: 'add clamp' }), noChange(ran(0, REPORT('pass'))))).report.verdict, 'fail');
  });
  test('the judge cannot tell → unresolved', async () => {
    assert.equal((await judged(ollamaReply({ met: null, evidence: 'unclear' }), noChange(ran(0, REPORT('pass'))))).report.verdict, 'unresolved');
  });
  test('failing tests → fail even when the judge says met', async () => {
    assert.equal((await judged(ollamaReply({ met: true, evidence: 'x' }), noChange(ran(1, REPORT('fail'))))).report.verdict, 'fail');
  });
  for (const [name, v] of [['no tests', { status: 'not_run', reason: 'no_test_command' }], ['broken test run', ran(1, REPORT('loadfail'))]]) {
    test(`${name} → unresolved even when the judge says met`, async () => {
      assert.equal((await judged(ollamaReply({ met: true, evidence: 'x' }), noChange(v))).report.verdict, 'unresolved');
    });
  }

  const OTHER = 'd'.repeat(40);
  const file = { path: 'src/utils.js', oid: 'b'.repeat(40), size: SATISFIED.length, text: SATISFIED };
  const UNUSABLE = {
    'no snapshot (the live checkout is never a fallback)': (ex) => { delete ex.sandbox.snapshot; },
    'snapshot export failed':                               (ex) => { ex.sandbox.snapshot = { error: 'snapshot timeout' }; },
    'snapshot of a different tree than was tested':         (ex) => { ex.sandbox.snapshot.tree = OTHER; },
    'tests ran on a different tree':                        (ex) => { ex.sandbox.verification.tree = OTHER; },
    'captured candidate differs from the snapshot':         (ex) => { ex.candidate_tree = OTHER; },
    'a requested file was too large (never truncated)':     (ex) => { ex.sandbox.snapshot.skipped = [{ path: 'src/big.js', reason: 'too_large' }]; },
    'a requested path is a symlink or directory':           (ex) => { ex.sandbox.snapshot.skipped = [{ path: 'src/link.js', reason: 'not_regular' }]; },
    'only missing files':                                   (ex) => { ex.sandbox.snapshot = { tree: TREE, files: [], skipped: [{ path: 'gone.js', reason: 'missing' }] }; },
  };
  for (const [name, mutate] of Object.entries(UNUSABLE)) {
    test(`${name} → unresolved, judge not called`, async () => {
      const ex = noChange(ran(0, REPORT('pass')), { tree: TREE, files: [file], skipped: [] });
      mutate(ex);
      const { report, calls } = await judged(ollamaReply({ met: true, evidence: 'x' }), ex);
      assert.equal(report.verdict, 'unresolved');
      assert.equal(calls.length, 0);
      assert.equal(report.judgment_material, undefined);
    });
  }
  test('a missing file next to judged files is fine (not withheld)', async () => {
    const ex = noChange(ran(0, REPORT('pass')), { tree: TREE, files: [file], skipped: [{ path: 'gone.js', reason: 'missing' }] });
    assert.equal((await judged(ollamaReply({ met: true, evidence: 'clamp' }), ex)).report.verdict, 'pass');
  });

  test('the stored input replays to the same verdict (rules 2)', async () => {
    const ex = noChange(ran(0, REPORT('pass')));
    const { report } = await judged(ollamaReply({ met: true, evidence: 'x' }), ex);
    assert.equal(aggregate(inputFromReport(report, ex)).verdict, 'pass');
  });
  test('legacy inputs (no rules field) keep no_change unresolved', () => {
    assert.equal(aggregate({ hasDiff: false, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null, executionStatus: 'no_change' }).verdict, 'unresolved');
  });
  test('the verifier no longer reads the host checkout', () => {
    const src = fs.readFileSync(require.resolve('../../verify/verifier'), 'utf8');
    assert.doesNotMatch(src, /readFileSync|realpathSync|require\('fs'\)/);
  });
});

describe('execution states stay distinct (done-when)', () => {
  const run = (r) => execute('task', CONTRACT, null, { agent: 'claude-code', repoPath: '/r', runSandboxed: async () => r });
  test('timeout, authentication failure, nonzero exit and a genuine dry run', async () => {
    const t = await run({ status: 'timeout', reason: 'stage deadline' });
    const a = await run({ status: 'blocked', reason: 'auth_not_logged_in: run `qb auth login`' });
    const e = await run({ status: 'execution_error', reason: 'exit 3', exit_code: 3 });
    const d = await execute('task', CONTRACT, null, { agent: 'dry-run', repoPath: '/r' });
    assert.deepEqual([t.status, a.status, e.status, d.status], ['timeout', 'blocked', 'execution_error', 'dry_run']);
    assert.match(a.error, /^auth_not_logged_in/);
    const m = mockFetch(ollamaReply({ met: true, evidence: 'x' }));
    try {
      const verdicts = [];
      for (const x of [t, a, e]) verdicts.push((await verify(CONTRACT, null, x, {})).verdict);
      assert.deepEqual(verdicts, ['error', 'unresolved', 'error']);
      assert.equal(m.calls.length, 0, 'failed executions are never judged');
    } finally { m.restore(); }
  });
});
