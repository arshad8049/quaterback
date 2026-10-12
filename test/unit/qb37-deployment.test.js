/**
 * QB-37: one canonical deployment, smoke-checked; public claims match the implementation.
 *   - Cloudflare Workers (wrangler.toml) is the only deployment path: no netlify.toml, no
 *     Pages functions, and server-only files are not served as assets;
 *   - scripts/smoke.js passes against a local staging of the real worker (real SQLite D1,
 *     mocked mail, static assets served with the same .assetsignore rules as Workers);
 * (Public-claim corrections are pending the site owner's decision and are not part of this change.)
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { workerEnv, SKIP } = require('../helpers/worker-harness');
const { smoke } = require('../../scripts/smoke');

const ROOT = path.join(__dirname, '..', '..');
const LP = path.join(ROOT, 'landing_page');

/** Workers static assets: files under landing_page/, minus .assetsignore entries. */
function assetsBinding() {
  const ignore = fs.readFileSync(path.join(LP, '.assetsignore'), 'utf8').split('\n').map((x) => x.trim()).filter(Boolean);
  return {
    async fetch(request) {
      let p = decodeURIComponent(new URL(request.url).pathname);
      if (p.endsWith('/')) p += 'index.html';
      const rel = p.replace(/^\/+/, '');
      if (ignore.some((g) => rel === g || rel.startsWith(`${g}/`)) || rel.split('/').includes('..')) return new Response('Not found', { status: 404 });
      const file = path.join(LP, rel);
      // Cloudflare's default html_handling: /page.html redirects to /page, and /page serves page.html.
      if (rel.endsWith('.html') && !rel.endsWith('index.html')) return new Response(null, { status: 307, headers: { location: `/${rel.slice(0, -5)}` } });
      const isFile = (f) => fs.existsSync(f) && fs.statSync(f).isFile();
      const served = isFile(file) ? file : (isFile(`${file}.html`) ? `${file}.html` : null);
      if (!served) return new Response('Not found', { status: 404 });
      return new Response(fs.readFileSync(served), { status: 200 });
    },
  };
}

/** A local "staging" deployment: the real worker behind a real HTTP server. */
async function staging() {
  const w = await workerEnv({ env: { ASSETS: assetsBinding() } });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const r = await w.call(req.method, req.url, { headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'content-length')), ...(body.length ? { raw: body.toString() } : {}) });
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(r.text);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return { w, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

describe('QB-37: one canonical deployment', () => {
  test('Cloudflare Workers is the only deployment path (pre-fix: netlify.toml and Pages functions coexisted)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'wrangler.toml')));
    assert.ok(!fs.existsSync(path.join(ROOT, 'netlify.toml')), 'netlify.toml still present');
    assert.ok(!fs.existsSync(path.join(LP, 'functions')), 'Pages functions still present');
    const w = fs.readFileSync(path.join(ROOT, 'wrangler.toml'), 'utf8');
    assert.match(w, /main\s*=\s*"landing_page\/_worker\.js"/);
    const ignore = fs.readFileSync(path.join(LP, '.assetsignore'), 'utf8');
    for (const f of ['_worker.js', 'wrangler.toml', 'schema.sql', 'migrations']) assert.match(ignore, new RegExp(`^${f.replace('.', '\\.')}$`, 'm'), f);
  });
});

describe('QB-37: deployment smoke checks against a local staging (real worker, mocked mail)', { skip: SKIP }, () => {
  test('every smoke check passes; no check creates data or sends email', async () => {
    const s = await staging();
    try {
      const r = await smoke(s.base);
      assert.ok(r.passed, r.results.filter((x) => !x.pass).map((x) => `${x.name} (${x.status ?? x.error})`).join('; '));
      assert.equal(s.w.emails.length, 0);
      for (const t of ['submissions', 'client_metrics', 'telemetry_tokens', 'telemetry_verifications', 'email_deliveries']) {
        assert.equal(s.w.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
      }
    } finally { s.close(); }
  });
  test('beyond smoke: signup → report → metrics routing works end to end on staging with mocked mail', async () => {
    const s = await staging();
    try {
      const post = (p, body, headers = {}) => fetch(`${s.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const su = await (await post('/api/beta-access', { email: 'stage@example.com' })).json();
      assert.deepEqual([su.registered, su.welcome_email], [true, 'sent']);
      await post('/api/telemetry/request', { email: 'stage@example.com' });
      const code = s.w.emails.at(-1).body.html.match(/code=([0-9a-f]{64})/)[1];
      const { token } = await (await fetch(`${s.base}/api/telemetry/verify?code=${code}`)).json();
      const m = await post('/api/metrics', { run_id: '22222222-2222-4222-8222-222222222222', passed: true, attempts: 1, duration_ms: 5, repair_count: 0, qb_version: '0.1.0' }, { Authorization: `Bearer ${token}` });
      assert.equal(m.status, 200);
      const rep = await (await fetch(`${s.base}/api/report`, { headers: { Authorization: 'Bearer admin-secret-for-tests' } })).json();
      assert.deepEqual([rep.signups.length, rep.client_reported.summary.total_runs], [1, 1]);
    } finally { s.close(); }
  });
});
