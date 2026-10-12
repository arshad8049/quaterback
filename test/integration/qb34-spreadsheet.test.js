/**
 * QB-34 re-review: formula-like signup fields open as INERT TEXT in a real spreadsheet client.
 * Verified client: LibreOffice Calc (headless, Debian bookworm `libreoffice-calc-nogui`, version
 * recorded below), importing the CSV produced by the real worker's export (GET
 * /api/submissions?format=csv), under two import settings:
 *   - default CSV import (`CSV:44,34,76,1`);
 *   - worst case: formula evaluation ON (`…,-1,true`), which turns a raw `=1+1` into a live
 *     formula — proven first, as a baseline, so the check cannot pass vacuously.
 * The imported workbook (xlsx) must contain NO formula (<f>) and every adversarial value must be a
 * text cell equal to "'" + the original value (the neutralizing prefix is visible, by design).
 * Excel, Google Sheets and Numbers are NOT verified here; the support claim is limited to this.
 * Docker (QB_INTEGRATION=1); the image is test/fixtures/libreoffice.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadWorker } = require('../helpers/worker-harness');

const ENABLED = process.env.QB_INTEGRATION === '1';
const IMAGE = 'qb-test-libreoffice:1';
const ROOT = path.join(__dirname, '..', '..');
const SETTINGS = { default: 'CSV:44,34,76,1', evaluate_formulas: 'CSV:44,34,76,1,,1033,false,true,false,false,false,-1,true' };

// Adversarial values for the user-controlled columns (agent, referrer). One row per value.
const ADVERSARIAL = [
  '=1+1', '=HYPERLINK("http://evil.example","click")', "=cmd|' /C calc'!A0", '+1+1', '+2', '-1+2', '-3', '@SUM(1,1)',
  '\t=1+1', '\r=1+1', '\n=1+1', '＝1+1', '＋1', '－1', '＠SUM(1)', '"=1+1"', 'a,b,=1+1', 'line1\nline2=1+1', 'say "hi", =1',
];
const SAFE = ['plain text', 'Claude Code'];

function docker(args, opts = {}) { return spawnSync('docker', args, { encoding: 'utf8', ...opts }); }

/** The real worker's CSV export for rows with these agents/referrers (read path only; no sqlite needed). */
async function exportCsv(values) {
  const worker = await loadWorker();
  const rows = values.map((v, i) => ({ id: values.length - i, email: `u${i}@example.com`, agent: v, created_at: '2026-10-08 00:00:00', ip: null, referrer: v }));
  const DB = { prepare: () => ({ bind() { return this; }, async all() { return { results: rows }; }, async first() { return null; } }) };
  const res = await worker.fetch(new Request('https://quaterback.velorallc.workers.dev/api/submissions?format=csv&limit=500', { headers: { Authorization: 'Bearer s3cret' } }),
    { DB, ADMIN_SECRET: 's3cret', ASSETS: { fetch: async () => new Response('') } });
  assert.equal(res.status, 200);
  return res.text();
}

/** Import a CSV in LibreOffice with `filter`; return { formulas, cells: [text…] } from the xlsx. */
function importInCalc(csv, filter) {
  // The CSV goes in on stdin; the conversion happens entirely inside the container (nothing is
  // written to the host, so no files owned by the container user are left behind).
  const r = docker(['run', '--rm', '-i', '--network', 'none', IMAGE, 'sh', '-c',
    `mkdir -p /tmp/w && cd /tmp/w && cat > in.csv && soffice --headless --infilter="${filter}" --convert-to xlsx --outdir /tmp/w /tmp/w/in.csv >/dev/null 2>&1 && unzip -o -q in.xlsx -d x && cat x/xl/worksheets/sheet1.xml && printf '\\n@@SST@@\\n' && cat x/xl/sharedStrings.xml`],
  { timeout: 180_000, input: csv });
  assert.equal(r.status, 0, r.stderr);
  const [sheet, sst] = r.stdout.split('\n@@SST@@\n');
  const strings = [...sst.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))
    .map((x) => x.replace(/_x000D_/g, '\r').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
  const cells = [...sheet.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)>([\s\S]*?)<\/c>/g)].map((m) => {
    const t = (/\st="(\w+)"/.exec(m[3]) || [])[1]; const inner = m[4];
    const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
    return { col: m[1], row: Number(m[2]), type: t || 'n', formula: /<f[\s>]/.test(inner), text: t === 's' ? strings[Number(v)] : v };
  });
  return { formulas: (sheet.match(/<f[\s>]/g) || []).length, cells };
}

describe('QB-34: CSV export opens as inert text in LibreOffice Calc', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  let version;
  before(() => {
    const b = docker(['build', '-q', '-t', IMAGE, path.join(ROOT, 'test/fixtures/libreoffice')], { timeout: 1_200_000 });
    assert.equal(b.status, 0, b.stderr);
    version = docker(['run', '--rm', IMAGE, 'soffice', '--version']).stdout.trim();
  });
  after(() => {});

  test('baseline: with formula evaluation on, a RAW formula-like cell becomes a live formula (so the check is meaningful)', () => {
    const r = importInCalc('a,b\r\n"=1+1","x"\r\n', SETTINGS.evaluate_formulas);
    assert.ok(r.formulas >= 1, `LibreOffice (${version}) did not evaluate a raw formula; the adversarial setting is not exercised`);
  });

  for (const [name, filter] of Object.entries(SETTINGS)) {
    test(`exported adversarial cells are text, never formulas — import setting: ${name}`, async () => {
      const csv = await exportCsv([...ADVERSARIAL, ...SAFE]);
      const r = importInCalc(csv, filter);
      assert.equal(r.formulas, 0, `${r.formulas} formula cell(s) after import (${version}, ${name})`);
      for (const c of r.cells) assert.notEqual(c.formula, true, `${c.col}${c.row}`);
      // columns: A id, B email, C agent, D created_at, E ip, F referrer; rows 2.. in export order
      const values = [...ADVERSARIAL, ...SAFE];
      for (const [i, v] of values.entries()) {
        const expect = /^[=+\-@\t\r\n＝＋－＠]/.test(v) ? `'${v}` : v;
        for (const col of ['C', 'F']) {
          const cell = r.cells.find((c) => c.col === col && c.row === i + 2);
          assert.ok(cell, `missing ${col}${i + 2} for ${JSON.stringify(v)}`);
          assert.equal(cell.type, 's', `${col}${i + 2} ${JSON.stringify(v)} imported as ${cell.type}, not text (${version}, ${name})`);
          assert.equal(cell.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), expect.replace(/\r\n/g, '\n').replace(/\r/g, '\n'), `${col}${i + 2}`);
        }
      }
      console.log(`# verified: ${version}; import setting "${name}" (${filter}); ${values.length} values × 2 columns; 0 formulas`);
    });
  }
});
