/**
 * QB-35: signup input, delivery and abuse handling (the real worker on a real SQLite D1, Node 22+).
 *   - null / wrongly typed / oversized / unknown-field bodies get defined 400/413 responses
 *     (pre-fix: null threw before validation);
 *   - concurrent duplicate submissions create one registration and one welcome email;
 *   - registration is tracked separately from delivery: a mocked email-service failure leaves
 *     the signup registered, says the email is pending, records the failure, and the cron
 *     retry delivers it once — no duplicate signup, no repeated welcome;
 *   - per-IP rate limit.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const post = (w, body, extra = {}) => w.call('POST', '/api/beta-access', { body, headers: { 'CF-Connecting-IP': extra.ip || '203.0.113.7' }, ...(extra.raw !== undefined ? { raw: extra.raw, body: undefined } : {}) });
const welcomes = (w, to) => w.emails.filter((e) => e.body.to === to && /beta list/.test(e.body.subject));
const ADMIN = { Authorization: 'Bearer admin-secret-for-tests' };

describe('QB-35: defined responses for bad input', { skip: SKIP }, () => {
  test('null, arrays, numbers, wrong types, unknown fields and oversized bodies are 400/413, never a crash (pre-fix: null threw)', async () => {
    const w = await workerEnv();
    for (const raw of ['null', '[]', '42', '"x"', '{bad json', '']) {
      const r = await post(w, undefined, { raw });
      assert.equal(r.status, 400, `${raw} → ${r.status} ${r.text}`);
    }
    for (const body of [{ email: 12345 }, { email: null }, { email: ['a@b.co'] }, { email: 'not-an-email' }, { email: `${'a'.repeat(250)}@x.co` },
      { email: 'a@b.co', agent: 42 }, { email: 'a@b.co', agent: 'x'.repeat(81) }, { email: 'a@b.co', agent: 'bad\u0000agent' }, { email: 'a@b.co', admin: true }]) {
      const r = await post(w, body);
      assert.equal(r.status, 400, `${JSON.stringify(body).slice(0, 60)} → ${r.status} ${r.text}`);
    }
    const big = await post(w, undefined, { raw: JSON.stringify({ email: 'a@b.co', agent: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 0);
  });
});

describe('QB-35: atomic registration', { skip: SKIP }, () => {
  test('concurrent duplicate submissions create one row and one welcome email (pre-fix: select-then-insert raced)', async () => {
    const w = await workerEnv();
    const rs = await Promise.all([1, 2, 3, 4].map(() => post(w, { email: 'Same@Example.com', agent: 'Claude Code' })));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
    assert.equal(rs.filter((r) => !r.json.duplicate).length, 1);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1);
    assert.equal(welcomes(w, 'same@example.com').length, 1);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE kind = 'welcome'").get().n, 1);
  });
});

describe('QB-35: registration is separate from delivery', { skip: SKIP }, () => {
  test('a failed email service: registered, the response says pending, the failure is observable; the retry delivers exactly once', async () => {
    const w = await workerEnv();
    w.control.emailStatus = () => 500;
    const r = await post(w, { email: 'user@example.com' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.registered, r.json.welcome_email], [true, 'pending_retry'], 'pre-fix: reported plain success');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1);
    const failed = w.db.prepare("SELECT kind, status, attempts, last_error FROM email_deliveries ORDER BY kind").all();
    assert.deepEqual(failed.map((d) => [d.kind, d.status, d.attempts]), [['owner_notify', 'failed', 1], ['welcome', 'failed', 1]]);
    assert.match(failed[1].last_error, /provider HTTP 500/);
    const rep = (await w.call('GET', '/api/report', { headers: ADMIN })).json;
    assert.ok(rep.email_deliveries.recent_failures.some((f) => f.kind === 'welcome' && f.status === 'failed'));

    // the service recovers; the cron retry (once due) delivers each email once
    w.control.emailStatus = () => 200;
    w.db.prepare("UPDATE email_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
    await w.scheduled();
    await w.scheduled();
    assert.deepEqual(w.db.prepare('SELECT status FROM email_deliveries ORDER BY kind').all().map((d) => d.status), ['sent', 'sent']);
    const sentWelcomes = welcomes(w, 'user@example.com').filter((e) => e.status === 200);
    assert.equal(sentWelcomes.length, 1, 'the welcome email was repeated');
    for (const e of w.emails) assert.match(e.headers['Idempotency-Key'], /^(welcome|owner-notify):user@example\.com$/);
    // signing up again changes nothing
    const again = await post(w, { email: 'user@example.com' });
    assert.equal(again.json.duplicate, true);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n, 1);
    assert.equal(welcomes(w, 'user@example.com').filter((e) => e.status === 200).length, 1);
  });

  test('repeated failures stop at a visible dead state; a send interrupted mid-flight is retried', async () => {
    const w = await workerEnv();
    w.control.emailStatus = () => 503;
    await post(w, { email: 'user@example.com' });
    for (let i = 0; i < 8; i++) { w.db.prepare("UPDATE email_deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE status = 'failed'").run(); await w.scheduled(); }
    assert.deepEqual(w.db.prepare('SELECT DISTINCT status, attempts FROM email_deliveries').all().map((d) => [d.status, d.attempts]), [['dead', 6]]);
    const w2 = await workerEnv();
    await post(w2, { email: 'x@example.com' });
    w2.db.prepare("UPDATE email_deliveries SET status = 'sending', claimed_at = '2000-01-01T00:00:00.000Z', next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE kind = 'welcome'").run();
    await w2.scheduled();
    assert.equal(w2.db.prepare("SELECT status FROM email_deliveries WHERE kind = 'welcome'").get().status, 'sent');
  });
});

describe('QB-35: abuse controls', { skip: SKIP }, () => {
  test('more than 10 attempts per IP per hour are refused (429); the IP is stored only as a hash in the limiter', async () => {
    const w = await workerEnv();
    for (let i = 0; i < 10; i++) assert.equal((await post(w, { email: `u${i}@example.com` }, { ip: '198.51.100.9' })).status, 200);
    assert.equal((await post(w, { email: 'u10@example.com' }, { ip: '198.51.100.9' })).status, 429);
    assert.equal((await post(w, { email: 'other@example.com' }, { ip: '198.51.100.10' })).status, 200);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM signup_attempts WHERE ip_hash LIKE '%198.51%'").get().n, 0);
  });
});
