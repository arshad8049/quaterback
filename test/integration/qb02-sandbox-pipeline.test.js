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
const { hardened, createWorkspace } = require('../../lib/sandbox/workspace');
const { AGENT_IMAGE } = require('../../lib/sandbox/agent');
const { aggregate } = require('../../verify/verdict');
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo, fingerprint } = require('../helpers/tmprepo');

const ENABLED = process.env.QB_INTEGRATION === '1';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'npm-app');
let stateDir;

const NODE_TEST = (files) => {
  const pkg = JSON.parse(files['package.json'].toString());
  pkg.scripts.test = 'node --test test/*.test.js';
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
  files['test/double.test.js'] = "const test = require('node:test');\nconst assert = require('node:assert');\n"
    + "const double = require('../src/double');\ntest('doubles', () => assert.strictEqual(double(2), 4));\n";
  delete files['test/run.js'];
};

// QB-16: registry-shaped checks for the fixture's src/double.js.
const DOUBLE_CHECKS = [
  { id: 'DBL-1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/double.js', export: 'default', args: [2], expect: 4 } },
  { id: 'DBL-2', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/double.js', export: 'default', args: ['3'], expect: 6 } },
];

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
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: hostileAgent('true'),
        snapshotPaths: ['src/double.js'], checks: DOUBLE_CHECKS });
      assert.equal(r.status, 'no_change', JSON.stringify({ reason: r.reason }));
      assert.deepEqual(r.changes, []);
      const v = r.sandbox.verification;
      assert.equal(v.status, 'ran', 'tests must run even when the agent changed nothing');
      // A human-approved oracle (QB-13): only then can the run PASS.
      const contract = approve({ id: 'c', goal: 'double numbers', clarifying_question: null, checks: DOUBLE_CHECKS,
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js exports a function that doubles numbers', met: null, kind: 'behavioral' }] }, { via: 'test' });
      const m = mockFetch(ollamaReply({ met: true, evidence: 'src/double.js exports (x) => Number(x) * 2' }));
      let report;
      try {
        report = await verify(contract, { relevant_files: [{ path: 'src/double.js' }], patterns: {} },
          { id: 'e', status: r.status, diff: r.diff, changes: r.changes, candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.deepEqual([report.test_outcome.outcome, report.test_outcome.reason], ['passed', 'tests_passed'], v.output);
      assert.equal(report.verdict, 'pass');
      // QB-16: the behavioural criterion was decided by the executed checks, on the tested tree.
      assert.deepEqual(report.checks.results.map((x) => [x.id, x.status]), [['DBL-1', 'pass'], ['DBL-2', 'pass']], JSON.stringify(report.checks));
      assert.deepEqual([report.criteria_results[0].method, report.criteria_results[0].check_status], ['check', 'passed']);
      assert.equal(r.sandbox.checks.tree, r.candidate_tree, 'checks ran on the captured tree');
      assert.equal(report.test_outcome.tree, r.candidate_tree, 'tested the captured tree');
    } finally { repo.cleanup(); }
  });

  test('QB-22 review: a host edit after seeding is never judged — material and tests come from the seeded snapshot', async () => {
    const repo = fixtureRepo(NODE_TEST);
    const original = fs.readFileSync(path.join(repo.dir, 'src/double.js'));
    try {
      // The agent stage edits the HOST checkout (an editor or another task), after seeding, then changes nothing in /work.
      const editingAgent = (ws, egress, opts) => {
        fs.writeFileSync(path.join(repo.dir, 'src/double.js'), 'module.exports = (x) => x * 2;\nmodule.exports.tripleIt = (x) => x * 3;\n');
        return hostileAgent('true')(ws, egress, opts);
      };
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: editingAgent, snapshotPaths: ['src/double.js'] });
      assert.equal(r.status, 'no_change', JSON.stringify({ reason: r.reason }));
      const [f] = r.sandbox.snapshot.files;
      assert.equal(f.text, original.toString(), 'the exported material is the seeded file, not the later host edit');
      assert.equal(f.oid, crypto.createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex'));
      const contract = { id: 'c', goal: 'tripleIt', clarifying_question: null,
        // non_behavioral so the judge decides it: this test is about the judge's snapshot material.
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js exports tripleIt', met: null, kind: 'non_behavioral' }] };
      // A judge that answers only from the material it is given.
      const m = mockFetch((url, init) => {
        const user = JSON.parse(init.body).messages.find((x) => x.role === 'user').content;
        return ollamaReply(/tripleIt/.test(user.split('## Current repository files')[1] || '')
          ? { met: true, evidence: 'src/double.js exports tripleIt' }
          : { met: false, evidence: 'src/double.js has no tripleIt', repair: 'add tripleIt' });
      });
      let report;
      try {
        report = await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes,
          candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.notEqual(report.verdict, 'pass', 'approved code that was never in the tested snapshot');
      assert.equal(report.verdict, 'fail');
    } finally { repo.cleanup(); }
  });

  test('QB-16: executed checks fail a regression the judge would have approved', async () => {
    const repo = fixtureRepo(NODE_TEST);
    try {
      // The agent breaks double() for every input but 2; the visible test only checks double(2), so the suite stays green.
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, checks: DOUBLE_CHECKS,
        agentStage: hostileAgent("printf 'module.exports = (x) => (Number(x) === 2 ? 4 : 0);\\n' > /work/src/double.js") });
      assert.equal(r.status, 'completed', JSON.stringify({ reason: r.reason }));
      const contract = { id: 'c', goal: 'double numbers', clarifying_question: null, checks: DOUBLE_CHECKS,
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js doubles numbers and rejects non-numbers', met: null, kind: 'behavioral' }] };
      const m = mockFetch(ollamaReply({ met: true, evidence: 'looks right' }));
      let report;
      try {
        report = await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes,
          candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.deepEqual(report.checks.results.map((x) => [x.id, x.status]), [['DBL-1', 'pass'], ['DBL-2', 'fail']], JSON.stringify(report.checks));
      assert.equal(report.verdict, 'fail');
    } finally { repo.cleanup(); }
  });

  test('KAN-16 review: a test script that rewrites the source cannot make the checks approve the broken candidate', async () => {
    // The visible suite runs a generator that rewrites src/double.js correctly, then passes.
    const repo = fixtureRepo((files) => {
      NODE_TEST(files);
      const pkg = JSON.parse(files['package.json'].toString());
      pkg.scripts.test = 'node scripts/build.js && node --test test/*.test.js';
      files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
      files['scripts/build.js'] = "require('fs').writeFileSync(require('path').join(__dirname, '..', 'src', 'double.js'),\n"
        + "  \"const isNumber = require('is-number');\\nmodule.exports = (x) => (isNumber(x) ? Number(x) * 2 : null);\\n\");\n";
    });
    try {
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, checks: DOUBLE_CHECKS,
        agentStage: hostileAgent("printf 'module.exports = () => 0;\\n' > /work/src/double.js") });
      assert.equal(r.status, 'completed', JSON.stringify({ reason: r.reason }));
      assert.equal(r.sandbox.checks.tree, r.candidate_tree, 'checks ran on the fresh candidate checkout');
      const contract = approve({ id: 'c', goal: 'double numbers', clarifying_question: null, checks: DOUBLE_CHECKS,
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js doubles numbers', met: null, kind: 'behavioral' }] }, { via: 'test' });
      const m = mockFetch(ollamaReply({ met: true, evidence: 'looks right' }));
      let report;
      try {
        report = await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes,
          candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.equal(report.test_outcome.outcome, 'passed', 'the visible suite passed (it rebuilt the file)');
      assert.deepEqual(report.checks.results.map((x) => [x.id, x.status]), [['DBL-1', 'fail'], ['DBL-2', 'fail']], JSON.stringify(report.checks));
      assert.equal(report.verdict, 'fail');
    } finally { repo.cleanup(); }
  });

  test('QB-09: a protected file change fails the task though tests, checks and the judge all pass', async () => {
    const repo = fixtureRepo((files) => { NODE_TEST(files); files['docs/notes.md'] = '# notes\n'; });
    try {
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, checks: DOUBLE_CHECKS,
        agentStage: hostileAgent("printf 'module.exports = (x) => Number(x) * 2;\\n' > /work/src/double.js; echo edited >> /work/docs/notes.md") });
      assert.equal(r.status, 'completed', JSON.stringify({ reason: r.reason }));
      const contract = approve({ id: 'c', goal: 'double numbers', clarifying_question: null, checks: DOUBLE_CHECKS,
        acceptance_criteria: [{ id: 'AC-1', criterion: 'src/double.js doubles numbers', met: null, kind: 'behavioral' }],
        scope: { allowed_changes: ['src/**'], protected_paths: ['docs/**'] } }, { via: 'test' });
      const m = mockFetch(ollamaReply({ met: true, evidence: 'looks right' }));
      let report;
      try {
        report = await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes,
          candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.equal(report.test_outcome.outcome, 'passed');
      assert.ok(report.checks.results.every((x) => x.status === 'pass'), JSON.stringify(report.checks.results));
      assert.deepEqual(report.policy.protected_touched, ['docs/notes.md']);
      assert.equal(report.verdict, 'fail');
    } finally { repo.cleanup(); }
  });

  test('QB-10: base vs candidate — a pre-existing failure stays visible, only the new failure is a regression', async () => {
    const repo = fixtureRepo((files) => {
      NODE_TEST(files);
      files['test/legacy.test.js'] = "require('node:test')('legacy is already broken', () => { throw new Error('known base failure'); });\n";
    });
    try {
      const contract = approve({ id: 'c', goal: 'g', clarifying_question: null, scope: { allowed_changes: ['src/**'] },
        acceptance_criteria: [{ id: 'AC-1', criterion: 'style', met: null, kind: 'non_behavioral' }] }, { via: 'test' });
      const verifyWith = async (r) => {
        const m = mockFetch(ollamaReply({ met: true, evidence: 'ok' }));
        try { return await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes, candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir }); }
        finally { m.restore(); }
      };
      // 1. The agent breaks double(): one regression, one pre-existing failure.
      const broken = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir,
        agentStage: hostileAgent("printf 'module.exports = () => 0;\\n' > /work/src/double.js") });
      assert.ok(broken.sandbox.verification.base, 'the base suite ran because the candidate failed');
      const r1 = await verifyWith(broken);
      assert.deepEqual(r1.test_outcome.regressions.map((t) => t.name), ['doubles'], JSON.stringify(r1.test_outcome));
      assert.deepEqual(r1.test_outcome.preexisting.map((t) => t.name), ['legacy is already broken']);
      assert.equal(r1.verdict, 'fail');
      assert.ok(r1.repair_hints.some((h) => /Test "doubles"/.test(h.diagnosis)));
      // 2. A harmless in-scope change: only the pre-existing failure remains — visible, not blamed.
      const harmless = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir,
        agentStage: hostileAgent("printf '// note\\n' >> /work/src/double.js") });
      const r2 = await verifyWith(harmless);
      assert.equal(r2.test_outcome.outcome, 'preexisting_failures', JSON.stringify(r2.test_outcome));
      assert.deepEqual(r2.test_outcome.preexisting.map((t) => t.name), ['legacy is already broken']);
      assert.equal(r2.verdict, 'pass');
    } finally { repo.cleanup(); }
  });

  test('QB-14: a constant-zero VAD fails the call_sequence checks inside the real sandbox', async () => {
    const vad = (body) => `class AdaptiveVAD {\n  constructor() { this.n = 0; this.ms = 0; }\n  onSpeech(ms) { ${body} }\n  getVADStats() { return { speechCount: this.n, totalSpeechMs: this.ms }; }\n}\nmodule.exports = { AdaptiveVAD };\n`;
    const repo = fixtureRepo((files) => { NODE_TEST(files); files['src/vad.js'] = vad('this.n += 1; this.ms += ms;'); });
    const NEW = { construct: 'new', args: [] };
    const checks = [
      { id: 'ACC', ac_id: 'AC-1', adapter: 'call_sequence', params: { module: 'src/vad.js', export: 'AdaptiveVAD', instances: { a: NEW },
        steps: [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'a', method: 'onSpeech', args: [200] }, { on: 'a', method: 'getVADStats', args: [], expect: { speechCount: 2, totalSpeechMs: 500 } }] } },
      { id: 'IND', ac_id: 'AC-1', adapter: 'call_sequence', params: { module: 'src/vad.js', export: 'AdaptiveVAD', instances: { a: NEW, b: NEW },
        steps: [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'b', method: 'getVADStats', args: [], expect: { speechCount: 0, totalSpeechMs: 0 } }] } },
    ];
    try {
      // The agent "implements" stats as constant zero by making onSpeech a no-op.
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, checks,
        agentStage: hostileAgent("sed -i 's/this.n += 1; this.ms += ms;//' /work/src/vad.js") });
      assert.equal(r.status, 'completed', JSON.stringify({ reason: r.reason }));
      const contract = approve({ id: 'c', goal: 'VAD stats', clarifying_question: null, checks, scope: { allowed_changes: ['src/**'] },
        acceptance_criteria: [{ id: 'AC-1', criterion: 'stats accumulate per instance', met: null, kind: 'behavioral' }] }, { via: 'test' });
      const m = mockFetch(ollamaReply({ met: true, evidence: 'looks right' }));
      let report;
      try {
        report = await verify(contract, null, { id: 'e', status: r.status, diff: r.diff, changes: r.changes, candidate_tree: r.candidate_tree, sandbox: r.sandbox }, { repoPath: repo.dir });
      } finally { m.restore(); }
      assert.deepEqual(report.checks.results.map((x) => [x.id, x.status]), [['ACC', 'fail'], ['IND', 'pass']], JSON.stringify(report.checks));
      assert.equal(report.verdict, 'fail');
    } finally { repo.cleanup(); }
  });

  test('QB-22: the trusted export refuses oversized files, symlinks, directories and missing paths', async () => {
    const repo = fixtureRepo((files) => { NODE_TEST(files); files['big.txt'] = Buffer.alloc(70 * 1024, 97); });
    fs.symlinkSync('src/double.js', path.join(repo.dir, 'link.js'));
    try {
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: hostileAgent('true'),
        snapshotPaths: ['big.txt', 'link.js', 'src', 'nope.js', 'src/double.js'] });
      assert.equal(r.status, 'no_change', JSON.stringify({ reason: r.reason }));
      const s = r.sandbox.snapshot;
      assert.equal(s.tree, r.candidate_tree);
      assert.deepEqual(s.files.map((f) => f.path), ['src/double.js']);
      assert.deepEqual(s.skipped.map((x) => [x.path, x.reason]),
        [['big.txt', 'too_large'], ['link.js', 'not_regular'], ['src', 'not_regular'], ['nope.js', 'missing']]);
    } finally { repo.cleanup(); }
  });

  test('KAN-22 re-review: a newline filename is never split into other files; tab, quote and unicode names are exact', async () => {
    const repo = fixtureRepo((files) => {
      NODE_TEST(files);
      Object.assign(files, { 'a': 'file a\n', 'b': 'file b\n', 'a\nb': 'the newline file\n',
        'tab\tname.js': 'tab\n', 'quote"d.js': 'quoted\n', 'späce ü.js': 'unicode\n' });
    });
    try {
      const r = await runSandboxed({ repoPath: repo.dir, briefing: 'x', stateDir, agentStage: hostileAgent('true'),
        snapshotPaths: ['a\nb', 'tab\tname.js', 'quote"d.js', 'späce ü.js', 'a'] });
      assert.equal(r.status, 'no_change', JSON.stringify({ reason: r.reason }));
      const s = r.sandbox.snapshot;
      assert.equal(s.error, undefined, s.error);
      assert.deepEqual(s.files.map((f) => [f.path, f.text]), [['quote"d.js', 'quoted\n'], ['späce ü.js', 'unicode\n'], ['a', 'file a\n']]);
      assert.deepEqual(s.skipped, [{ path: 'a\nb', reason: 'unsupported_path' }, { path: 'tab\tname.js', reason: 'unsupported_path' }]);
      assert.ok(!s.files.some((f) => f.path === 'b'), 'b was never requested');
    } finally { repo.cleanup(); }
  });

  test('KAN-22 re-review: the export script itself refuses a raw control character instead of splitting', async () => {
    const repo = fixtureRepo((files) => Object.assign(files, { 'a': 'file a\n', 'b': 'file b\n', 'a\nb': 'nl\n' }));
    const runId = `qbsnap-${process.pid}`;
    try {
      const ws = await createWorkspace(runId);
      assert.equal((await ws.seed(repo.dir)).stage.state, 'completed');
      assert.notEqual((await ws.capture()).verdict.state, 'error');
      const st = await D.runStage(`${runId}-snapraw`, [...hardened(runId, 'snapshot'), '--network', 'none',
        ...ws.mount('git', true), ...ws.mount('out'), ws.image, '/usr/local/lib/qb/snapshot.sh'], { input: Buffer.from('a\nb\0') });
      assert.equal(st.state, 'execution_error');
      assert.equal(st.exit_code, 3);
      assert.match(st.stderr, /control character/);
    } finally { await D.removeRun(runId); repo.cleanup(); }
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
