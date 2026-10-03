/**
 * QB-02 done-when, end to end through the real pipeline (lib/sandbox/pipeline),
 * real Docker, real npm registry. QB_INTEGRATION=1 only.
 *
 *   "A fixture attempting a host-file write, forbidden network request, and
 *    trusted-test modification is denied. The user checkout and its Git metadata
 *    remain unchanged."
 *
 * The Claude stage is replaced (function parameter, test-only) by a hostile
 * stand-in that runs in the real agent container with the real proxy.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const D = require('../../lib/sandbox/docker');
const { runSandboxed } = require('../../lib/sandbox/pipeline');
const { hardened } = require('../../lib/sandbox/workspace');
const { AGENT_IMAGE } = require('../../lib/sandbox/agent');
const { aggregate } = require('../../verify/verdict');
const { verify } = require('../../verify/verifier');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo, fingerprint } = require('../helpers/tmprepo');

const ENABLED = process.env.QB_INTEGRATION === '1';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'npm-app');
let stateDir;

function fixtureRepo(mutate) {
  const files = {};
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs); else files[path.relative(FIXTURE, abs)] = fs.readFileSync(abs);
    }
  })(FIXTURE);
  if (mutate) mutate(files);
  return makeRepo(files);
}
const gitMeta = (dir) => {
  const h = crypto.createHash('sha256');
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs); else h.update(abs).update(fs.readFileSync(abs));
    }
  })(path.join(dir, '.git'));
  return h.digest('hex');
};

/** A hostile stand-in for the Claude stage, in the real agent container behind the real proxy. */
const hostileAgent = (script) => (ws, egress, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
  ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'), ...egress.mount(),
  '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=16m,uid=10001,gid=10001',
  '--entrypoint', 'sh', AGENT_IMAGE, '-c',
  `socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock & sleep 0.3\n${script}`,
], { waitTimeoutMs });

