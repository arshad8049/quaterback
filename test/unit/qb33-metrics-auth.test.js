/**
 * QB-33: metrics cannot be forged with a known registration email.
 * The real worker runs against a real SQLite D1 (Node 22+; CI 22/24).
 *   - a registered email alone is 401, and nothing is stored (pre-fix: inserted);
 *   - a verified, revocable, scoped token is required; codes and tokens are stored hashed;
 *   - strict schema: string booleans, negative or out-of-range values, unknown fields → 400;
 *     oversized → 413; a duplicate run_id → 409; rate limit → 429;
 *   - a valid record keeps its exact declared types and is labelled client_reported.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const SKIPPED = { skip: SKIP };
const RUN = () => crypto.randomUUID();
const VALID = (over = {}) => ({ run_id: RUN(), passed: false, attempts: 2, duration_ms: 1234, repair_count: 1, layers_used: 'L1,L2,L3,L4,L5', qb_version: '0.1.0', ...over });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function registered(email = 'user@example.com') {
  const w = await workerEnv();
  w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run(email);
  return w;
}
/** Run the full verification flow and return a token. */
async function tokenFor(w, email = 'user@example.com') {
  const r = await w.call('POST', '/api/telemetry/request', { body: { email } });
  assert.equal(r.status, 202);
  const link = w.emails.at(-1).body.html.match(/https:\/\/[^"<\s]+verify\?code=([0-9a-f]{64})/);
  assert.ok(link, 'no verification link was emailed');
  const v = await w.call('GET', `/api/telemetry/verify?code=${link[1]}`);
  assert.equal(v.status, 200, v.text);
  return { token: v.json.token, code: link[1] };
}
const auth = (t) => ({ Authorization: `Bearer ${t}` });

describe('QB-33: an email is not a credential', SKIPPED, () => {
  test('a known registration email alone is refused (401) and stores nothing (pre-fix: 200 and a row)', async () => {
    const w = await registered();
    const r = await w.call('POST', '/api/metrics', { body: { email: 'user@example.com', passed: 'false', attempts: -3, duration_ms: -1 } });
    assert.equal(r.status, 401);
    const legacy = w.db.prepare('SELECT COUNT(*) AS n FROM metrics').get().n;
    const now = w.db.prepare('SELECT COUNT(*) AS n FROM client_metrics').get().n;
    assert.deepEqual([legacy, now], [0, 0]);
  });

  test('verification: the link is emailed only for a registered address, works once, and expires; only hashes are stored', async () => {
    const w = await registered();
    const unknown = await w.call('POST', '/api/telemetry/request', { body: { email: 'nobody@example.com' } });
    assert.equal(unknown.status, 202, 'same answer for unregistered emails (no enumeration)');
    assert.equal(w.emails.length, 0);
    const { token, code } = await tokenFor(w);
    assert.match(token, /^qbt_[0-9a-f]{64}$/);
    assert.equal((await w.call('GET', `/api/telemetry/verify?code=${code}`)).status, 400, 'a link works once');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM telemetry_tokens WHERE token_hash = ?').get(sha(token)).n, 1);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM telemetry_tokens WHERE token_hash = ?').get(token).n, 0, 'the raw token is stored');
    // expiry
    await w.call('POST', '/api/telemetry/request', { body: { email: 'user@example.com' } });
    const code2 = w.emails.at(-1).body.html.match(/code=([0-9a-f]{64})/)[1];
    w.db.prepare("UPDATE telemetry_verifications SET expires_at = '2000-01-01T00:00:00.000Z' WHERE code_hash = ?").run(sha(code2));
    assert.equal((await w.call('GET', `/api/telemetry/verify?code=${code2}`)).status, 400);
  });

  test('link requests are rate limited per email', async () => {
    const w = await registered();
    for (let i = 0; i < 3; i++) assert.equal((await w.call('POST', '/api/telemetry/request', { body: { email: 'user@example.com' } })).status, 202);
    assert.equal((await w.call('POST', '/api/telemetry/request', { body: { email: 'user@example.com' } })).status, 429);
  });

  test('a revoked, malformed or unknown token is refused', async () => {
    const w = await registered();
    const { token } = await tokenFor(w);
    assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: auth(token) })).status, 200);
    assert.equal((await w.call('POST', '/api/telemetry/revoke', { headers: auth(token) })).status, 200);
    assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: auth(token) })).status, 401);
    assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: auth(`qbt_${'0'.repeat(64)}`) })).status, 401);
    assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: { Authorization: 'user@example.com' } })).status, 401);
  });
});

