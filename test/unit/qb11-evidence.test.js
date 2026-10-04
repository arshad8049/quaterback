/**
 * QB-11: judge evidence is complete for what matters, and has provenance.
 * - a defect after character 6,000 of the diff is visible (whole hunks, ranked, budgeted);
 * - a defect inside an UNCHANGED helper the change calls is visible (retrieved from the
 *   tested candidate tree, with file hash and line range);
 * - every evidence item has an immutable, content-addressed ID; the judge's refs must
 *   name shown items;
 * - truncation and missing evidence are explicit: missing MATERIAL evidence can never
 *   yield "met" — it is unresolved, naming the missing artifact.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { buildEvidence, parseDiff } = require('../../verify/evidence');
const { verify } = require('../../verify/verifier');
const { approve } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const TREE = 'c'.repeat(40);
const oid = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0${text}`).digest('hex');
const file = (p, text) => ({ path: p, oid: oid(text), size: Buffer.byteLength(text), text });
const hunk = (p, start, lines, context = []) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -${start},${context.length} +${start},${context.length + lines.length} @@\n`
  + context.map((l) => ` ${l}\n`).join('') + lines.map((l) => `+${l}\n`).join('');

const contract = (criterion) => approve({ id: 'c', goal: 'g', clarifying_question: null, scope: { allowed_changes: ['**'] },
  acceptance_criteria: [{ id: 'AC-1', criterion, met: null, kind: 'non_behavioral' }] }, { via: 'test' });
const exec = (diff, { files = [], skipped = [], snapshot = true } = {}) => ({
  id: 'e', status: 'completed', diff, candidate_tree: TREE,
  changes: parseDiff(diff).map((f) => ({ file: f.file, status: 'M', additions: 1, deletions: 0 })),
  sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT, tree: TREE },
    ...(snapshot ? { snapshot: { tree: TREE, files, skipped } } : {}) },
});

/** A scripted judge: votes false only if it can SEE the defect and cite its evidence ID; otherwise true. */
function scriptedJudge(defect, fileRe) {
  const prompts = [];
  const m = mockFetch((url, init) => {
    const user = JSON.parse(init.body).messages.find((x) => x.role === 'user').content;
    prompts.push(user);
    const id = (new RegExp(`\\[(EV-[0-9a-f]{12})\\][^\\n]*${fileRe}`).exec(user) || [])[1];
    return id && user.includes(defect)
      ? ollamaReply({ met: false, evidence: `the evidence shows ${defect}`, refs: [id], repair: 'fix it' })
      : ollamaReply({ met: true, evidence: 'looks fine' });
  });
  return { prompts, restore: m.restore };
}

describe('a defect after character 6,000 is visible', () => {
  test('a README defect after a 7,000-character source hunk reaches the judge → FAIL citing it (pre-fix: truncated → PASS)', async () => {
    const big = Array.from({ length: 140 }, (_, i) => `const filler${i} = ${i}; // ${'x'.repeat(30)}`);
    const diff = hunk('src/big.js', 1, big) + hunk('README.md', 10, ['--verbose: prints nothing (TODO)']);
    assert.ok(diff.indexOf('prints nothing') > 6000);
    const j = scriptedJudge('prints nothing', 'README\\.md');
    try {
      const r = await verify(contract('README documents what the --verbose flag prints'), null, exec(diff));
      assert.equal(r.verdict, 'fail');
      const c = r.criteria_results[0];
      assert.equal(c.met, false);
      const ev = r.evidence.find((e) => e.id === c.refs[0]);
      assert.deepEqual([ev.kind, ev.file, ev.range], ['hunk', 'README.md', [10, 10]]);
    } finally { j.restore(); }
  });
  test('the hunk most relevant to the criterion is shown first, whole (never cut mid-hunk)', () => {
    const big = Array.from({ length: 140 }, (_, i) => `const filler${i} = ${i};`);
    const diff = hunk('src/big.js', 1, big) + hunk('README.md', 10, ['--verbose: prints nothing']);
    const b = buildEvidence({ criterion: 'README documents --verbose', diff, files: [] });
    assert.equal(b.shown[0].file, 'README.md');
    for (const it of b.shown.filter((x) => x.kind === 'hunk')) assert.ok(diff.includes(it.text), 'whole hunk text');
  });
});

