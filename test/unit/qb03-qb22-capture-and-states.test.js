/**
 * QB-03 — change capture includes the whole result; no partial capture can PASS.
 * QB-22 — execution errors are distinct from dry-run / no change; partial edits
 *         remain inspectable.
 *
 * Since QB-02 the agent runs only in the sandbox, and capture is trusted code in
 * a container. Capturing every change type (staged, unstaged, new, committed,
 * renamed, deleted, binary, modes, symlinks, unusual paths) is proven with real
 * Docker in test/integration/qb02-sandbox-capture.test.js and
 * qb02-sandbox-pipeline.test.js. These unit tests drive the runner and verifier
 * with injected pipeline results, so the state mapping and the "never PASS"
 * rules are checked without Docker.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { execute } = require('../../agent/runner');
const { verify } = require('../../verify/verifier');
// Real node:test reports from the sandbox reporter (QB-06).
const REPORT = (n) => require('fs').readFileSync(require('path').join(__dirname, '..', 'fixtures', 'node-test-reports', `${n}.ndjson`), 'utf8');

const CHANGE = { file: 'src/a.js', status: 'M', additions: 1, deletions: 1, binary: false };
const DIFF = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
// A finalized contract: only these reach the agent and verification (QB-08).
const contract = { id: 'c', goal: 'Set a to 2', acceptance_criteria: [{ id: 'AC-1', criterion: 'a is 2', met: null }], clarifying_question: null };

function run(result) {
  return execute('task', contract, null, { agent: 'claude-code', repoPath: '/repo', runSandboxed: async () => result });
}
async function verdictFor(result, judge = { met: true, evidence: 'ok' }) {
  const exec = await run(result);
  const fetchMock = mockFetch(ollamaReply(judge));
  try {
    return { exec, report: await verify(contract, null, exec, { repoPath: '/repo' }), judged: fetchMock.calls.length };
  } finally { fetchMock.restore(); }
}

describe('QB-22 execution states (sandbox results)', () => {
  test('nonzero exit is execution_error, and partial edits stay inspectable', async () => {
    const e = await run({ status: 'execution_error', reason: 'exit 3', exit_code: 3, diff: DIFF, changes: [CHANGE], stderr_tail: 'boom' });
    assert.equal(e.status, 'execution_error');
    assert.equal(e.exit_code, 3);
    assert.match(e.stderr_tail, /boom/);
    assert.deepEqual(e.changes.map((c) => c.file), ['src/a.js']);
    assert.match(e.diff, /const a = 2/);
  });

  test('timeout keeps its own state and its partial edits', async () => {
    const e = await run({ status: 'timeout', reason: 'stage deadline', diff: DIFF, changes: [CHANGE] });
    assert.equal(e.status, 'timeout');
    assert.deepEqual(e.changes.map((c) => c.file), ['src/a.js']);
  });

  for (const s of ['oom', 'infra_error', 'setup_failed']) {
    test(`${s} is an error verdict, never judged`, async () => {
      const { report, judged } = await verdictFor({ status: s, reason: s, diff: DIFF, changes: [CHANGE] });
      assert.equal(report.verdict, 'error');
      assert.equal(judged, 0, 'the judge must not run on a failed execution');
    });
  }

  for (const s of ['blocked', 'unresolved']) {
    test(`${s} can never be approved`, async () => {
      const { report } = await verdictFor({ status: s, reason: s, diff: DIFF, changes: [CHANGE] });
      assert.equal(report.verdict, 'unresolved');
    });
  }

  test('success without edits is no_change; a genuine dry-run is dry_run', async () => {
    assert.equal((await run({ status: 'no_change' })).status, 'no_change');
    const dry = await execute('task', contract, null, { agent: 'dry-run', repoPath: '/repo' });
    assert.equal(dry.status, 'dry_run');
  });
});

describe('QB-03: no partial or unverifiable capture can PASS', () => {
  test('unsupported changes (e.g. unsafe symlink, rejected entries, .git paths) block PASS', async () => {
    const { report } = await verdictFor({ status: 'completed', diff: DIFF, changes: [CHANGE], unsupported_changes: ['evil'] });
    assert.notEqual(report.verdict, 'pass');
  });

  test('tests that failed in the sandbox verification fail the task even when the judge says met', async () => {
    const { report } = await verdictFor({ status: 'completed', diff: DIFF, changes: [CHANGE],
      sandbox: { verification: { status: 'ran', state: 'execution_error', exit_code: 1, output: 'Error: assertion failed\n', report: REPORT('fail') } } });
    assert.equal(report.verdict, 'fail');
  });

  test('verification not run because dependencies changed → cannot pass', async () => {
    const { report } = await verdictFor({ status: 'completed', diff: DIFF, changes: [CHANGE],
      sandbox: { verification: { status: 'not_run', reason: 'dependency_change_required' } } });
    assert.equal(report.verdict, 'unresolved');
  });

  test('verification killed (oom/timeout) → cannot pass', async () => {
    const { report } = await verdictFor({ status: 'completed', diff: DIFF, changes: [CHANGE],
      sandbox: { verification: { status: 'ran', state: 'oom', output: '' } } });
    assert.equal(report.verdict, 'unresolved');
  });

  test('a clean capture with passing sandbox tests and a met criterion can pass', async () => {
    const { report } = await verdictFor({ status: 'completed', diff: DIFF, changes: [CHANGE],
      sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT('pass') } } });
    assert.equal(report.verdict, 'pass');
  });
});
