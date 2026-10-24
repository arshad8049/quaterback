#!/usr/bin/env node
/**
 * scripts/kan75-checker-summary.js — QB's verdict against the known truth, per patch (KAN-75).
 *
 *   node scripts/kan75-checker-summary.js <replay-dir> [--set dev-r2|screen] [--json <file>]
 *
 * Reads the replay records that scripts/kan65-replay.js wrote (<ID>-<kind>.json, searched
 * recursively), and lists every patch the set should have replayed:
 *   - each task's base (no change): correct only when the task is `already_satisfied`;
 *   - its reference, when it has one: correct;
 *   - each incorrect implementation: wrong.
 * It then cross-tabulates QB's first-attempt and final verdicts against that truth.
 * - **false accept:** a wrong patch QB calls `pass`;
 * - **catch:** a wrong patch QB calls `fail`;
 * - **false fail:** a correct patch QB calls `fail`.
 * A missing, errored or BLOCKED replay, a QB `error` verdict, and an absent or unknown verdict
 * (`invalid`) are counted in their own columns and stay in the denominators, and the script exits 1.
 * An unexpected record, two records of the same patch, or records whose set, spec version or QB
 * commit disagree (or come from a dirty tree) are refused before anything is counted: exit 2, no
 * table (review 10394). So is any replay-named file that is not a usable record: another schema,
 * no schema, an error field on a full record, or not JSON; the message names the file (review
 * 10425). Only the workflow's own error-only record ({ task_id, patch_kind, error }, no schema) is
 * counted as an error. Read-only apart from --json.
 *
 * The truth labels are the benchmark's: a hidden-suite label per patch, not QB's judgement.
 */
const fs = require('fs');
const path = require('path');
const { setPaths } = require('./kan65-replay');

/** QB's verdicts. Only these five are a measurement; `error` means QB could not execute. */
const VERDICTS = new Set(['pass', 'partial', 'fail', 'unresolved', 'no-diff', 'error']);
const MEASURED = new Set(['pass', 'partial', 'fail', 'unresolved', 'no-diff']);
/** Where a record was read from; not enumerable, so it never reaches the JSON output. */
const FILE = Symbol('file');

/** The known truth of one patch of a task. */
function truthOf(spec, kind) {
  if (kind === 'reference') return 'correct';
  if (kind.startsWith('incorrect:')) return 'wrong';
  if (kind === 'base') return spec.stratum.type === 'already_satisfied' ? 'correct' : 'wrong';
  throw new Error(`unknown patch kind ${JSON.stringify(kind)}`);
}

/** Which of the four kinds of patch this is; the tables keep them apart. */
function groupOf(e) {
  if (e.kind === 'reference') return 'reference';
  if (e.kind.startsWith('incorrect:')) return 'incorrect';
  return e.truth === 'correct' ? 'base_already_satisfied' : 'base_unchanged_broken';
}
const GROUPS = { reference: 'reference (correct)', base_already_satisfied: 'base, already satisfied (correct)',
  incorrect: 'incorrect implementation (wrong)', base_unchanged_broken: 'base, unchanged, needs a change (wrong)' };