describe('a defect inside an unchanged helper is visible through retrieval', () => {
  const GREET = "const { fmt } = require('./fmt');\n\n// greeting helpers\n\nfunction wave() { return 'o/'; }\n\nmodule.exports.greet = (n) => fmt(n);\nmodule.exports.wave = wave;\n";
  const FMT = "function fmt(n) {\n  return 'Hi ' + n;\n}\n\nmodule.exports = { fmt };\n";
  const DIFF = hunk('src/greet.js', 7, ['module.exports.greet = (n) => fmt(n);'], ['', '// greeting helpers', '', "function wave() { return 'o/'; }", '']);

  test('the unchanged fmt() definition (another file, imported) is shown with blob, range and hash → FAIL citing it (pre-fix: never shown → PASS)', async () => {
    const j = scriptedJudge("return 'Hi ' + n", 'src/fmt\\.js');
    try {
      const r = await verify(contract("greet() uses the 'Hello, <name>!' format"), null, exec(DIFF, { files: [file('src/greet.js', GREET), file('src/fmt.js', FMT)] }));
      assert.equal(r.verdict, 'fail');
      const ev = r.evidence.find((e) => e.id === r.criteria_results[0].refs[0]);
      assert.deepEqual([ev.kind, ev.file, ev.range, ev.blob, ev.tree, ev.source], ['definition', 'src/fmt.js', [1, 3], oid(FMT), TREE, 'candidate_tree']);
      assert.equal(ev.sha256, crypto.createHash('sha256').update("function fmt(n) {\n  return 'Hi ' + n;\n}").digest('hex'));
    } finally { j.restore(); }
  });
  test('missing material evidence → unresolved, naming the missing artifact (the judge\'s "met" is not accepted)', async () => {
    const j = scriptedJudge('never-visible', 'nowhere');                       // would vote met:true
    try {
      const r = await verify(contract("greet() uses the 'Hello, <name>!' format"), null,
        exec(DIFF, { files: [file('src/greet.js', GREET)], skipped: [{ path: 'src/fmt.js', reason: 'too_large' }, { path: 'src/fmt/index.js', reason: 'missing' }] }));
      assert.equal(r.verdict, 'unresolved');
      const c = r.criteria_results[0];
      assert.equal(c.met, null);
      assert.match(c.evidence, /Missing material evidence: definition of fmt \(imported from \.\/fmt\) — src\/fmt\.js too_large/);
      assert.deepEqual(c.evidence_missing.map((x) => x.what), ['definition of fmt (imported from ./fmt)']);
    } finally { j.restore(); }
  });
  test('a candidate snapshot that failed is itself named as missing evidence', async () => {
    const j = scriptedJudge('never-visible', 'nowhere');
    try {
      const e = exec(DIFF);
      e.sandbox.snapshot = { error: 'snapshot timeout: deadline' };
      const r = await verify(contract("greet() uses the 'Hello, <name>!' format"), null, e);
      assert.equal(r.verdict, 'unresolved');
      assert.match(r.criteria_results[0].evidence, /candidate source files \(snapshot timeout: deadline\)/);
    } finally { j.restore(); }
  });
});

