/**
 * Phase 5 re-review regressions (QB-32, QB-33, QB-35), real worker on a real SQLite D1 (Node 22+):
 *   QB-33  no enumeration under repeated requests; a hard, streaming body limit
 *   QB-32  deletion vs an already-authorized upload, in both orders; partial DB failure
 *   QB-35  DB failure between registration and enqueue; retry; legacy repair; concurrency
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const metric = () => ({ run_id: crypto.randomUUID(), passed: true, attempts: 1, duration_ms: 5, repair_count: 0, qb_version: '0.1.0' });
async function tokenEnv() {
  const w = await workerEnv();
  w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('u@example.com');
  await w.call('POST', '/api/telemetry/request', { body: { email: 'u@example.com' } });
  const code = w.emails.at(-1).body.html.match(/code=([0-9a-f]{64})/)[1];
  const token = (await w.call('GET', `/api/telemetry/verify?code=${code}`)).json.token;
  return { w, token, auth: { Authorization: `Bearer ${token}` } };
}
const count = (w, table, where = '') => w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get().n;

describe('QB-33 re-review: no enumeration, hard body limit', { skip: SKIP }, () => {
  test('repeated link requests get the same answers for registered and unregistered addresses (pre-fix: [202,202,202,429] vs [202,202,202,202])', async () => {
    const w = await workerEnv();
    w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('known@example.com');
    const seq = async (email) => { const out = []; for (let i = 0; i < 5; i++) out.push((await w.call('POST', '/api/telemetry/request', { body: { email } })).status); return out; };
    const known = await seq('known@example.com'); const unknown = await seq('unknown@example.com');
    assert.deepEqual(known, unknown);
    assert.deepEqual(known, [202, 202, 202, 429, 429]);
    assert.equal(w.emails.filter((e) => e.body.to === 'unknown@example.com').length, 0);
    assert.equal(count(w, 'telemetry_link_requests', "WHERE email_hash LIKE '%@%'"), 0, 'only hashes are stored');
  });

  test('a chunked body without Content-Length is cut off once over the limit (413) — the rest is never read', async () => {
    const w = await workerEnv();
    let pulled = 0; let cancelled = false;
    const chunk = new Uint8Array(1024).fill(32);   // 1 KiB of spaces per pull, up to 1 MiB
    const body = new ReadableStream({
      pull(ctl) { pulled++; if (pulled > 1024) ctl.close(); else ctl.enqueue(chunk); },
      cancel() { cancelled = true; },
    });
    const req = new Request('https://quaterback.velorallc.workers.dev/api/beta-access', { method: 'POST', body, duplex: 'half', headers: { 'Content-Type': 'application/json' } });
    assert.equal(req.headers.get('content-length'), null);
    const res = await w.worker.fetch(req, w.env);
    assert.equal(res.status, 413);
    assert.ok(pulled <= 4, `read ${pulled} KiB of a 1 MiB body before stopping (limit 2 KiB)`);
    assert.equal(cancelled, true, 'the stream was not cancelled');
    for (const p of ['/api/metrics', '/api/telemetry/request']) {
      let n = 0;
      const s2 = new ReadableStream({ pull(ctl) { n++; if (n > 1024) ctl.close(); else ctl.enqueue(chunk); } });
      const r2 = await w.worker.fetch(new Request(`https://quaterback.velorallc.workers.dev${p}`, { method: 'POST', body: s2, duplex: 'half', headers: { Authorization: `Bearer qbt_${'0'.repeat(64)}` } }), w.env);
      assert.ok([401, 413].includes(r2.status), `${p}: ${r2.status}`);
      assert.ok(n <= 8, `${p}: read ${n} KiB`);
    }
  });
});

describe('QB-32 re-review: deletion cannot be undone by an in-flight upload', { skip: SKIP }, () => {
  test('upload paused after authorization, delete completes, upload resumes → refused, and no metric survives (pre-fix: 200 and a row)', async () => {
    const { w, token, auth } = await tokenEnv();
    let release; let paused;
    const atInsert = new Promise((r) => { paused = r; });
    w.d1.before = async (sql) => { if (/INSERT INTO client_metrics/.test(sql)) { w.d1.before = null; paused(); await new Promise((r) => { release = r; }); } };
    const upload = w.call('POST', '/api/metrics', { body: metric(), headers: auth });
    await atInsert;
    const del = await w.call('POST', '/api/telemetry/delete', { headers: auth });
    assert.deepEqual([del.status, del.json.token_revoked], [200, true]);
    release();
    const up = await upload;
    assert.equal(up.status, 401);
    assert.equal(count(w, 'client_metrics'), 0, 'a metric survived the deletion');
    assert.equal((await w.call('POST', '/api/metrics', { body: metric(), headers: auth })).status, 401, 'insertable after deletion');
    void token;
  });

  test('the other order: an upload that inserted before the deletion is deleted by it', async () => {
    const { w, auth } = await tokenEnv();
    for (let i = 0; i < 3; i++) assert.equal((await w.call('POST', '/api/metrics', { body: metric(), headers: auth })).status, 200);
    const del = await w.call('POST', '/api/telemetry/delete', { headers: auth });
    assert.equal(del.json.deleted_metrics, 3);
    assert.equal(count(w, 'client_metrics'), 0);
  });

  test('concurrent revoke and upload: whatever the interleaving, nothing stays after revocation+deletion', async () => {
    for (let round = 0; round < 5; round++) {
      const { w, auth } = await tokenEnv();
      const uploads = Array.from({ length: 6 }, () => w.call('POST', '/api/metrics', { body: metric(), headers: auth }));
      const del = w.call('POST', '/api/telemetry/delete', { headers: auth });
      await Promise.all([...uploads, del]);
      await w.call('POST', '/api/telemetry/delete', { headers: auth });   // token already revoked → 401, harmless
      assert.equal(count(w, 'client_metrics'), 0, `round ${round}`);
    }
  });

  test('a partial database failure inside deletion applies neither step (no revoked-but-kept state); a retry succeeds', async () => {
    const { w, auth } = await tokenEnv();
    await w.call('POST', '/api/metrics', { body: metric(), headers: auth });
    w.d1.faults.push({ match: /DELETE FROM client_metrics WHERE token_id/ });
    const failed = await w.call('POST', '/api/telemetry/delete', { headers: auth });
    assert.equal(failed.status, 500);
    assert.equal(count(w, 'telemetry_tokens', 'WHERE revoked_at IS NOT NULL'), 0, 'revoked although the deletion failed');
    assert.equal(count(w, 'client_metrics'), 1);
    const retry = await w.call('POST', '/api/telemetry/delete', { headers: auth });
    assert.deepEqual([retry.status, retry.json.deleted_metrics], [200, 1]);
    assert.equal(count(w, 'client_metrics'), 0);
  });
});

describe('QB-35 re-review: registration and delivery intents are atomic', { skip: SKIP }, () => {
  const post = (w, email) => w.call('POST', '/api/beta-access', { body: { email }, headers: { 'CF-Connecting-IP': '203.0.113.9' } });
  for (const [label, match] of [['before either enqueue', /INSERT INTO email_deliveries[\s\S]*welcome|VALUES \(\?, \?, \?, \?, 'pending'/], ['between the two enqueues', null]]) {
    test(`a DB failure ${label} leaves no registration; a retry registers and sends each email once (pre-fix: registered forever without jobs)`, async () => {
      const w = await workerEnv();
      // fault on the 1st (welcome) or the 2nd (owner) enqueue statement
      let seen = 0;
      w.d1.faults.push({ match: { test: (sql) => /INSERT INTO email_deliveries/.test(sql) && (++seen === (match ? 1 : 2)) }, times: 1 });
      const r1 = await post(w, 'new@example.com');
      assert.equal(r1.status, 500);
      assert.equal(count(w, 'submissions'), 0, 'registration survived a failed enqueue');
      assert.equal(count(w, 'email_deliveries'), 0);
      const r2 = await post(w, 'new@example.com');
      assert.deepEqual([r2.status, r2.json.registered, r2.json.duplicate], [200, true, undefined]);
      await w.scheduled();
      assert.deepEqual(w.db.prepare('SELECT kind, status FROM email_deliveries ORDER BY kind').all().map((d) => [d.kind, d.status]), [['owner_notify', 'sent'], ['welcome', 'sent']]);
      assert.equal(w.emails.filter((e) => e.body.to === 'new@example.com').length, 1);
    });
  }

  test('a registration missing its jobs (older worker / crash) is repaired by a retry, without re-sending completed jobs', async () => {
    const w = await workerEnv();
    w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('legacy@example.com');            // no jobs
    const r = await post(w, 'legacy@example.com');
    assert.equal(r.json.duplicate, true);
    assert.equal(w.emails.filter((e) => e.body.to === 'legacy@example.com').length, 1, 'the missing welcome was not repaired');
    await post(w, 'legacy@example.com'); await w.scheduled();
    assert.equal(w.emails.filter((e) => e.body.to === 'legacy@example.com').length, 1, 'a completed job was re-sent');
  });

  test('concurrent duplicates with a transient enqueue failure still end with one row and one welcome', async () => {
    const w = await workerEnv();
    w.d1.faults.push({ match: /INSERT INTO email_deliveries/, times: 1 });
    const rs = await Promise.all([1, 2, 3, 4].map(() => post(w, 'race@example.com')));
    assert.ok(rs.some((r) => r.status === 200));
    await w.scheduled();
    assert.equal(count(w, 'submissions'), 1);
    assert.equal(w.emails.filter((e) => e.body.to === 'race@example.com' && e.status === 200).length, 1);
  });
});
