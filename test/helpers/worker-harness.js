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

/**
 * A D1-compatible facade over node:sqlite. `batch()` runs its statements in ONE transaction
 * (D1 semantics: all or nothing). Test controls (re-reviews):
 *   faults: [{ match: RegExp, times = 1 }] — throw 'injected D1 failure' when a statement matches
 *   before: async (sql) => {}               — awaited before every non-batch statement (to pause one)
 */
function fakeD1(sql) {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(sql);
  const control = { faults: [], before: null };
  const fault = (text) => {
    const f = control.faults.find((x) => x.match.test(text) && (x.times ?? 1) > 0);
    if (f) { f.times = (f.times ?? 1) - 1; throw new Error(`injected D1 failure: ${text.slice(0, 60)}`); }
  };
  const d1 = {
    _db: db,
    _control: control,
    prepare(text) {
      const st = db.prepare(text);
      let args = [];
      const exec = {
        first: () => { fault(text); const r = st.get(...args); return r === undefined ? null : { ...r }; },
        all: () => { fault(text); return { results: st.all(...args).map((r) => ({ ...r })) }; },
        run: () => { fault(text); const r = st.run(...args); return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
      };
      const api = {
        _exec: exec,
        bind(...a) { args = a; return api; },
        async first() { if (control.before) await control.before(text); return exec.first(); },
        async all() { if (control.before) await control.before(text); return exec.all(); },
        async run() { if (control.before) await control.before(text); return exec.run(); },
      };
      return api;
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => s._exec.run());
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
  return d1;
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
  // The email stub stays installed while ANY call is in flight (concurrent calls must not
  // restore the real fetch under each other).
  let active = 0;
  const enter = () => { if (active++ === 0) globalThis.fetch = stubFetch; };
  const leave = () => { if (--active === 0) globalThis.fetch = realFetch; };
  async function scheduled() {
    enter();
    try { await worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, { waitUntil() {} }); } finally { leave(); }
  }
  async function call(method, p, { body, headers = {}, raw } = {}) {
    enter();
    try {
      const init = { method, headers: { ...headers } };
      if (raw !== undefined) init.body = raw;
      else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
      let res;
      // an uncaught exception in the worker is a 500 on Cloudflare
      try { res = await worker.fetch(new Request(`https://quaterback.velorallc.workers.dev${p}`, init), env); }
      catch (e) { return { status: 500, headers: new Headers(), text: String(e && e.message), json: null, thrown: e }; }
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, headers: res.headers, text, json };
    } finally { leave(); }
  }
  return { env, emails, call, scheduled, control, db: env.DB._db, d1: env.DB._control, worker };
}

module.exports = { workerEnv, fakeD1, loadWorker, SKIP, AVAILABLE };
