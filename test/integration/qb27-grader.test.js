/**
 * QB-27 through the real sandbox (QB_INTEGRATION=1, Docker):
 *   - suite qualification: reference passes, two incorrect implementations fail;
 *   - the review example: the correct 30s patch passes and the invented 5m patch fails,
 *     with QB's contract present and ignored; a syntax error fails;
 *   - grading runs with no network and no credentials, even when the host has them;
 *   - an agent stage on the task repository cannot find the hidden suite anywhere:
 *     filesystem, environment, or git history.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../../lib/sandbox/docker');
const { runSandboxed } = require('../../lib/sandbox/pipeline');
const { hardened } = require('../../lib/sandbox/workspace');
const { AGENT_IMAGE } = require('../../lib/sandbox/agent');
const { grade } = require('../../bench/grader');
const { qualify } = require('../../bench/qualify');
const S = require('../../bench/schemas');
const { gradingFixture, INVENTED_CONTRACT, SUITE } = require('../helpers/grading-fixture');

const ENABLED = process.env.QB_INTEGRATION === '1';
const CANARY = 'QB27-CANARY-7f3a91';

describe('QB-27: the external grader in the real sandbox', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  let stateDir; const fixtures = [];
  before(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb27-state-')); });
  after(() => { for (const f of fixtures) f.cleanup(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const sandbox = () => ({ stateDir, deadlines: { verify: 180_000 } });

  test('qualified suite: 30s passes, the invented 5m fails, a syntax error fails — QB\'s contract is ignored', async () => {
    const f = gradingFixture(); fixtures.push(f);
    const qualification = await qualify({ spec: f.spec, suitesRoot: f.suitesRoot, sandbox: sandbox(),
      reference: f.patch('correct'), incorrect: [{ label: '5m', patch: f.patch('fiveMinutes') }, { label: 'off-by-one', patch: f.patch('offByOne') }] });
    const spec = { ...f.spec, qualification };
    const run = (patch) => grade({ spec, patch, contract: INVENTED_CONTRACT, suitesRoot: f.suitesRoot, sandbox: sandbox() });
    const ok = await run(f.patch('correct'));
    assert.deepEqual([ok.outcome, ok.reason], ['pass', 'tests_passed'], ok.detail);
    assert.equal(ok.environment.image, AGENT_IMAGE);
    const five = await run(f.patch('fiveMinutes'));
    assert.deepEqual([five.outcome, five.reason], ['fail', 'tests_failed']);
    const syn = await run(f.patch('syntaxError'));
    assert.deepEqual([syn.outcome, syn.reason], ['fail', 'syntax_or_load_error']);
    // re-review 1: the patch is applied INSIDE the sandbox; one that does not apply fails there
    const bad = await run('diff --git a/src/duration.js b/src/duration.js\n--- a/src/duration.js\n+++ b/src/duration.js\n@@ -1 +1 @@\n-no such line\n+x\n');
    assert.deepEqual([bad.outcome, bad.reason], ['fail', 'patch_does_not_apply']);
  });

  test('grading has no network and no credentials, even when the host process holds them', async () => {
    const isolation = {
      ...SUITE,
      'isolation.test.js': "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\n"
        + "const fs = require('fs');\nconst net = require('net');\n"
        + "test('no credentials in the environment or home', () => {\n"
        + "  for (const k of Object.keys(process.env)) assert.doesNotMatch(k, /ANTHROPIC|CLAUDE|OPENAI|TOKEN|SECRET|API_KEY/);\n"
        + "  assert.ok(!fs.existsSync(`${process.env.HOME || '/nonexistent'}/.claude`));\n});\n"
        + "test('no network', async () => {\n"
        + "  const r = await new Promise((res) => { const s = net.connect({ host: '1.1.1.1', port: 443, timeout: 3000 });\n"
        + "    s.on('connect', () => { s.destroy(); res('connected'); }); s.on('error', () => res('error')); s.on('timeout', () => { s.destroy(); res('timeout'); }); });\n"
        + "  assert.notEqual(r, 'connected');\n});\n",
    };
    const f = gradingFixture({ suite: isolation }); fixtures.push(f);
    const spec = { ...f.spec, suite: { ...f.spec.suite, command: ['node', '--test', 'test/hidden/duration.test.js', 'test/hidden/isolation.test.js'] } };
    const saved = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-qb27-fake-host-key', CLAUDE_CODE_OAUTH_TOKEN: 'qb27-fake-host-token' });
    try {
      const r = await grade({ spec, patch: f.patch('correct'), suitesRoot: f.suitesRoot, sandbox: sandbox(), qualifying: true });
      assert.deepEqual([r.outcome, r.reason], ['pass', 'tests_passed'], `${r.reason} ${r.detail || ''}`);
      assert.ok(r.checks.some((c) => c.name === 'no network' && c.status === 'passed'));
      assert.ok(r.checks.some((c) => c.name === 'no credentials in the environment or home' && c.status === 'passed'));
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  test('an agent stage on the task repository finds the hidden suite nowhere: filesystem, environment, git history', async () => {
    const f = gradingFixture({ suite: { 'duration.test.js': `${SUITE['duration.test.js']}// ${CANARY}\n` } }); fixtures.push(f);
    const r = await runSandboxed({
      repoPath: f.repo.dir, briefing: 'x', stateDir, deadlines: { agent: 180_000 }, verify: false,
      agentStage: (ws, egress, { waitTimeoutMs }) => D.runStage(`${ws.runId}-agent`, [
        ...hardened(ws.runId, 'workload'), '--network', 'none', ...ws.mount('work'),
        '-e', 'HOME=/tmp/home', '--tmpfs', '/tmp/home:rw,size=16m,uid=10001,gid=10001',
        '--entrypoint', 'sh', AGENT_IMAGE, '-c',
        `cd /work
         { grep -rIl --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev ${CANARY} / 2>/dev/null | head -3
           env | grep -c ${CANARY}
           git log --all -p 2>/dev/null | grep -c ${CANARY}
           true; } > /work/search-result.txt 2>&1 || true`,
      ], { waitTimeoutMs }),
    });
    const added = String(r.diff || '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    assert.deepEqual(added, ['0', '0'], `the agent found the hidden suite: ${added.join(' | ')}`);
    assert.equal(S.hashOf(S.fileHashes(path.join(f.suitesRoot, 'T-30S'))), S.hashOf(f.spec.suite.files));
  });
});