/** Every patch a set's replay should cover, with its truth. */
function expectedPatches(set = 'dev-r2') {
  const { specs, curation } = setPaths(set);
  const ids = fs.readdirSync(specs).filter((f) => /^[A-Z]{2}-\d\d\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  const out = [];
  for (const id of ids) {
    const spec = JSON.parse(fs.readFileSync(path.join(specs, `${id}.json`), 'utf8'));
    const dir = path.join(curation, id);
    const kinds = ['base'];
    if (fs.existsSync(path.join(dir, 'reference'))) kinds.push('reference');
    const wrong = path.join(dir, 'incorrect');
    for (const l of fs.existsSync(wrong) ? fs.readdirSync(wrong).sort() : []) kinds.push(`incorrect:${l}`);
    for (const kind of kinds) out.push({ task_id: id, kind, truth: truthOf(spec, kind), spec_version: spec.version });
  }
  return out;
}

/** The column a record falls in: QB's verdict, or why there is none. */
function columnOf(rec, which) {
  if (!rec) return 'missing';
  if (rec.error) return 'error';
  const a = rec.attempts && rec.attempts[0];
  const v = which === 'first' ? a && a.verification && a.verification.verdict : rec.final && rec.final.verdict;
  if (v != null) return VERDICTS.has(v) ? v : 'invalid';
  return rec.final && rec.final.blocked ? 'blocked' : 'invalid';
}

/**
 * Refuses records that cannot be combined into one measurement: another schema, set or spec
 * version, a dirty QB tree, or more than one QB commit. Replay error records (written by the
 * workflow when the replay itself failed) carry no provenance; they are counted as errors.
 */
function validateRecords(expected, records, set) {
  const version = new Map(expected.map((e) => [`${e.task_id} ${e.kind}`, e.spec_version]));
  const commits = new Set();
  for (const r of records) {
    const k = `${r.task_id} ${r.patch_kind}`;
    const from = r[FILE] ? `, file ${r[FILE]}` : '';
    // The workflow's error-only record: no schema, just the patch and the replay's error output.
    if (r.schema === undefined && r.error && typeof r.task_id === 'string' && typeof r.patch_kind === 'string') continue;
    if (r.schema !== 'qb-kan65-replay/1') throw new Error(`${k}: not a qb-kan65-replay/1 record (schema ${JSON.stringify(r.schema ?? null)}${from})`);
    if (r.error) throw new Error(`${k}: a replay record with an error field${from}`);
    if (r.set !== set) throw new Error(`${k}: set ${r.set}, expected ${set}`);
    if (version.has(k) && r.spec_version !== version.get(k)) throw new Error(`${k}: spec version ${r.spec_version}, expected ${version.get(k)}`);
    if (!r.qb || !r.qb.commit) throw new Error(`${k}: no QB commit`);
    if (r.qb.dirty !== false) throw new Error(`${k}: dirty QB tree`);
    commits.add(r.qb.commit);
  }
  if (commits.size > 1) throw new Error(`records from more than one QB commit: ${[...commits].join(', ')}`);
  return { qb_commit: [...commits][0] ?? null };
}

function headline(tab, nWrong, nCorrect) {
  return { false_accept: tab.wrong.pass || 0, catch: tab.wrong.fail || 0, false_fail: tab.correct.fail || 0, correct_pass: tab.correct.pass || 0,
    wrong_total: nWrong, correct_total: nCorrect };
}

/** Cross-tabulates `records` (replay docs, or { task_id, patch_kind, error }) against `expected`. */
function summarize(expected, records) {
  const key = (t, k) => `${t} ${k}`;
  const want = new Map(expected.map((e) => [key(e.task_id, e.kind), e]));
  const got = new Map();
  for (const r of records) {
    const k = key(r.task_id, r.patch_kind);
    const from = r[FILE] ? ` (file ${r[FILE]})` : '';
    if (!want.has(k)) throw new Error(`unexpected replay ${k}${from}`);
    if (got.has(k)) throw new Error(`duplicate replay ${k}${from}`);   // never pick one silently
    got.set(k, r);
  }
  const tab = () => ({ correct: {}, wrong: {} });
  const first = tab(); const final = tab(); const rows = [];
  const groups = Object.fromEntries(Object.keys(GROUPS).map((g) => [g, {}]));
  for (const e of expected) {
    const r = got.get(key(e.task_id, e.kind));
    const f1 = columnOf(r, 'first'); const fn = columnOf(r, 'final');
    first[e.truth][f1] = (first[e.truth][f1] || 0) + 1;
    final[e.truth][fn] = (final[e.truth][fn] || 0) + 1;
    const g = groups[groupOf(e)]; g[fn] = (g[fn] || 0) + 1;
    const t = r && !r.error && r.attempts && r.attempts[0] && r.attempts[0].verification && r.attempts[0].verification.test_outcome;
    rows.push({ ...e, first: f1, final: fn, attempts: r && r.final ? r.final.attempts : null,
      test_outcome: t ? `${t.outcome} (${t.reason})` : null });
  }
  const nWrong = expected.filter((e) => e.truth === 'wrong').length; const nCorrect = expected.length - nWrong;
  return { first, final, groups, headline: { first: headline(first, nWrong, nCorrect), final: headline(final, nWrong, nCorrect) },
    missing: rows.filter((r) => r.final === 'missing').map((r) => key(r.task_id, r.kind)),
    incomplete: rows.filter((r) => !MEASURED.has(r.final) || !MEASURED.has(r.first))
      .map((r) => `${key(r.task_id, r.kind)}: ${MEASURED.has(r.final) ? `first ${r.first}` : r.final}`), rows };
}

/**
 * Every replay candidate under `dir` (an `<ID>-<kind>.json` name), recursively. Nothing is
 * filtered here (review 10425): validateRecords refuses what cannot be counted, naming the file.
 */
function readRecords(dir, root = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readRecords(p, root));
    else if (/^[A-Z]{2}-\d\d-.+\.json$/.test(e.name)) {
      const rel = path.relative(root, p);
      let d;
      try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) { throw new Error(`${rel}: not a JSON record (${err.message})`); }
      if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${rel}: not a JSON object`);
      Object.defineProperty(d, FILE, { value: rel, enumerable: false });
      out.push(d);
    }
  }
  return out;
}

function render(s) {
  const cols = [...new Set(['pass', 'partial', 'fail', 'unresolved', 'no-diff', 'error', 'blocked', 'invalid', 'missing',
    ...Object.keys(s.final.correct), ...Object.keys(s.final.wrong), ...Object.keys(s.first.correct), ...Object.keys(s.first.wrong)])];
  const line = (name, row) => `| ${name} | ${cols.map((c) => row[c] || 0).join(' | ')} |`;
  const table = (t, label) => [`**${label}**`, '', `| truth | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
    line('correct', t.correct), line('wrong', t.wrong), ''].join('\n');
  const groupTable = ['**Final verdict by patch group**', '', `| patch group | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
    ...Object.entries(GROUPS).map(([g, label]) => line(label, s.groups[g])), ''].join('\n');
  const perPatch = ['**Every patch**', '', '| task | patch | truth | first | final | attempts | first test outcome |', '|---|---|---|---|---|---|---|',
    ...s.rows.map((r) => `| ${r.task_id} | ${r.kind} | ${r.truth} | ${r.first} | ${r.final} | ${r.attempts ?? '—'} | ${r.test_outcome ?? '—'} |`), ''].join('\n');
  const h = (x) => `false accept ${x.false_accept}/${x.wrong_total}; catch ${x.catch}/${x.wrong_total}; false fail ${x.false_fail}/${x.correct_total}; correct pass ${x.correct_pass}/${x.correct_total}`;
  return ['Truth is the benchmark\'s hidden-suite label for each patch, not QB\'s judgement.', '',
    table(s.first, 'First attempt'), table(s.final, 'Final verdict'), groupTable,
    `First attempt: ${h(s.headline.first)}`, `Final verdict: ${h(s.headline.final)}`,
    s.missing.length ? `Missing replays (${s.missing.length}): ${s.missing.join(', ')}` : 'Missing replays: none',
    s.incomplete.length ? `Incomplete (${s.incomplete.length}): ${s.incomplete.join(', ')}` : 'Incomplete: none', '', perPatch].join('\n');
}

module.exports = { truthOf, groupOf, expectedPatches, summarize, validateRecords, readRecords, render, VERDICTS, MEASURED };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : d; };
  const set = opt('--set', 'dev-r2'); const json = opt('--json', null);
  const [dir] = a;
  if (!dir) { console.error('usage: kan75-checker-summary.js <replay-dir> [--set dev-r2|screen] [--json file]'); process.exit(2); }
  let s; let prov;
  try {
    const expected = expectedPatches(set); const records = readRecords(dir);
    prov = validateRecords(expected, records, set);
    s = summarize(expected, records);
  } catch (e) { console.error(`refused: ${e.message}`); process.exit(2); }
  console.log(`QB commit: ${prov.qb_commit ?? 'none (no successful replay)'}`);
  console.log(render(s));
  if (json) fs.writeFileSync(json, JSON.stringify({ set, ...prov, ...s }, null, 1) + '\n');
  if (s.incomplete.length) process.exit(1);   // an error, BLOCKED, invalid or missing replay is never a finished measurement
}
