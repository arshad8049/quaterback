/**
 * lib/sandbox/auth.js — credentials for the agent stage (agent-sandbox.md §5).
 *
 * Mode S (subscription, default):
 *   login/logout    the official binary (`claude auth login --claudeai` / `logout`)
 *                   in a clean auth container: no repository, no work volume,
 *                   writing into the QB-scoped volume `qb-claude-auth`.
 *   per run         under the installation's auth lock:
 *                     1. pre-run refresh: the official binary uses the stored
 *                        credential once in a clean auth container;
 *                     2. the token must outlive the stage deadline + margin,
 *                        else BLOCKED auth_refresh_required;
 *                     3. only .credentials.json (sufficient per E1) is copied
 *                        into the run's tmpfs `cred` volume.
 *                   The agent mounts only that copy. It is discarded with the run;
 *                   nothing an agent run writes ever reaches the stored credential.
 * Mode K (API key / long-lived token, opt-in): the variable is passed by name
 *   (`-e ANTHROPIC_API_KEY`), so no env file is written. Docker holds it in the
 *   container configuration; this mode does not promise memory-only storage.
 *
 * QB's Node process never reads a Mode S credential: expiry is read by `jq` in
 * a trusted container, which prints only the expiry timestamp.
 */

const fs = require('fs');
const path = require('path');
const D = require('./docker');
const P = require('./protocol');
const { hardened } = require('./workspace');
const { AGENT_IMAGE, AGENT_ENV, ensureAgentImage } = require('./agent');
const { startEgress, POLICIES } = require('./egress');

const AUTH_VOLUME = process.env.QB_AUTH_VOLUME || 'qb-claude-auth';
const AUTH_HOSTS = POLICIES.AUTH;
const MODE_K_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];
const LOCK_TIMEOUT_MS = 120_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The installation's auth lock (§5.2): login, logout and refresh+copy all take
 * it, so none of them can interleave. Owner identity is pid + start time; a lock
 * whose owner is gone is reclaimed. Throws AUTH_BUSY after `timeoutMs`.
 */
async function withAuthLock(stateDir, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'auth.lock');
  const me = P.identity(process.pid);
  const by = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(me)); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = P.readJson(lock);
      if (!owner || !P.alive(owner)) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() >= by) throw Object.assign(new Error('auth is busy (another login, logout or run refresh)'), { code: 'AUTH_BUSY' });
      await sleep(250);
    }
  }
  try { return await fn(); } finally {
    const cur = P.readJson(lock);
    if (cur && cur.pid === me.pid && cur.start === me.start) fs.rmSync(lock, { force: true });
  }
}

async function authVolumeExists() { return (await D.op(['volume', 'inspect', AUTH_VOLUME])).ok; }

/** A clean auth container: official binary, auth volume only, AUTH egress. */
async function authContainer(runId, args, { interactive = false } = {}) {
  await ensureAgentImage();
  const egress = await startEgress(runId, 'AUTH');
  try {
    const flags = [...hardened(runId, 'auth'), '--network', 'none',
      ...AGENT_ENV.filter((e) => !e.startsWith('CLAUDE_CONFIG_DIR=')).flatMap((e) => ['-e', e]),
      '-e', 'CLAUDE_CONFIG_DIR=/auth', '--tmpfs', '/tmp/home:rw,size=64m,uid=10001,gid=10001,mode=0700',
      '-v', `${AUTH_VOLUME}:/auth`, ...egress.mount(), '--entrypoint', 'sh', AGENT_IMAGE, '-c',
      `socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock & sleep 0.3; exec claude ${args}`];
    if (interactive) {
      // The user completes the browser step; stdio is the user's terminal.
      return require('../proc').run(D.DOCKER, ['run', '--rm', '-it', ...flags], { stdio: 'inherit' });
    }
    return await D.op(['run', '--rm', ...flags], { timeoutMs: 180_000 });
  } finally {
    await egress.stop();
    await D.removeRun(runId);
  }
}

