/**
 * QB-34: admin exports.
 *   - credentials in the query string are refused (even correct ones); only
 *     `Authorization: Bearer` is accepted, compared in constant time;
 *   - unauthorized requests never return signup data; every admin response is no-store and
 *     carries no CORS grant;
 *   - CSV cells that a spreadsheet would evaluate (=, +, -, @, tab, CR) open as inert text;
 *   - results are paginated.
 * The real worker on a real SQLite D1 (Node 22+).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { workerEnv, SKIP } = require('../helpers/worker-harness');

const ADMIN = { Authorization: 'Bearer admin-secret-for-tests' };
const FORMULAS = ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '＝1'];

async function seeded() {
  const w = await workerEnv();
  const ins = w.db.prepare('INSERT INTO submissions (email, agent, ip, referrer) VALUES (?, ?, ?, ?)');
  ins.run('a@example.com', FORMULAS[0], '1.1.1.1', FORMULAS[1]);
  ins.run('b@example.com', FORMULAS[2], '2.2.2.2', FORMULAS[3]);
  ins.run('c@example.com', FORMULAS[4], '3.3.3.3', FORMULAS[5]);
  ins.run('d@example.com', FORMULAS[6], null, 'plain "quoted" text');
  return w;
}

describe('QB-34: admin authentication', { skip: SKIP }, () => {
  test('a query-string secret is refused even when correct (pre-fix: ?secret= was the only way in)', async () => {
    const w = await seeded();
    for (const p of ['/api/report?secret=admin-secret-for-tests', '/api/submissions?secret=admin-secret-for-tests&format=csv', '/api/submissions?token=x']) {
      const r = await w.call('GET', p, { headers: ADMIN });
      assert.equal(r.status, 400, p);
      assert.doesNotMatch(r.text, /@example\.com/);
    }
  });
  test('missing, wrong or non-Bearer credentials get 401 and no signup data; responses are no-store without CORS', async () => {
    const w = await seeded();
    for (const headers of [{}, { Authorization: 'Bearer wrong' }, { Authorization: 'admin-secret-for-tests' }, { Authorization: 'Basic YWRtaW4=' }]) {
      for (const p of ['/api/report', '/api/submissions', '/api/submissions?format=csv']) {
        const r = await w.call('GET', p, { headers });
        assert.equal(r.status, 401, `${p} ${JSON.stringify(headers)}`);
        assert.doesNotMatch(r.text, /@example\.com/);
        assert.match(r.headers.get('cache-control'), /no-store/);
        assert.equal(r.headers.get('access-control-allow-origin'), null);
      }
    }
  });
  test('the Bearer header works; authorized responses are no-store, without a CORS grant', async () => {
    const w = await seeded();
    for (const p of ['/api/report', '/api/submissions', '/api/submissions?format=csv']) {
      const r = await w.call('GET', p, { headers: ADMIN });
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('cache-control'), /no-store/);
      assert.equal(r.headers.get('pragma'), 'no-cache');
      assert.equal(r.headers.get('access-control-allow-origin'), null, 'personal data must not be readable cross-origin');
    }
    assert.equal((await w.call('POST', '/api/submissions', { headers: ADMIN })).status, 405);
  });
});

describe('QB-34: CSV export is inert in spreadsheets', { skip: SKIP }, () => {
  test('every formula-like cell is prefixed so it opens as text (pre-fix: quoted but still evaluated)', async () => {
    const w = await seeded();
    const csv = (await w.call('GET', '/api/submissions?format=csv', { headers: ADMIN })).text;
    const cells = csv.split('\r\n').slice(1).flatMap((line) => line.match(/"(?:[^"]|"")*"/g).map((c) => c.slice(1, -1).replace(/""/g, '"')));
    for (const f of FORMULAS) {
      assert.ok(cells.includes(`'${f}`), `not neutralized: ${JSON.stringify(f)}`);
      assert.ok(!cells.includes(f), `raw formula present: ${JSON.stringify(f)}`);
    }
    for (const c of cells) assert.doesNotMatch(c, /^[=+\-@\t\r＝＋－＠]/);
    assert.ok(cells.includes('plain "quoted" text'));
  });
});

describe('QB-34: pagination', { skip: SKIP }, () => {
  test('limit and cursor page through signups newest first; bad parameters are 400', async () => {
    const w = await seeded();
    const p1 = (await w.call('GET', '/api/submissions?limit=3', { headers: ADMIN })).json;
    assert.deepEqual(p1.signups.map((s) => s.email), ['d@example.com', 'c@example.com', 'b@example.com']);
    assert.ok(p1.next_cursor);
    const p2 = (await w.call('GET', `/api/submissions?limit=3&cursor=${p1.next_cursor}`, { headers: ADMIN })).json;
    assert.deepEqual([p2.signups.map((s) => s.email), p2.next_cursor], [['a@example.com'], null]);
    for (const q of ['limit=0', 'limit=501', 'limit=abc', 'cursor=-1', 'format=xml']) assert.equal((await w.call('GET', `/api/submissions?${q}`, { headers: ADMIN })).status, 400, q);
    const csv = await w.call('GET', '/api/submissions?format=csv&limit=2', { headers: ADMIN });
    assert.equal(csv.text.split('\r\n').length, 3);
    assert.ok(csv.headers.get('x-next-cursor'));
  });
});