describe('truncation is explicit; partial input is never presented as complete', () => {
  test('hunks that do not fit the budget are named as NOT shown, and the criterion cannot be met', async () => {
    const diff = Array.from({ length: 60 }, (_, i) => hunk(`src/f${String(i).padStart(2, '0')}.js`, 1, Array.from({ length: 30 }, (_, k) => `const v${k} = '${'y'.repeat(40)}';`))).join('');
    const j = scriptedJudge('never-visible', 'nowhere');
    try {
      const r = await verify(contract('every module declares its constants'), null, exec(diff));
      const c = r.criteria_results[0];
      assert.equal(c.met, null);
      assert.equal(r.verdict, 'unresolved');
      assert.match(c.evidence, /Missing material evidence: hunk src\/f\d\d\.js \+1\.\.30 \(not shown: evidence budget\)/);
      assert.match(j.prompts[0], /## Evidence NOT shown/);
      assert.ok(c.evidence_missing.length > 0 && c.evidence_ids.length > 0);
    } finally { j.restore(); }
  });
});

describe('provenance: immutable evidence IDs, refs must name shown evidence', () => {
  const FMT = "function fmt(n) {\n  return 'Hi ' + n;\n}\nmodule.exports = { fmt };\n";
  const GREET = "const { fmt } = require('./fmt');\nmodule.exports.greet = (n) => fmt(n);\n";
  const DIFF = hunk('src/greet.js', 2, ['module.exports.greet = (n) => fmt(n);']);
  const b = (fmtText) => buildEvidence({ criterion: 'greet format', diff: DIFF, files: [file('src/greet.js', GREET), file('src/fmt.js', fmtText)], tree: TREE });

  test('IDs are content-addressed: identical evidence → identical IDs; a changed helper → a new ID for it only', () => {
    const a = b(FMT), a2 = b(FMT), c = b(FMT.replace('Hi', 'Hello'));
    assert.deepEqual(a.shown.map((x) => x.id), a2.shown.map((x) => x.id));
    for (const x of a.shown) assert.match(x.id, /^EV-[0-9a-f]{12}$/);
    const def = (bb) => bb.shown.find((x) => x.kind === 'definition').id;
    const hk = (bb) => bb.shown.find((x) => x.kind === 'hunk').id;
    assert.notEqual(def(a), def(c));
    assert.equal(hk(a), hk(c));
  });
  test('a vote citing an evidence ID that was not shown is an invalid judgment (never counted)', async () => {
    const m = mockFetch(ollamaReply({ met: true, evidence: 'fine', refs: ['EV-deadbeef0000'] }));
    try {
      const r = await verify(contract('greet format'), null, exec(DIFF, { files: [file('src/greet.js', GREET), file('src/fmt.js', FMT)] }));
      const c = r.criteria_results[0];
      assert.equal(c.met, null);
      assert.equal(c.judgment_status, 'invalid_judgment');
    } finally { m.restore(); }
  });
  test('the report carries an evidence manifest (no file contents), and each criterion the IDs it was judged on', async () => {
    const m = mockFetch(ollamaReply({ met: true, evidence: 'fine' }));
    try {
      const r = await verify(contract('greet format'), null, exec(DIFF, { files: [file('src/greet.js', GREET), file('src/fmt.js', FMT)] }));
      assert.equal(r.verdict, 'pass');
      const c = r.criteria_results[0];
      assert.deepEqual(new Set(c.evidence_ids), new Set(r.evidence.map((e) => e.id)));
      for (const e of r.evidence) { assert.equal(e.text, undefined); assert.match(e.sha256, /^[0-9a-f]{64}$/); }
    } finally { m.restore(); }
  });
  test('check results for the criterion are evidence items too', () => {
    const bb = buildEvidence({ criterion: 'x', diff: DIFF, files: [], checks: [{ id: 'CHK-1', status: 'fail', detail: 'expected 3, got 0' }] });
    const chk = bb.shown.find((x) => x.kind === 'check');
    assert.deepEqual([chk.file, chk.source], [null, 'check_run']);
    assert.match(chk.text, /CHK-1: fail — expected 3, got 0/);
  });
});

describe('no-change judgments use the same evidence (no 6,000-character cut)', () => {
  test('a requirement after character 6,000 of the current files is visible', async () => {
    const pad = Array.from({ length: 200 }, (_, i) => `// line ${i} ${'z'.repeat(30)}`).join('\n');
    const text = `${pad}\nfunction clamp(v, lo, hi) { return v; } // ignores bounds\n`;
    const e = { id: 'e', status: 'no_change', diff: null, candidate_tree: TREE, changes: [],
      sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT, tree: TREE },
        snapshot: { tree: TREE, files: [file('src/clamp.js', text)], skipped: [] } } };
    const j = scriptedJudge('ignores bounds', 'src/clamp\\.js');
    try {
      const r = await verify(contract('clamp() keeps values within [lo, hi]'), null, e);
      assert.equal(r.criteria_results[0].met, false);
    } finally { j.restore(); }
  });
});

test('rules 6 is stored; the same missing-evidence result under rules 5 replays as it was decided then (partial)', async () => {
  const { aggregate, inputFromReport } = require('../../verify/verdict');
  const GREET = "const { fmt } = require('./fmt');\nmodule.exports.greet = (n) => fmt(n);\n";
  const e = exec(hunk('src/greet.js', 2, ['module.exports.greet = (n) => fmt(n);']), { files: [file('src/greet.js', GREET)], skipped: [{ path: 'src/fmt.js', reason: 'too_large' }] });
  const m = mockFetch(ollamaReply({ met: true, evidence: 'fine' }));
  try {
    const r = await verify(contract('greet format'), null, e);
    const input = inputFromReport(r, e);
    assert.deepEqual([input.rules, aggregate(input).verdict, r.verdict], [6, 'unresolved', 'unresolved']);
    assert.equal(aggregate({ ...input, rules: 5 }).verdict, 'partial');
  } finally { m.restore(); }
});