/** `qb auth login`: official subscription login into the QB-scoped volume. */
async function login(stateDir) {
  return withAuthLock(stateDir, async () => {
    if (!(await authVolumeExists())) {
      await D.op(['volume', 'create', '--label', 'qb.auth=1', AUTH_VOLUME]);
      await D.op(['run', '--rm', '--user', '0', '-v', `${AUTH_VOLUME}:/v`, AGENT_IMAGE, 'chown', '10001:10001', '/v']);
    }
    return authContainer(`qbauth-${process.pid}-${Date.now()}`, 'auth login --claudeai', { interactive: true });
  });
}

/** `qb auth logout`: official logout, then remove the volume. */
async function logout(stateDir) {
  return withAuthLock(stateDir, async () => {
    if (!(await authVolumeExists())) return { ok: true, note: 'not logged in' };
    await authContainer(`qbauth-${process.pid}-${Date.now()}`, 'auth logout');
    const r = await D.op(['volume', 'rm', AUTH_VOLUME]);
    return { ok: r.ok };
  });
}

/** Expiry of the stored (or a copied) credential, read by jq in a trusted container. Epoch ms or null. */
async function credentialExpiry(volume, image) {
  const r = await D.op(['run', '--rm', '--network', 'none', '--user', '10001:10001', '--read-only', '-v', `${volume}:/c:ro`,
    '--entrypoint', 'jq', image, '-r', '.claudeAiOauth.expiresAt // empty', '/c/.credentials.json']);
  const n = Number(r.stdout.trim());
  return r.ok && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Provide credentials for one run. Returns { mode, credentialArgs, expiresAt? }
 * or throws with code AUTH_NOT_LOGGED_IN | AUTH_REFRESH_FAILED | AUTH_REFRESH_REQUIRED | AUTH_BUSY.
 * Mode S state lives in the run's `cred` volume, removed with the run.
 */
async function credentialsForRun(ws, stateDir, { stageDeadlineMs, marginMs = 10 * 60_000, env = process.env,
  refresh = () => authContainer(`${ws.runId}-auth`, '-p "Reply with exactly OK." --max-turns 1') } = {}) {
  const k = MODE_K_VARS.find((v) => env[v]);
  if (k) return { mode: 'K', variable: k, credentialArgs: ['-e', k] };

  if (!(await authVolumeExists())) {
    throw Object.assign(new Error('not logged in: run `qb auth login`'), { code: 'AUTH_NOT_LOGGED_IN' });
  }
  return withAuthLock(stateDir, async () => {
    // `refresh` is injectable for tests only; no env var or flag selects it.
    const rr = await refresh();
    if (!rr.ok) {
      throw Object.assign(new Error(`pre-run refresh failed: ${(rr.stderr || rr.stdout || '').trim().slice(-300)}`), { code: 'AUTH_REFRESH_FAILED' });
    }
    const expiresAt = await credentialExpiry(AUTH_VOLUME, ws.image);
    if (!expiresAt || expiresAt - Date.now() < stageDeadlineMs + marginMs) {
      throw Object.assign(new Error('the stored login expires before this stage could finish; try again shortly or run `qb auth login`'),
        { code: 'AUTH_REFRESH_REQUIRED', expiresAt });
    }
    // The run's tmpfs `cred` volume is created with the workspace and held by the keeper (E2).
    const cred = `${ws.runId}-cred`;
    const r = await D.op(['run', '--rm', ...hardened(ws.runId, 'cred-copy'), '--network', 'none',
      '-v', `${AUTH_VOLUME}:/src:ro`, '-v', `${cred}:/dst`, ws.image, 'cp', '/src/.credentials.json', '/dst/.credentials.json']);
    if (!r.ok) throw Object.assign(new Error(`credential copy failed: ${r.stderr.trim()}`), { code: 'INFRA' });
    return { mode: 'S', credentialArgs: ['-v', `${cred}:/cfg`], expiresAt };
  });
}

module.exports = { login, logout, credentialsForRun, withAuthLock, credentialExpiry, authVolumeExists,
  AUTH_VOLUME, AUTH_HOSTS, MODE_K_VARS };
