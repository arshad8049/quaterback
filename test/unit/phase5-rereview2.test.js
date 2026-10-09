/**
 * Phase 5 re-review 2 regressions (QB-33, QB-35), real worker on a real SQLite D1 (Node 22+):
 *   QB-33  quota admission is atomic with its write: two concurrent requests at the limit
 *          admit exactly one (metrics, telemetry-link requests, signups)
 *   QB-35  delivery completion outlives retention: a repeat signup after the sent rows (or the
 *          migration's legacy markers) expired never sends a second welcome
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const count = (w, table, where = '', ...args) => w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args).n;
const metric = () => ({ run_id: crypto.randomUUID(), passed: true, attempts: 1, duration_ms: 5, repair_count: 0, qb_version: '0.1.0' });
const MIGRATIONS = path.join(__dirname, '../../landing_page/migrations');

/**
 * Pause every statement matching `re` until `n` calls are waiting there, then let them all go
 * at once: each has passed whatever check came before that statement.
 */
function holdUntil(w, re, n = 2) {
  let waiting = 0; let release; const gate = new Promise((r) => { release = r; });
  w.d1.before = async (sql) => {
    if (!re.test(sql)) return;
    if (++waiting === n) { w.d1.before = null; release(); }
    await gate;
  };
}

async function tokenEnv() {
  const w = await workerEnv();
  w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('u@example.com');
  await w.call('POST', '/api/telemetry/request', { body: { email: 'u@example.com' } });
  const code = w.emails.at(-1).body.html.match(/code=([0-9a-f]{64})/)[1];
  const token = (await w.call('GET', `/api/telemetry/verify?code=${code}`)).json.token;
  const tokenId = w.db.prepare('SELECT id FROM telemetry_tokens').get().id;
  return { w, tokenId, auth: { Authorization: `Bearer ${token}` } };
}

