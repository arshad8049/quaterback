/**
 * QB-02 step 5 — dependencies ② and verification ⑤ with real Docker and the
 * npm registry (agent-sandbox.md §3.2, §3.5; §11.2 T-DEPS, T-VERIFY; QB-02
 * done-when "trusted-test modification is denied"). QB_INTEGRATION=1 only.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const path = require('path');

const D = require('../../lib/sandbox/docker');
const { createWorkspace, hardened } = require('../../lib/sandbox/workspace');
const { prepareDeps, runVerification } = require('../../lib/sandbox/stages');
const { makeRepo } = require('../helpers/tmprepo');
const { classifyTestRun } = require('../../verify/tests');

const ENABLED = process.env.QB_INTEGRATION === '1';
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'npm-app');
const BUSYBOX = 'busybox:1.36.1';
let seq = 0;
const runs = [];

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

/** seed → deps → stand-in agent `script` in /work → capture → verify. */
async function pipeline(repo, script = 'true') {
  const runId = `qbstg-${process.pid}-${seq++}`;
  runs.push(runId);
  const ws = await createWorkspace(runId);
  const seeded = await ws.seed(repo.dir);
  assert.equal(seeded.stage.state, 'completed', seeded.stage.stderr);
  const deps = await prepareDeps(ws);
  if (deps.status === 'blocked' || deps.status === 'setup_failed') return { ws, deps };
  const agent = await D.runStage(`${runId}-agent`, [...hardened(runId, 'workload'), '--network', 'none',
    ...ws.mount('work'), BUSYBOX, 'sh', '-c', script]);
  assert.equal(agent.state, 'completed', agent.stderr);
  const cap = await ws.capture();
  const ver = await runVerification(ws, deps);
  return { ws, deps, cap, ver };
}

describe('T-DEPS and T-VERIFY', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker + npm registry)' }, () => {
  before(async () => { assert.ok((await D.op(['pull', '-q', BUSYBOX], { timeoutMs: 120_000 })).ok); });
  after(async () => { for (const id of runs) await D.removeRun(id); });

  test('supported project: deps install behind the DEPS proxy; base tests pass in the sandbox', async () => {
    const repo = fixtureRepo();
    try {
      const { deps, ver } = await pipeline(repo);
      assert.equal(deps.status, 'ready', JSON.stringify(deps));
      assert.match(deps.manifest_fp, /^[0-9a-f]{64}$/);
      assert.equal(ver.status, 'ran', JSON.stringify({ reason: ver.reason, prep: ver.prep, prepStage: ver.prepStage && (ver.prepStage.stderr || '').slice(-600) }));
      assert.equal(ver.stage.state, 'completed', ver.stage.stdout + ver.stage.stderr);
      assert.match(ver.stage.stdout, /fixture tests passed/);
    } finally { repo.cleanup(); }
  });

  test('a real regression fails verification (execution_error)', async () => {
    const repo = fixtureRepo();
    try {
      const { ver } = await pipeline(repo, "printf 'module.exports = () => 0;\\n' > /work/src/double.js");
      assert.equal(ver.stage.state, 'execution_error');
    } finally { repo.cleanup(); }
  });

  test('trusted-test modification is denied: weakened tests and test script cannot change the verdict', async () => {
    const repo = fixtureRepo();
    try {
      const { ver } = await pipeline(repo, `
        printf 'module.exports = () => 0;\\n' > /work/src/double.js
        printf 'console.log("fixture tests passed")\\n' > /work/test/run.js
        printf 'process.exit(0)\\n' > /work/test/extra.test.js
        sed -i 's#"test": "node test/run.js"#"test": "exit 0"#' /work/package.json`);
      assert.equal(ver.status, 'ran');
      assert.equal(ver.stage.state, 'execution_error', 'the base tests must still run and fail');
      assert.deepEqual(ver.prep.protected_modified.sort(), ['test/extra.test.js', 'test/run.js']);
      assert.equal(ver.prep.test_script_changed, true);
    } finally { repo.cleanup(); }
  });

  test('changing dependencies → dependency_change_required, verification not run', async () => {
    const repo = fixtureRepo();
    try {
      const { ver } = await pipeline(repo, "sed -i 's/\"is-number\": \"7.0.0\"/\"is-number\": \"6.0.0\"/' /work/package.json");
      assert.deepEqual([ver.status, ver.reason], ['not_run', 'dependency_change_required']);
      assert.deepEqual(ver.prep.changed, ['package.json']);
    } finally { repo.cleanup(); }
  });

  for (const [name, mutate, reason, detail] of [
    ['missing lockfile', (f) => { delete f['package-lock.json']; }, 'setup_missing_lockfile', null],
    ['root postinstall', (f) => { const p = JSON.parse(f['package.json']); p.scripts.postinstall = 'node -e 1'; f['package.json'] = JSON.stringify(p); }, 'setup_unsupported_project', /lifecycle/],
    ['npm workspaces', (f) => { const p = JSON.parse(f['package.json']); p.workspaces = ['pkgs/*']; f['package.json'] = JSON.stringify(p); }, 'setup_unsupported_project', /workspaces/],
    ['a file: dependency', (f) => { const l = JSON.parse(f['package-lock.json']); l.packages['node_modules/local'] = { resolved: 'file:../local', link: true }; f['package-lock.json'] = JSON.stringify(l); }, 'setup_unsupported_project', /file:\/link:\/git/],
  ]) {
    test(`unsupported profile: ${name} → BLOCKED ${reason}, nothing installed`, async () => {
      const repo = fixtureRepo(mutate);
      try {
        const { deps } = await pipeline(repo);
        assert.equal(deps.status, 'blocked', JSON.stringify(deps));
        assert.equal(deps.reason, reason);
        if (detail) assert.match(deps.detail, detail);
        assert.equal(deps.stages.install, undefined, 'npm must not run for an unsupported project');
      } finally { repo.cleanup(); }
    });
  }

  test('an install that writes outside node_modules is detected by the trusted check', async () => {
    const repo = fixtureRepo();
    const runId = `qbstg-${process.pid}-${seq++}`; runs.push(runId);
    try {
      const ws = await createWorkspace(runId);
      assert.equal((await ws.seed(repo.dir)).stage.state, 'completed');
      // Run only the trusted halves around a simulated install that also writes into the project.
      const plan = await D.runStage(`${runId}-p`, [...hardened(runId, 'deps-plan'), '--network', 'none', ...ws.mount('git'), ...ws.mount('scratch'), ws.image, '/usr/local/lib/qb/deps-plan.sh']);
      assert.equal(plan.state, 'completed');
      await D.runStage(`${runId}-i`, [...hardened(runId, 'workload'), '--network', 'none', ...ws.mount('scratch'), BUSYBOX, 'sh', '-c', 'mkdir -p /scratch/node_modules/x && echo gen > /scratch/src/generated.js']);
      const chk = await D.runStage(`${runId}-c`, [...hardened(runId, 'deps-check'), '--network', 'none', ...ws.mount('git'), ...ws.mount('scratch', true), ws.image, '/usr/local/lib/qb/deps-check.sh']);
      assert.match(chk.stdout, /install modified the project tree/);
      assert.match(chk.stdout, /src\/generated\.js/);
    } finally { repo.cleanup(); }
  });

  test('a project without package.json: deps skipped, verification not_run (no_test_command)', async () => {
    const repo = makeRepo({ 'README.md': '# plain\n' });
    try {
      const { deps, ver } = await pipeline(repo);
      assert.equal(deps.status, 'skip');
      assert.deepEqual([ver.status, ver.reason], ['not_run', 'no_test_command']);
    } finally { repo.cleanup(); }
  });
});