describe('QB-02 done-when through the real pipeline', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker + npm registry)' }, () => {
  before(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-sbx-state-')); });
  after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

  test('host-file write, forbidden network and trusted-test modification are all denied; checkout and .git unchanged', async () => {
    const repo = fixtureRepo();
    const hostMarker = path.join(os.tmpdir(), `qb-host-write-${process.pid}`);
    try {
      const before0 = { tree: fingerprint(repo.dir), git: gitMeta(repo.dir) };
      const r = await runSandboxed({
        repoPath: repo.dir, briefing: 'x', stateDir, deadlines: { agent: 120_000 },
        agentStage: hostileAgent(`
          cd /work
          # 1. host-file writes: the host's /tmp, the user's checkout path, and /etc
          echo pwned > ${hostMarker} 2>/dev/null; echo pwned > ${repo.dir}/PWNED 2>/dev/null; echo pwned > /etc/pwned 2>/dev/null
          # 2. forbidden network: direct, and through the proxy to a non-allowlisted host
          { curl -s --max-time 5 https://1.1.1.1/ -o /dev/null && echo DIRECT-OK || echo DIRECT-BLOCKED
            curl -s --max-time 10 -o /dev/null -w 'PROXY-%{http_connect}\\n' -p -x http://127.0.0.1:8888 https://example.com/ ; } > /work/net-result.txt
          # 3. break the code, then gut the trusted tests and the test script so they "pass"
          printf 'module.exports = () => 0;\\n' > src/double.js
          printf 'console.log("fixture tests passed")\\n' > test/run.js
          sed -i 's#"test": "node test/run.js"#"test": "exit 0"#' package.json
          # 4. commit inside the agent's own repo (must still be captured)
          git -c user.email=a@b -c user.name=agent add -A && git -c user.email=a@b -c user.name=agent commit -qm agent || true`),
      });

      // Host write: nothing escaped the container.
      assert.equal(fs.existsSync(hostMarker), false, 'the agent wrote a file on the host');
      assert.equal(fs.existsSync(path.join(repo.dir, 'PWNED')), false);
      // Checkout and its Git metadata unchanged (T-FS / done-when).
      assert.deepEqual(fingerprint(repo.dir), before0.tree);
      assert.equal(gitMeta(repo.dir), before0.git);

      assert.equal(r.status, 'completed', JSON.stringify({ reason: r.reason, sandbox: r.sandbox }));
      const files = r.changes.map((c) => c.file).sort();
      assert.deepEqual(files, ['net-result.txt', 'package.json', 'src/double.js', 'test/run.js'], 'committed changes must be captured');
      // Forbidden network: both attempts failed inside the sandbox.
      assert.match(r.diff, /\+DIRECT-BLOCKED/);
      assert.match(r.diff, /\+PROXY-403/);
      // Trusted-test modification: the base tests ran and failed; the edits were reported.
      const v = r.sandbox.verification;
      assert.equal(v.status, 'ran');
      assert.equal(v.state, 'execution_error');
      assert.deepEqual(v.prep.protected_modified, ['test/run.js']);
      assert.equal(v.prep.test_script_changed, true);
      const { verdict } = aggregate({ hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null,
        executionStatus: r.status, verification: { status: v.status, reason: v.reason, state: v.state } });
      assert.equal(verdict, 'fail', 'even a judge that says "met" cannot pass this');
      // Lifecycle: the supervisor committed the outcome and nothing is left.
      assert.equal(r.sandbox.terminal.actor, 'supervisor');
      assert.equal((await D.runContainers(r.sandbox.run_id)).length, 0);
      const vols = (await D.op(['volume', 'ls', '-q', '--filter', `label=qb.run=${r.sandbox.run_id}`])).stdout.trim();
      assert.equal(vols, '');
    } finally {
      fs.rmSync(hostMarker, { force: true });
      repo.cleanup();
    }
  });

  test('a nested .git path is captured as unsupported and cannot pass', async () => {
    const repo = fixtureRepo();
    try {
      const r = await runSandboxed({
        repoPath: repo.dir, briefing: 'x', stateDir,
        agentStage: hostileAgent('mkdir -p /work/vendor/sub/.git && printf "[core]\\n\\tfsmonitor = x\\n" > /work/vendor/sub/.git/config'),
      });
      assert.ok(r.unsupported_changes.includes('vendor/sub/.git/config'), JSON.stringify(r.unsupported_changes));
      assert.equal(r.sandbox.capture.unresolved, 'git_metadata_path');
      assert.notEqual(aggregate({ hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null,
        executionStatus: r.status, unsupportedChanges: true }).verdict, 'pass');
    } finally { repo.cleanup(); }
  });

  test('the agent deadline keeps partial edits (QB-22) and ends as timeout', async () => {
    const repo = fixtureRepo();
    try {
      const r = await runSandboxed({
        repoPath: repo.dir, briefing: 'x', stateDir, deadlines: { agent: 4000 },
        agentStage: hostileAgent('echo partial > /work/src/partial.js; sleep 600'),
      });
      assert.equal(r.status, 'timeout');
      assert.deepEqual(r.changes.map((c) => c.file), ['src/partial.js']);
    } finally { repo.cleanup(); }
  });

  test('QB-22: an already-satisfied requirement — agent changes nothing, real sandbox tests pass, the task is VERIFIED', async () => {
    const repo = fixtureRepo((files) => {
      const pkg = JSON.parse(files['package.json'].toString());
      pkg.scripts.test = 'node --test test/*.test.js';
      files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
      files['test/double.test.js'] = "const test = require('node:test');\nconst assert = require('node:assert');\n"
        + "const double = require('../src/double');\ntest('doubles', () => assert.strictEqual(double(2), 4));\n";
      delete files['test/run.js'];
    });
    try {
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: hostileAgent('true') });
      assert.equal(r.status, 'no_change', JSON.stringify({ reason: r.reason }));
      assert.deepEqual(r.changes, []);
      const v = r.sandbox.verification;
      assert.equal(v.status, 'ran', 'tests must run even when the agent changed nothing');
      const contract = { id: 'c', goal: 'double numbers', clarifying_question: null,
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js exports a function that doubles numbers', met: null }] };
      const m = mockFetch(ollamaReply({ met: true, evidence: 'src/double.js exports (x) => Number(x) * 2' }));
      let report;
      try {
        report = await verify(contract, { relevant_files: [{ path: 'src/double.js' }], patterns: {} },
          { id: 'e', status: r.status, diff: r.diff, changes: r.changes, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.deepEqual([report.test_outcome.outcome, report.test_outcome.reason], ['passed', 'tests_passed'], v.output);
      assert.equal(report.verdict, 'pass');
    } finally { repo.cleanup(); }
  });

  test('Docker-backed admission: a second concurrent run is refused (one run per installation)', async () => {
    const { admit } = require('../../lib/sandbox/admission');
    const held = admit(stateDir, { runId: 'holder', meminfo: 'MemAvailable: 67108864 kB\n' });
    try {
      const repo = makeRepo({ 'a.txt': 'a\n' });
      try {
        const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: hostileAgent('true') });
        assert.deepEqual([r.status, r.reason], ['blocked', 'run_in_progress']);
      } finally { repo.cleanup(); }
    } finally { held.release(); }
  });
});