test('every sandbox stage has a deadline (a missing one reached the supervisor as null = already due → killed after the grace period)', () => {
  const { DEFAULT_DEADLINES } = require('../../lib/sandbox/pipeline');
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'sandbox', 'pipeline.js'), 'utf8');
  const names = [...new Set([...src.matchAll(/\bstage\(\s*'([^']+)'/g)].map((m) => m[1]))];
  assert.ok(names.includes('snapshot') && names.includes('verify-base') && names.includes('checks'));
  for (const n of names) assert.ok(Number.isInteger(DEFAULT_DEADLINES[n]) && DEFAULT_DEADLINES[n] > 0, `stage "${n}" has no deadline`);
});

describe('QB-11 re-review: the exported binding is resolved — never the first declaration', () => {
  const DECOY = "function decoy(n) { return 'Hello ' + n; }\nfunction actual(n) { return 'WRONG ' + n; }\nmodule.exports = actual;\n";
  const greetCjs = "const fmt = require('./fmt');\nmodule.exports.greet = n => fmt(n);\n";
  const DIFF = hunk('src/greet.js', 2, ['module.exports.greet = n => fmt(n);']);
  const defs = (b) => b.shown.filter((x) => x.kind === 'definition' && x.material).map((x) => [x.file, x.text.split('(')[0]]);   // material: what the change calls

  test('senior repro: CommonJS callable export with a decoy first → the actual export is shown, the decoy is not (pre-fix: decoy, missing [])', async () => {
    const b = buildEvidence({ criterion: "greet() greets with 'Hello'", diff: DIFF, files: [file('src/greet.js', greetCjs), file('src/fmt.js', DECOY)], tree: TREE });
    assert.deepEqual(defs(b), [['src/fmt.js', 'function actual']]);
    assert.deepEqual(b.missing, []);
    const j = scriptedJudge("'WRONG '", 'src/fmt\\.js');
    try {
      const r = await verify(contract("greet() greets with 'Hello'"), null, exec(DIFF, { files: [file('src/greet.js', greetCjs), file('src/fmt.js', DECOY)] }));
      assert.equal(r.verdict, 'fail');
    } finally { j.restore(); }
  });
  test('ESM default export with a decoy first → the actual export is shown', () => {
    const fmt = "function decoy(n) { return 'Hello ' + n; }\nfunction actual(n) { return 'WRONG ' + n; }\nexport default actual;\n";
    const greet = "import fmt from './fmt.mjs';\nexport const greet = (n) => fmt(n);\n";
    const b = buildEvidence({ criterion: 'x', diff: hunk('src/greet.mjs', 2, ['export const greet = (n) => fmt(n);']), files: [file('src/greet.mjs', greet), file('src/fmt.mjs', fmt)], tree: TREE });
    assert.deepEqual(defs(b), [['src/fmt.mjs', 'function actual']]);
  });
  test('positive guards: inline default / module function, named exports and object properties bind to the right definition', () => {
    const cases = [
      ["const fmt = require('./fmt');", "function decoy() {}\nmodule.exports = function (n) { return 'Hi ' + n; };\n", 'module.exports = function '],
      ["import fmt from './fmt.mjs';", "function decoy() {}\nexport default function real(n) { return 'Hi ' + n; }\n", 'export default function real'],
      ["const { fmt } = require('./fmt');", "function fmt2() {}\nfunction realFmt(n) { return n; }\nmodule.exports = { fmt: realFmt };\n", 'function realFmt'],
      ["const { fmt } = require('./fmt');", "function decoy() {}\nexports.fmt = function (n) { return n; };\n", 'exports.fmt = function '],
      ["import { fmt } from './fmt.mjs';", "function decoy() {}\nfunction inner(n) { return n; }\nexport { inner as fmt };\n", 'function inner'],
    ];
    for (const [imp, target, expect] of cases) {
      const esm = imp.startsWith('import');
      const own = esm ? 'src/greet.mjs' : 'src/greet.js';
      const tgt = esm ? 'src/fmt.mjs' : 'src/fmt.js';
      const b = buildEvidence({ criterion: 'x', diff: hunk(own, 2, ['const greet = (n) => fmt(n);']), files: [file(own, `${imp}\nconst greet = (n) => fmt(n);\n`), file(tgt, target)], tree: TREE });
      const d = b.shown.filter((x) => x.kind === 'definition');
      assert.equal(d.length, 1, `${imp} / ${target}`);
      assert.ok(d[0].text.startsWith(expect), `${JSON.stringify(d[0].text)} should start with ${expect}`);
      assert.deepEqual(b.missing, []);
    }
  });
  test('an export binding QB cannot resolve is named as missing material, never substituted', async () => {
    for (const target of ["module.exports = require('./other');\nfunction decoy() {}\n", "function decoy() {}\nmodule.exports = make();\n",
      "function actual() {}\nfunction actual2() {}\nmodule.exports = { other: actual };\n"]) {
      const b = buildEvidence({ criterion: 'x', diff: DIFF, files: [file('src/greet.js', greetCjs), file('src/fmt.js', target)], tree: TREE });
      assert.deepEqual(b.shown.filter((x) => x.kind === 'definition'), [], target);
      assert.match(b.missing.map((m) => `${m.what} — ${m.reason}`).join(' | '), /definition of fmt \(imported from \.\/fmt\) — src\/fmt\.js: export binding not resolved/, target);
    }
  });
});

describe('QB-11 re-review: unavailable source of a changed file is named, never silently skipped', () => {
  const DIFF = hunk('src/greet.js', 20, ['module.exports.greet = n => fmt(n);']);
  const C = () => contract("greet() greets with 'Hello'");
  const run = async (e) => { const m = mockFetch(ollamaReply({ met: true, evidence: 'looks fine' })); try { return await verify(C(), null, e); } finally { m.restore(); } };

  test('senior repro: the changed file was too large to export → missing source named, unresolved (pre-fix: missing [], PASS)', async () => {
    const r = await run(exec(DIFF, { files: [], skipped: [{ path: 'src/greet.js', reason: 'too_large' }] }));
    assert.equal(r.verdict, 'unresolved');
    assert.match(r.criteria_results[0].evidence, /source of src\/greet\.js \(to resolve calls to fmt\) — too_large/);
  });
  test('beyond the export cap (not_requested), a parse failure, and an absent snapshot are each named', async () => {
    const notReq = await run(exec(DIFF, { files: [], skipped: [{ path: 'src/greet.js', reason: 'not_requested' }] }));
    assert.match(notReq.criteria_results[0].evidence, /source of src\/greet\.js \(to resolve calls to fmt\) — not_requested/);
    const broken = await run(exec(DIFF, { files: [file('src/greet.js', 'module.exports.greet = n => fmt(n);\nfunction (\n')] }));
    assert.match(broken.criteria_results[0].evidence, /source of src\/greet\.js \(to resolve calls to fmt\) — unparsable/);
    const absent = await run(exec(DIFF, { snapshot: false }));
    assert.match(absent.criteria_results[0].evidence, /source of src\/greet\.js \(to resolve calls to fmt\) — no candidate snapshot/);
    for (const r of [notReq, broken, absent]) assert.equal(r.verdict, 'unresolved');
  });
  test('guards: calls defined in the hunk itself, or to built-ins, need no source; an available file resolves same-file helpers', async () => {
    const self = hunk('src/a.js', 20, ['function twice(n) { return n * 2; }', 'module.exports.f = (n) => twice(parseInt(n, 10)) + Math.max(1, 2);']);
    assert.equal((await run(exec(self, { snapshot: false }))).verdict, 'pass');
    const own = "function helper(n) { return 'Hello ' + n; }\n" + '\n'.repeat(18) + 'module.exports.greet = n => helper(n);\n';
    const b = buildEvidence({ criterion: 'x', diff: hunk('src/greet.js', 20, ['module.exports.greet = n => helper(n);']), files: [file('src/greet.js', own)], tree: TREE });
    assert.deepEqual(b.shown.filter((x) => x.kind === 'definition').map((x) => x.range), [[1, 1]]);
    assert.deepEqual(b.missing, []);
  });
});

test('QB-11 re-review: the judge is told, every time, what retrieval does not cover (callers, dynamic dispatch, package imports)', async () => {
  const j = scriptedJudge('never-visible', 'nowhere');
  try {
    await verify(contract('README documents --verbose'), null, exec(hunk('README.md', 1, ['--verbose prints stages'])));
    assert.match(j.prompts[0], /## Not retrieved by QB \(by design\)\n- callers of the changed code, dynamic dispatch, package \(non-relative\) imports/);
  } finally { j.restore(); }
});
