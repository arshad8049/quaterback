/**
 * Run the real Cloudflare Worker (landing_page/_worker.js) in Node for tests:
 *   - D1 is a real SQLite database (node:sqlite, Node 22+) loaded with landing_page/schema.sql;
 *   - outbound email (Resend) is captured, never sent;
 *   - ASSETS is a stub.
 * The worker is ESM; it is loaded from a temporary .mjs copy.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { /* Node < 22 */ }
const AVAILABLE = Boolean(sqlite && sqlite.DatabaseSync);
const SKIP = AVAILABLE ? false : `node:sqlite unavailable on node ${process.version} (CI runs Node 22/24)`;

function fakeD1(sql) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(sql);
  return {
    _db: db,
    prepare(text) {
      const st = db.prepare(text);
      let args = [];
      const api = {
        bind(...a) { args = a; return api; },
        async first() { const r = st.get(...args); return r === undefined ? null : { ...r }; },
        async all() { return { results: st.all(...args).map((r) => ({ ...r })) }; },
        async run() { const r = st.run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
      return api;
    },
  };
}

async function loadWorker(file = path.join(__dirname, '../../landing_page/_worker.js')) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-worker-'));
  const copy = path.join(dir, 'worker.mjs');
  fs.copyFileSync(file, copy);
  return (await import(pathToFileURL(copy).href)).default;
}

/** A worker environment: { env, emails, call(method, path, { body, headers, raw }) }. */
async function workerEnv({ schema = fs.readFileSync(path.join(__dirname, '../../landing_page/schema.sql'), 'utf8'), env: extra = {}, file } = {}) {
  const worker = await loadWorker(file);
  const emails = [];
  // QB-35: tests can make the email provider fail (status per call) and run the cron handler
  const control = { emailStatus: () => 200 };
  const env = { DB: fakeD1(schema), RESEND_API_KEY: 're_test_key', ADMIN_SECRET: 'admin-secret-for-tests',
    ASSETS: { fetch: async () => new Response('asset', { status: 200 }) }, ...extra };
  const realFetch = globalThis.fetch;
  const stubFetch = async (url, init) => {
    const status = control.emailStatus(emails.length);
    emails.push({ url: String(url), body: JSON.parse(init.body), headers: { ...(init.headers || {}) }, status });
    return new Response(status === 200 ? '{"id":"e"}' : '{"message":"provider error"}', { status });
  };
  async function scheduled() {
    globalThis.fetch = stubFetch;
    try { await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, { waitUntil() {} }); } finally { globalThis.fetch = realFetch; }
  }
  async function call(method, p, { body, headers = {}, raw } = {}) {
    globalThis.fetch = stubFetch;
    try {
      const init = { method, headers: { ...headers } };
      if (raw !== undefined) init.body = raw;
      else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
      const res = await worker.fetch(new Request(`https://quaterback.velorallc.workers.dev${p}`, init), env);
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, headers: res.headers, text, json };
    } finally { globalThis.fetch = realFetch; }
  }
  return { env, emails, call, scheduled, control, db: env.DB._db };
}

module.exports = { workerEnv, fakeD1, loadWorker, SKIP, AVAILABLE };
