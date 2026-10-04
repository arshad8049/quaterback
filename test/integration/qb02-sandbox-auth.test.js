/**
 * QB-02 step 6 — T-AUTH with a fake credential (agent-sandbox.md §5, §11.2).
 * QB_INTEGRATION=1 only. Uses its own auth volume (QB_AUTH_VOLUME is set before
 * the module loads), never the user's login. T-POLICY (real Claude through the
 * proxy) needs a real login and is a separate, manual step.
 */

process.env.QB_AUTH_VOLUME = `qb-test-auth-${process.pid}`;

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const D = require('../../lib/sandbox/docker');
const A = require('../../lib/sandbox/auth');
const { createWorkspace, hardened } = require('../../lib/sandbox/workspace');

const ENABLED = process.env.QB_INTEGRATION === '1';
const BUSYBOX = 'busybox:1.36.1';
const FAKE_ACCESS = 'sk-ant-oat01-FAKEFAKEFAKEaccess000';
let stateDir, ws, seq = 0;
const runs = [];

async function writeFakeCredential(expiresInMs) {
  const json = JSON.stringify({ claudeAiOauth: { accessToken: FAKE_ACCESS, refreshToken: 'sk-ant-ort01-FAKErefresh000',
    expiresAt: Date.now() + expiresInMs, scopes: ['user:inference'], subscriptionType: 'pro' } });
  const r = await D.op(['run', '--rm', '-i', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a`, BUSYBOX,
    'sh', '-c', 'cat > /a/.credentials.json && chmod 600 /a/.credentials.json'], { input: json });
  assert.ok(r.ok, r.stderr);
}
const storedHash = async () => (await D.op(['run', '--rm', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a:ro`, BUSYBOX,
  'sha256sum', '/a/.credentials.json'])).stdout.split(' ')[0];
const ok = async () => ({ ok: true });
async function newWs() { const id = `qbauth-${process.pid}-${seq++}`; runs.push(id); return createWorkspace(id); }

describe('T-AUTH (fake credential)', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  before(async () => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-authstate-'));
    await D.op(['volume', 'create', A.AUTH_VOLUME]);
    await D.op(['run', '--rm', '--user', '0', '-v', `${A.AUTH_VOLUME}:/v`, BUSYBOX, 'chown', '10001:10001', '/v']);
    ws = await newWs();
  });
  after(async () => {
    for (const id of runs) await D.removeRun(id);
    await D.op(['volume', 'rm', '-f', A.AUTH_VOLUME]);
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  test('Mode S: only .credentials.json is copied into the run; the agent mounts only that copy', async () => {
    await writeFakeCredential(8 * 3600_000);
    await D.op(['run', '--rm', '--user', '10001:10001', '-v', `${A.AUTH_VOLUME}:/a`, BUSYBOX, 'sh', '-c', 'echo x > /a/.claude.json; mkdir -p /a/projects']);
    const c = await A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    assert.equal(c.mode, 'S');
    assert.deepEqual(c.credentialArgs, ['-v', `${ws.runId}-cred:/cfg`]);
    const r = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none', ...c.credentialArgs, BUSYBOX, 'ls', '-A', '/cfg']);
    assert.equal(r.stdout.trim(), '.credentials.json');
  });

  test('no write-back: an agent overwriting its copy with attacker values leaves the stored credential byte-identical', async () => {
    const before0 = await storedHash();
    const w = await newWs();
    const c = await A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} });
    const r = await D.op(['run', '--rm', ...hardened(w.runId, 'workload'), '--network', 'none', ...c.credentialArgs, BUSYBOX,
      'sh', '-c', 'echo \'{"claudeAiOauth":{"accessToken":"attacker","refreshToken":"attacker","expiresAt":9999999999999}}\' > /cfg/.credentials.json; echo hook > /cfg/settings.json']);
    assert.ok(r.ok);
    // The write really landed in the run's copy (guards against an empty copy passing this test).
    const seen = await D.op(['run', '--rm', ...hardened(w.runId, 'probe'), '--network', 'none', ...c.credentialArgs, BUSYBOX,
      'grep', '-c', 'attacker', '/cfg/.credentials.json']);
    assert.equal(seen.stdout.trim(), '1');
    await D.removeRun(w.runId);
    assert.equal(await storedHash(), before0);
  });

  test('a token that would expire during the stage → AUTH_REFRESH_REQUIRED, nothing copied', async () => {
    await writeFakeCredential(5 * 60_000);
    const w = await newWs();
    await assert.rejects(A.credentialsForRun(w, stateDir, { stageDeadlineMs: 30 * 60_000, refresh: ok, env: {} }),
      (e) => e.code === 'AUTH_REFRESH_REQUIRED');
    const r = await D.op(['run', '--rm', ...hardened(w.runId, 'probe'), '--network', 'none', '-v', `${w.runId}-cred:/cfg:ro`, BUSYBOX, 'ls', '-A', '/cfg']);
    assert.equal(r.stdout.trim(), '', 'no credential may be copied for a run that is refused');
  });

  test('a failed pre-run refresh → AUTH_REFRESH_FAILED (real official binary, fake token)', async () => {
    await writeFakeCredential(-60_000);
    const w = await newWs();
    await assert.rejects(A.credentialsForRun(w, stateDir, { stageDeadlineMs: 600_000, env: {} }),
      (e) => e.code === 'AUTH_REFRESH_FAILED');
  });

  test('the auth lock: a concurrent login/refresh waits, then reports AUTH_BUSY', async () => {
    let release;
    const held = A.withAuthLock(stateDir, () => new Promise((r) => { release = r; }));
    await new Promise((r) => setTimeout(r, 100));
    await assert.rejects(A.withAuthLock(stateDir, async () => 'second', { timeoutMs: 800 }), (e) => e.code === 'AUTH_BUSY');
    release(); await held;
    assert.equal(await A.withAuthLock(stateDir, async () => 'after', { timeoutMs: 800 }), 'after');
  });

  test('Mode K: passed by variable name only; no credential file on the host; value never in argv', async () => {
    const c = await A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, env: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' } });
    assert.deepEqual(c, { mode: 'K', variable: 'ANTHROPIC_API_KEY', credentialArgs: ['-e', 'ANTHROPIC_API_KEY'] });
    assert.ok(!c.credentialArgs.join(' ').includes('FAKE'));
  });

  test('not logged in → AUTH_NOT_LOGGED_IN', async () => {
    await D.op(['volume', 'rm', '-f', A.AUTH_VOLUME]);
    await assert.rejects(A.credentialsForRun(ws, stateDir, { stageDeadlineMs: 600_000, refresh: ok, env: {} }),
      (e) => e.code === 'AUTH_NOT_LOGGED_IN');
  });
});
