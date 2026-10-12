/**
 * QB-32: telemetry and privacy descriptions match the observed data flows.
 *   - no public text claims source never leaves the machine or that telemetry is anonymous;
 *     the Claude Code → Anthropic flow is stated;
 *   - telemetry is off by default, its exact payload is previewable without sending, and it
 *     carries no email, task text or task-derived hash;
 *   - a token holder can delete everything they sent; retention is enforced.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { makeRepo } = require('../helpers/tmprepo');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const text = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('QB-32: public descriptions match the data flows', () => {
  test('no page or email claims the source never leaves the machine, or that metrics are anonymous (pre-fix: both did)', () => {
    for (const f of ['landing_page/privacy.html', 'landing_page/index.html', 'landing_page/src/beta-cta.html', 'landing_page/src/positioning.html', 'landing_page/_worker.js']) {
      const t = text(read(f));
      assert.doesNotMatch(t, /source (code )?(never leaves|stays on) your machine|never leaves your machine|Anonymi[sz]ed metrics|anonymous run metrics|Everything runs locally/i, f);
    }
  });
  test('the privacy page states the Anthropic agent path, local artifacts, the telemetry payload, that it is not anonymous, deletion and retention', () => {
    const t = text(read('landing_page/privacy.html'));
    assert.match(t, /Claude Code .* sent to Anthropic/);
    assert.match(t, /~\/\.qb\/runs/);
    assert.match(t, /not anonymous/);
    assert.match(t, /--telemetry-dry-run/);
    assert.match(t, /POST \/api\/telemetry\/delete/);
    assert.match(t, /180 days/);
    assert.match(read('docs/privacy/data-flows.md'), /\| Coding agent \(`--agent claude-code`\) \| Anthropic/);
  });
});

describe('QB-32: telemetry consent shows the actual payload', () => {
  const runQb = (args, env = {}) => {
    const r = makeRepo({ 'src/utils.js': 'module.exports = {};\n' });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb32-'));
    const log = path.join(tmp, 'fetch.log');
    try {
      const res = spawnSync(process.execPath, ['--require', path.join(ROOT, 'test/helpers/preload-ollama.js'), path.join(ROOT, 'qb.js'),
        'Add a clamp function to src/utils.js', '--repo', r.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', ...args],
      { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: '', QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'),
        QB_TEST_FETCH_LOG: log, QB_TEST_OLLAMA_REPLY: JSON.stringify({ goal: 'Add a clamp function', required_behavior: ['clamp'], acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp exported', requirement_ids: ['R-1'] }],
          requirements: [{ id: 'R-1', quote: 'Add a clamp function to src/utils.js' }], verification_plan: ['x'], clarifying_question: null }), ...env } });
      return { out: res.stdout + res.stderr, fetched: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
    } finally { r.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  };
  test('--telemetry-dry-run prints the exact payload and sends nothing; it holds no email, task text or task hash', () => {
    const { out, fetched } = runQb(['--telemetry-dry-run'], { QB_TELEMETRY_TOKEN: `qbt_${'a'.repeat(64)}` });
    assert.doesNotMatch(fetched, /api\/metrics/);
    const m = /Telemetry dry run — nothing sent\. .*\n\s*(\{.*\})/.exec(out);
    assert.ok(m, out);
    const payload = JSON.parse(m[1]);
    assert.deepEqual(Object.keys(payload).sort(), ['attempts', 'duration_ms', 'layers_used', 'passed', 'qb_version', 'repair_count', 'run_id']);
    assert.match(payload.run_id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(m[1], /clamp|@|task_hash/i);
  });
  test('telemetry is off by default: an ordinary run sends nothing to the metrics endpoint', () => {
    const { fetched } = runQb([], { QB_TELEMETRY_TOKEN: `qbt_${'a'.repeat(64)}` });
    assert.doesNotMatch(fetched, /api\/metrics/);
  });
});

describe('QB-32: deletion and retention', { skip: SKIP }, () => {
  async function withToken() {
    const w = await workerEnv();
    w.db.prepare('INSERT INTO submissions (email) VALUES (?)').run('u@example.com');
    await w.call('POST', '/api/telemetry/request', { body: { email: 'u@example.com' } });
    const code = w.emails.at(-1).body.html.match(/code=([0-9a-f]{64})/)[1];
    const token = (await w.call('GET', `/api/telemetry/verify?code=${code}`)).json.token;
    return { w, token };
  }
  const metric = () => ({ run_id: crypto.randomUUID(), passed: true, attempts: 1, duration_ms: 10, repair_count: 0, qb_version: '0.1.0' });
  test('a token holder deletes every record sent with it (and the token is revoked); other users\' records stay', async () => {
    const a = await withToken();
    for (let i = 0; i < 3; i++) await a.w.call('POST', '/api/metrics', { body: metric(), headers: { Authorization: `Bearer ${a.token}` } });
    a.w.db.prepare("INSERT INTO telemetry_tokens (token_hash, email, scope, created_at) VALUES ('x', 'other@example.com', 'metrics:write', '2026-01-01')").run();
    const otherId = a.w.db.prepare("SELECT id FROM telemetry_tokens WHERE email = 'other@example.com'").get().id;
    a.w.db.prepare("INSERT INTO client_metrics (run_id, token_id, passed, attempts, duration_ms, repair_count, qb_version, created_at) VALUES ('11111111-1111-1111-1111-111111111111', ?, 1, 1, 1, 0, '0.1.0', '2026-10-08T00:00:00Z')").run(otherId);
    const del = await a.w.call('POST', '/api/telemetry/delete', { headers: { Authorization: `Bearer ${a.token}` } });
    assert.deepEqual([del.status, del.json.deleted_metrics, del.json.token_revoked], [200, 3, true]);
    assert.equal(a.w.db.prepare('SELECT COUNT(*) AS n FROM client_metrics').get().n, 1);
    assert.equal((await a.w.call('POST', '/api/metrics', { body: metric(), headers: { Authorization: `Bearer ${a.token}` } })).status, 401);
    assert.equal((await a.w.call('POST', '/api/telemetry/delete', {})).status, 401);
  });
  test('the cron handler enforces retention (metrics 180 d, codes 7 d, abuse rows 2 d, delivered emails 30 d)', async () => {
    const { w, token } = await withToken();
    await w.call('POST', '/api/metrics', { body: metric(), headers: { Authorization: `Bearer ${token}` } });
    w.db.prepare("UPDATE client_metrics SET created_at = '2000-01-01T00:00:00.000Z'").run();
    await w.call('POST', '/api/metrics', { body: metric(), headers: { Authorization: `Bearer ${token}` } });
    w.db.prepare("UPDATE telemetry_verifications SET created_at = '2000-01-01T00:00:00.000Z'").run();
    w.db.prepare("INSERT INTO signup_attempts (ip_hash, created_at) VALUES ('h', '2000-01-01T00:00:00.000Z'), ('h', ?)").run(new Date().toISOString());
    w.db.prepare("INSERT INTO email_deliveries (idempotency_key, kind, recipient, status, created_at, next_attempt_at) VALUES ('old', 'welcome', 'x', 'sent', '2000-01-01T00:00:00.000Z', '2000-01-01T00:00:00.000Z')").run();
    await w.scheduled();
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM client_metrics').get().n, 1);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM telemetry_verifications').get().n, 0);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM signup_attempts').get().n, 1);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM email_deliveries WHERE idempotency_key = 'old'").get().n, 0);
  });
});
