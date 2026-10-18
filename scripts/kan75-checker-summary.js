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
 * A missing, errored or BLOCKED replay is counted in its own column and stays in the
 * denominators, and the script exits 1. An unexpected record is refused. Read-only apart from
 * --json.
 */
const fs = require('fs');
const path = require('path');
const { setPaths } = require('./kan65-replay');

/** The known truth of one patch of a task. */
function truthOf(spec, kind) {
  if (kind === 'reference') return 'correct';
  if (kind.startsWith('incorrect:')) return 'wrong';
  if (kind === 'base') return spec.stratum.type === 'already_satisfied' ? 'correct' : 'wrong';
  throw new Error(`unknown patch kind ${JSON.stringify(kind)}`);
}

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
    for (const kind of kinds) out.push({ task_id: id, kind, truth: truthOf(spec, kind) });
  }
  return out;
}

/** The column a record falls in: QB's verdict, or why there is none. */
function columnOf(rec, which) {
  if (!rec) return 'missing';
  if (rec.error) return 'error';
  if (which === 'first') {
    const a = rec.attempts && rec.attempts[0];
    if (a && a.verification && a.verification.verdict) return a.verification.verdict;
    return rec.final && rec.final.blocked ? 'blocked' : 'none';
  }
  if (rec.final && rec.final.verdict) return rec.final.verdict;
  return rec.final && rec.final.blocked ? 'blocked' : 'none';
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
    if (!want.has(k)) throw new Error(`unexpected replay ${k}`);
    got.set(k, r);
  }
  const tab = () => ({ correct: {}, wrong: {} });
  const first = tab(); const final = tab(); const rows = [];
  for (const e of expected) {
    const r = got.get(key(e.task_id, e.kind));
    const f1 = columnOf(r, 'first'); const fn = columnOf(r, 'final');
    first[e.truth][f1] = (first[e.truth][f1] || 0) + 1;
    final[e.truth][fn] = (final[e.truth][fn] || 0) + 1;
    rows.push({ ...e, first: f1, final: fn, attempts: r && r.final ? r.final.attempts : null });
  }
  const nWrong = expected.filter((e) => e.truth === 'wrong').length; const nCorrect = expected.length - nWrong;
  return { first, final, headline: { first: headline(first, nWrong, nCorrect), final: headline(final, nWrong, nCorrect) },
    missing: rows.filter((r) => r.final === 'missing').map((r) => key(r.task_id, r.kind)), rows };
}

/** Replay records under `dir`, recursively. */
function readRecords(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...readRecords(p));
    else if (/^[A-Z]{2}-\d\d-.+\.json$/.test(e.name)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (d.schema === 'qb-kan65-replay/1' || d.error) out.push(d);
    }
  }
  return out;
}

function render(s) {
  const cols = [...new Set(['pass', 'partial', 'fail', 'unresolved', 'no-diff', 'error', 'blocked', 'none', 'missing',
    ...Object.keys(s.final.correct), ...Object.keys(s.final.wrong), ...Object.keys(s.first.correct), ...Object.keys(s.first.wrong)])];
  const line = (name, row) => `| ${name} | ${cols.map((c) => row[c] || 0).join(' | ')} |`;
  const table = (t, label) => [`**${label}**`, '', `| truth | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
    line('correct', t.correct), line('wrong', t.wrong), ''].join('\n');
  const h = (x) => `false accept ${x.false_accept}/${x.wrong_total}; catch ${x.catch}/${x.wrong_total}; false fail ${x.false_fail}/${x.correct_total}; correct pass ${x.correct_pass}/${x.correct_total}`;
  return [table(s.first, 'First attempt'), table(s.final, 'Final verdict'),
    `First attempt: ${h(s.headline.first)}`, `Final verdict: ${h(s.headline.final)}`,
    s.missing.length ? `Missing replays (${s.missing.length}): ${s.missing.join(', ')}` : 'Missing replays: none'].join('\n');
}

module.exports = { truthOf, expectedPatches, summarize, readRecords, render };

if (require.main === module) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, 2)[1] : d; };
  const set = opt('--set', 'dev-r2'); const json = opt('--json', null);
  const [dir] = a;
  if (!dir) { console.error('usage: kan75-checker-summary.js <replay-dir> [--set dev-r2|screen] [--json file]'); process.exit(2); }
  const s = summarize(expectedPatches(set), readRecords(dir));
  console.log(render(s));
  if (json) fs.writeFileSync(json, JSON.stringify({ set, ...s }, null, 1) + '\n');
  if (s.missing.length) process.exit(1);   // an incomplete replay is never a finished measurement
}
