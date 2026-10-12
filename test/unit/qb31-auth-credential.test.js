/**
 * QB-31 walkthrough attempt 2 (owner, Codespaces, main bac5956): `qb auth login` exited 0 and
 * `qb auth status` said "logged in (expiry unknown)", but the QB login volume held no credential:
 * both demo runs then ended BLOCKED auth_refresh_failed "Not logged in · Please run /login".
 * Presence of the volume is not a sign-in. A stored credential (it has an expiry) is the minimum;
 * login fails if none was stored, and status / doctor report "not signed in" without one.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { auth } = require('../../lib/sandbox/cli');

async function capture(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (s) => { out += s; return true; };
  try { return { code: await fn(), out }; } finally { process.stderr.write = orig; }
}
const fakeAuth = (over = {}) => ({
  login: async () => ({ status: 0 }),
  authVolumeExists: async () => true,
  storedCredentialExpiry: async () => Date.now() + 3600_000,
  ...over,
});

describe('QB-31: a sign-in means a stored credential', () => {
  test('login: the official binary exits 0 but stores nothing → exit 1, saying so (pre-fix: 0)', async () => {
    const r = await capture(() => auth('login', { A: fakeAuth({ storedCredentialExpiry: async () => null }) }));
    assert.equal(r.code, 1);
    assert.match(r.out, /sign-in did not complete: no credential was stored/);
  });
  test('login: a stored credential → exit 0, with its expiry', async () => {
    const r = await capture(() => auth('login', { A: fakeAuth() }));
    assert.equal(r.code, 0);
    assert.match(r.out, /signed in; access token expires 20\d\d-/);
  });
  test('login: the binary itself failing → exit 1 (unchanged)', async () => {
    assert.equal((await capture(() => auth('login', { A: fakeAuth({ login: async () => ({ status: 1 }) }) }))).code, 1);
  });
  test('status: a volume without a credential → not signed in, exit 1 (pre-fix: "logged in (expiry unknown)", 0)', async () => {
    const r = await capture(() => auth('status', { A: fakeAuth({ storedCredentialExpiry: async () => null }) }));
    assert.equal(r.code, 1);
    assert.match(r.out, /not signed in: the QB login holds no stored credential/);
    assert.doesNotMatch(r.out, /logged in \(expiry unknown\)/);
  });
  test('status: no volume → not signed in, exit 1; a credential → signed in with its expiry, exit 0', async () => {
    assert.equal((await capture(() => auth('status', { A: fakeAuth({ authVolumeExists: async () => false }) }))).code, 1);
    const ok = await capture(() => auth('status', { A: fakeAuth() }));
    assert.equal(ok.code, 0);
    assert.match(ok.out, /signed in; access token expires/);
  });
  test('doctor: its real sign-in probe asks for a stored credential, not just the volume', async () => {
    const authPath = require.resolve('../../lib/sandbox/auth');
    const saved = require.cache[authPath];
    require.cache[authPath] = { id: authPath, filename: authPath, loaded: true,
      exports: { authVolumeExists: async () => true, storedCredentialExpiry: async () => null } };
    try {
      const { defaultDeps } = require('../../lib/doctor');
      assert.equal(await defaultDeps().authVolumeExists(), false, 'a volume with no credential is not a sign-in');
    } finally { if (saved) require.cache[authPath] = saved; else delete require.cache[authPath]; }
  });
});