describe('QB-33: strict metrics', SKIPPED, () => {
  test('string booleans, negative or out-of-range values, missing and unknown fields are rejected (pre-fix: "false" became passed=1)', async () => {
    const w = await registered();
    const { token } = await tokenFor(w);
    const bad = [
      { passed: 'false' }, { passed: 1 }, { attempts: -1 }, { attempts: 0 }, { attempts: 2.5 }, { attempts: '2' }, { attempts: 21 },
      { duration_ms: -1 }, { duration_ms: 1e12 }, { repair_count: -1 }, { repair_count: 2 }, { layers_used: 'L1,L1' }, { layers_used: 'L9' },
      { qb_version: '' }, { run_id: 'not-a-uuid' }, { email: 'user@example.com' }, { task_hash: 'abcd1234' },
    ];
    for (const over of bad) {
      const r = await w.call('POST', '/api/metrics', { body: VALID(over), headers: auth(token) });
      assert.equal(r.status, 400, `${JSON.stringify(over)} → ${r.status} ${r.text}`);
    }
    const { run_id, ...missing } = VALID(); void run_id;
    assert.equal((await w.call('POST', '/api/metrics', { body: missing, headers: auth(token) })).status, 400);
    for (const raw of ['[]', 'null', '"x"', '{not json']) assert.equal((await w.call('POST', '/api/metrics', { raw, headers: { ...auth(token), 'Content-Type': 'application/json' } })).status, 400, raw);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM client_metrics').get().n, 0);
  });

  test('an oversized payload is 413; a duplicate run_id is 409 (replay); the per-token hourly limit is 429', async () => {
    const w = await registered();
    const { token } = await tokenFor(w);
    const big = await w.call('POST', '/api/metrics', { raw: JSON.stringify({ ...VALID(), qb_version: 'x'.repeat(5000) }), headers: { ...auth(token), 'Content-Type': 'application/json' } });
    assert.equal(big.status, 413);
    const once = VALID();
    assert.equal((await w.call('POST', '/api/metrics', { body: once, headers: auth(token) })).status, 200);
    assert.equal((await w.call('POST', '/api/metrics', { body: once, headers: auth(token) })).status, 409);
    for (let i = 0; i < 59; i++) assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: auth(token) })).status, 200, `#${i}`);
    assert.equal((await w.call('POST', '/api/metrics', { body: VALID(), headers: auth(token) })).status, 429);
  });

  test('a valid record keeps its exact declared types and is labelled client_reported, in storage and in the admin report', async () => {
    const w = await registered();
    const { token } = await tokenFor(w);
    const a = VALID({ passed: false, attempts: 3, repair_count: 2 }); const b = VALID({ passed: true, attempts: 1, repair_count: 0 });
    for (const x of [a, b]) assert.equal((await w.call('POST', '/api/metrics', { body: x, headers: auth(token) })).json.source, 'client_reported');
    const rows = w.db.prepare('SELECT run_id, passed, attempts, duration_ms, repair_count, source FROM client_metrics ORDER BY attempts DESC').all();
    assert.deepEqual(rows.map((r) => [r.run_id, r.passed, r.attempts, r.repair_count, r.source]),
      [[a.run_id, 0, 3, 2, 'client_reported'], [b.run_id, 1, 1, 0, 'client_reported']]);
    const rep = await w.call('GET', '/api/report', { headers: { Authorization: 'Bearer admin-secret-for-tests' } });
    assert.match(rep.json.client_reported.label, /NOT independently verified/);
    assert.equal(rep.json.client_reported.summary.total_runs, 2);
  });
});

describe('QB-33: the client sends a token-authorized, strict payload', () => {
  test('sendMetrics sends nothing without a token, and sends the token as a bearer credential (no email)', async () => {
    const http = require('http');
    const { sendMetrics } = require('../../lib/telemetry');
    assert.deepEqual(await sendMetrics({ run_id: 'x' }, { url: 'http://127.0.0.1:9/never' }), { sent: false, reason: 'no_token' });
    let seen;
    const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { seen = { auth: req.headers.authorization, body: JSON.parse(b) }; res.end('{}'); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const r = await sendMetrics(VALID(), { url: `http://127.0.0.1:${server.address().port}/api/metrics`, token: `qbt_${'a'.repeat(64)}` });
      assert.deepEqual(r, { sent: true });
      assert.equal(seen.auth, `Bearer qbt_${'a'.repeat(64)}`);
      assert.ok(!('email' in seen.body) && !('task_hash' in seen.body));
    } finally { server.close(); }
  });
  test('qb.js no longer sends an email or a task hash as telemetry', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../../qb.js'), 'utf8');
    const block = src.slice(src.indexOf('const telemetryPayload = {'), src.indexOf('if (opts.telemetryDryRun)'));
    assert.doesNotMatch(block, /email|task_hash/);
    assert.match(block, /run_id:\s+run\.manifest\.run_id/);
    assert.match(src, /sendMetrics\(telemetryPayload, \{ token: telemetryToken \}\)/);
  });
});