// QB-06: the machine-readable report from QB's node:test reporter, end to end.
const NODE_TEST = (files) => {
  const pkg = JSON.parse(files['package.json'].toString());
  pkg.scripts.test = 'node --test test/*.test.js';
  files['package.json'] = JSON.stringify(pkg, null, 2) + '\n';
  files['test/double.test.js'] = "const test = require('node:test');\nconst assert = require('node:assert');\n"
    + "const double = require('../src/double');\n"
    + "test('doubles numbers', () => assert.strictEqual(double(2), 4));\n"
    + "test('doubles numeric strings', () => assert.strictEqual(double('3'), 6));\n"
    + "test('rejects non-numbers', () => assert.strictEqual(double('x'), null));\n";
  delete files['test/run.js'];
};

describe('QB-06: machine-readable test report from the sandbox', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker + npm registry)' }, () => {
  before(async () => { assert.ok((await D.op(['pull', '-q', BUSYBOX], { timeoutMs: 120_000 })).ok); });
  after(async () => { for (const id of runs) await D.removeRun(id); });

  test('node:test project: the report validates and classifies as passed', async () => {
    const repo = fixtureRepo(NODE_TEST);
    try {
      const { ver } = await pipeline(repo);
      assert.equal(ver.status, 'ran', JSON.stringify({ reason: ver.reason }));
      assert.equal(typeof ver.report, 'string', ver.report_error);
      const c = classifyTestRun({ status: 'ran', state: ver.stage.state, exit_code: ver.stage.exit_code, report: ver.report });
      assert.deepEqual([c.outcome, c.counts.tests, c.counts.passed], ['passed', 3, 3], ver.stage.stdout + ver.stage.stderr);
      assert.match(ver.stage.stdout, /doubles numbers/, 'the console reporter still prints for people');
    } finally { repo.cleanup(); }
  });

  test('node:test project with a regression: classified as a real test failure', async () => {
    const repo = fixtureRepo(NODE_TEST);
    try {
      const { ver } = await pipeline(repo, "printf 'module.exports = () => 0;\\n' > /work/src/double.js");
      const c = classifyTestRun({ status: 'ran', state: ver.stage.state, exit_code: ver.stage.exit_code, report: ver.report });
      assert.deepEqual([c.outcome, c.reason, c.counts.failed], ['failed', 'tests_failed', 3]);
    } finally { repo.cleanup(); }
  });

  test('a test script that is not node:test writes no report: error, never pass', async () => {
    const repo = fixtureRepo();
    try {
      const { ver } = await pipeline(repo);
      assert.equal(ver.stage.state, 'completed');
      assert.equal(ver.report, null);
      const c = classifyTestRun({ status: 'ran', state: ver.stage.state, exit_code: ver.stage.exit_code, report: ver.report, report_error: ver.report_error });
      assert.deepEqual([c.outcome, c.reason], ['error', 'no_machine_readable_report']);
    } finally { repo.cleanup(); }
  });
});
