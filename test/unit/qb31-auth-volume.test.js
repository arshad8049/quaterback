/**
 * QB-31 walkthrough (owner, fresh Codespace): "Login successful" but nothing was stored. The
 * QB login volume was root:root 0755, so the login container (uid 10001) could not write
 * .credentials.json. Cause: on a fresh machine login() created the volume and ran `chown` with
 * the agent image BEFORE building it (the build happens later, in authContainer); the chown
 * failed, its result was ignored, and later logins skipped it because the volume existed.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SB = path.join(__dirname, '..', '..', 'lib', 'sandbox');

/** Load lib/sandbox/auth.js with docker/agent/egress/proc replaced by a scripted fake. */
function loadAuth({ volumeExists = false, chownFails = false } = {}) {
  const calls = [];
  let imageBuilt = false; let exists = volumeExists;
  const docker = {
    DOCKER: 'docker',
    runLabels: () => [],
    contentTag: (repo) => `${repo}:c-x`,
    removeRun: async () => {},
    op: async (args) => {
      calls.push(args.join(' '));
      if (args[0] === 'volume' && args[1] === 'inspect') return { ok: exists, status: exists ? 0 : 1, stdout: '', stderr: '' };
      if (args[0] === 'volume' && args[1] === 'create') { exists = true; return { ok: true, status: 0, stdout: '', stderr: '' }; }
      if (args[0] === 'run' && args.includes('chown')) {
        // Like Docker: a local-only tag that is not built yet cannot run.
        if (!imageBuilt) return { ok: false, status: 125, stdout: '', stderr: 'Unable to find image qb-sandbox-agent:c-x locally' };
        return chownFails ? { ok: false, status: 1, stdout: '', stderr: 'chown: permission denied' } : { ok: true, status: 0, stdout: '', stderr: '' };
      }
      return { ok: true, status: 0, stdout: '', stderr: '' };
    },
  };
  const agent = { AGENT_IMAGE: 'qb-sandbox-agent:c-x', AGENT_ENV: [], ensureAgentImage: async () => { calls.push('build agent image'); imageBuilt = true; } };
  const egress = { POLICIES: { AUTH: ['claude.ai'] }, startEgress: async () => ({ mount: () => [], stop: async () => {} }) };
  const realProc = require('../../lib/proc');
  // Only the interactive sign-in is faked; other proc use (e.g. the auth lock's process identity) is real.
  const proc = { ...realProc, run: (cmd, args, o) => {
    if (cmd === 'docker' && args.includes('-it')) { calls.push('interactive login'); return { status: 0 }; }
    return realProc.run(cmd, args, o);
  } };
  const stubs = { [path.join(SB, 'docker.js')]: docker, [path.join(SB, 'agent.js')]: agent, [path.join(SB, 'egress.js')]: egress, [path.join(SB, '..', 'proc.js')]: proc };
  const saved = {};
  for (const [p, exports] of Object.entries(stubs)) { saved[p] = require.cache[p]; require.cache[p] = { id: p, filename: p, loaded: true, exports }; }
  const authPath = path.join(SB, 'auth.js'); const wsPath = path.join(SB, 'workspace.js');
  delete require.cache[authPath]; delete require.cache[wsPath];
  const A = require(authPath);
  const restore = () => {
    for (const p of Object.keys(stubs)) { if (saved[p]) require.cache[p] = saved[p]; else delete require.cache[p]; }
    delete require.cache[authPath]; delete require.cache[wsPath];
  };
  return { A, calls, restore };
}
const stateDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-authvol-'));

describe('QB-31: the login volume is writable by the login container', () => {
  test('fresh machine: the agent image is built BEFORE the volume is handed to uid 10001, and the chown succeeds', async () => {
    const { A, calls, restore } = loadAuth();
    try {
      await A.login(stateDir());
      const build = calls.indexOf('build agent image');
      const chown = calls.findIndex((c) => c.includes('chown 10001:10001'));
      assert.ok(build >= 0 && chown > build, `build before chown: ${JSON.stringify(calls)}`);
      assert.ok(calls.indexOf('interactive login') > chown, `the login runs only after the volume is prepared: ${JSON.stringify(calls)}`);
    } finally { restore(); }
  });

  test('an existing volume (e.g. left root-owned by the old order) is repaired on the next login (pre-fix: chown skipped)', async () => {
    const { A, calls, restore } = loadAuth({ volumeExists: true });
    try {
      await A.login(stateDir());
      assert.ok(calls.some((c) => c.includes('chown 10001:10001')), JSON.stringify(calls));
    } finally { restore(); }
  });

  test('a failed chown stops the login with the reason (pre-fix: ignored, then "Login successful" stored nothing)', async () => {
    const { A, calls, restore } = loadAuth({ chownFails: true });
    try {
      await assert.rejects(A.login(stateDir()), /could not prepare the QB login volume.*permission denied/);
      assert.ok(!calls.includes('interactive login'), 'no sign-in into a volume it cannot write');
    } finally { restore(); }
  });
});