describe('QB-33 re-review 2: concurrent requests cannot exceed a quota', { skip: SKIP }, () => {
  test('metrics: 59 in the hour + 2 concurrent uploads → exactly one 200 and one 429, 60 rows (pre-fix: both 200, 61 rows)', async () => {
    const { w, tokenId, auth } = await tokenEnv();
    const ins = w.db.prepare(`INSERT INTO client_metrics (run_id, token_id, passed, attempts, duration_ms, repair_count, qb_version, source, created_at)
      VALUES (?, ?, 1, 1, 5, 0, '0.1.0', 'client_reported', ?)`);
    for (let i = 0; i < 59; i++) ins.run(crypto.randomUUID(), tokenId, now());
    holdUntil(w, /INSERT INTO client_metrics/);
    const rs = await Promise.all([1, 2].map(() => w.call('POST', '/api/metrics', { body: metric(), headers: auth })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429]);
    assert.equal(count(w, 'client_metrics'), 60);
  });

  test('metrics: a revoked token is still 401, not 429, whatever the quota', async () => {
    const { w, auth } = await tokenEnv();
    await w.call('POST', '/api/telemetry/revoke', { headers: auth });
    assert.equal((await w.call('POST', '/api/metrics', { body: metric(), headers: auth })).status, 401);
  });

  test('telemetry-link requests: 2 in the hour + 2 concurrent → one 202 and one 429, 3 rows (pre-fix: 4)', async () => {
    const w = await workerEnv();
    const h = sha('qb-telemetry-request:x@example.com');
    for (let i = 0; i < 2; i++) w.db.prepare('INSERT INTO telemetry_link_requests (email_hash, created_at) VALUES (?, ?)').run(h, now());
    holdUntil(w, /INSERT INTO telemetry_link_requests/);
    const rs = await Promise.all([1, 2].map(() => w.call('POST', '/api/telemetry/request', { body: { email: 'x@example.com' } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [202, 429]);
    assert.equal(count(w, 'telemetry_link_requests'), 3);
  });

  test('signups: 9 attempts from an IP in the hour + 2 concurrent → one registered and one 429, 10 attempts (pre-fix: 11, both registered)', async () => {
    const w = await workerEnv();
    const ip = '203.0.113.7'; const h = sha(`qb-signup:${ip}`);
    for (let i = 0; i < 9; i++) w.db.prepare('INSERT INTO signup_attempts (ip_hash, created_at) VALUES (?, ?)').run(h, now());
    holdUntil(w, /INSERT INTO signup_attempts/);
    const rs = await Promise.all(['a@example.com', 'b@example.com'].map((email) => w.call('POST', '/api/beta-access', { body: { email }, headers: { 'CF-Connecting-IP': ip } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 429]);
    assert.equal(count(w, 'signup_attempts'), 10);
    assert.equal(count(w, 'submissions'), 1);
  });
});

describe('QB-35 re-review 2: delivery completion outlives retention', { skip: SKIP }, () => {
  const post = (w, email) => w.call('POST', '/api/beta-access', { body: { email }, headers: { 'CF-Connecting-IP': '198.51.100.4' } });
  const welcomes = (w, email) => w.emails.filter((e) => e.body.to === email && e.status === 200).length;
  const ownerNotices = (w, email) => w.emails.filter((e) => e.body.to !== email && JSON.stringify(e.body).includes(email) && e.status === 200).length;
  const expireDeliveries = (w) => w.db.prepare("UPDATE email_deliveries SET created_at = '2000-01-01T00:00:00.000Z'").run();

  test('register, let retention remove the sent rows, register again → no second welcome or owner notice (pre-fix: 2 welcomes)', async () => {
    const w = await workerEnv();
    await post(w, 'u@example.com');
    assert.deepEqual([welcomes(w, 'u@example.com'), ownerNotices(w, 'u@example.com')], [1, 1]);
    expireDeliveries(w);
    await w.scheduled();
    assert.equal(count(w, 'email_deliveries'), 0, 'retention removes the delivery rows (payload and log)');
    const again = await post(w, 'u@example.com');
    assert.deepEqual([again.status, again.json.duplicate], [200, true]);
    await w.scheduled();
    assert.deepEqual([welcomes(w, 'u@example.com'), ownerNotices(w, 'u@example.com')], [1, 1]);
  });

  test("the migration's legacy markers expiring does not re-send to a pre-tracking signup (pre-fix: a welcome)", async () => {
    const w = await workerEnv();
    w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('legacy@example.com');
    for (const f of fs.readdirSync(MIGRATIONS).filter((x) => x >= '0004').sort()) w.db.exec(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'));
    expireDeliveries(w);
    await w.scheduled();
    assert.equal(count(w, 'email_deliveries'), 0);
    await post(w, 'legacy@example.com');
    await w.scheduled();
    assert.equal(welcomes(w, 'legacy@example.com'), 0);
  });

  test('a never-enqueued registration is still repaired after retention ran (completed vs never enqueued)', async () => {
    const w = await workerEnv();
    await post(w, 'done@example.com');
    expireDeliveries(w); await w.scheduled();
    w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('missing@example.com');   // no jobs ever
    await post(w, 'missing@example.com');
    await post(w, 'done@example.com');
    await w.scheduled();
    assert.equal(welcomes(w, 'missing@example.com'), 1, 'the never-enqueued welcome was not repaired');
    assert.equal(welcomes(w, 'done@example.com'), 1, 'a completed welcome was re-sent');
  });

  test('the durable completion state holds no address, payload or log', async () => {
    const w = await workerEnv();
    await post(w, 'p@example.com');
    expireDeliveries(w); await w.scheduled();
    const rows = w.db.prepare('SELECT * FROM delivery_completions').all();
    assert.equal(rows.length, 2);
    assert.equal(JSON.stringify(rows).includes('@'), false);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['completed_at', 'key_hash', 'outcome']);
  });
});
