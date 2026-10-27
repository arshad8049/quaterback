#!/usr/bin/env node
/**
 * scripts/kan99-scenario-matrix.js — KAN-99 milestone 1: can scenario checks say yes to a correct
 * patch and no to a wrong one?
 *
 * The checks are bench/kan99/checks/<task>/<AC>.js, one per acceptance criterion, written from the
 * task's prompt and criterion text only (a development fixture; dev-r2 is unchanged). Each patch
 * of a task (the base, the reference, every incorrect implementation under bench/curation/<task>)
 * is overlaid on a fresh clone of the built task repository, installed from its lockfile, and the
 * checks are run by QB's own check runner (sandbox/agent/qb-check-runner.mjs). No model, no agent.
 *
 * "Yes" means every check passed; "no" means at least one failed and none errored. An error, an
 * unusable runner output or a missing record is "incomplete": never a yes and never a catch.
 *
 * CLI:
 *   node scripts/kan99-scenario-matrix.js run <task> --repo <built checkout> --out <dir>
 *   node scripts/kan99-scenario-matrix.js summary <dir> [--json <file>]
 *     exit 0: every record complete; 1: something incomplete; 2: records refused
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateChecks, checkSetHash } = require('../verify/checks/registry');
const { validateCheckResults } = require('../verify/checks/results');

const ROOT = path.join(__dirname, '..');
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const SCHEMA = 'qb-kan99-scenario/1';
const TASKS = ['AV-04', 'FJ-01', 'FP-03', 'LM-01', 'PW-01'];
const DEFAULTS = { checksDir: path.join(ROOT, 'bench', 'kan99', 'checks'), curationDir: path.join(ROOT, 'bench', 'curation') };

const criteriaOf = (task, o) => JSON.parse(fs.readFileSync(path.join(o.curationDir, task, 'task.json'), 'utf8')).oracle.acceptance_criteria;
const acOrder = (a, b) => Number(a.slice(3)) - Number(b.slice(3));

/** The task's checks, one per criterion in criterion order, validated as a reviewed contract. */
function loadChecks(task, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const acs = criteriaOf(task, o);
  const dir = path.join(o.checksDir, task);
  const files = new Set(fs.readdirSync(dir).filter((f) => /^AC-\d+\.js$/.test(f)));
  for (const a of acs) if (!files.has(`${a.id}.js`)) throw new Error(`${task}: no check for ${a.id}`);
  const known = new Set(acs.map((a) => `${a.id}.js`));
  for (const f of files) if (!known.has(f)) throw new Error(`${task}: ${f} names no criterion`);
  const checks = acs.map((a) => ({ id: `${task}-${a.id}`, ac_id: a.id, adapter: 'scenario',
    params: { source: fs.readFileSync(path.join(dir, `${a.id}.js`), 'utf8') } }));
  const r = validateChecks(checks, acs, { allowScenario: true });
  if (r.rejected.length) throw new Error(`${task}: refused by the registry: ${r.rejected.map((x) => `${x.check?.id || '?'} ${x.reason}`).join('; ')}`);
  return r.accepted;
}

/** base, reference (if any), then every incorrect implementation in name order. */
function patchKinds(task, opts = {}) {
  const cur = path.join({ ...DEFAULTS, ...opts }.curationDir, task);
  const kinds = ['base'];
  if (fs.existsSync(path.join(cur, 'reference'))) kinds.push('reference');
  const inc = path.join(cur, 'incorrect');
  if (fs.existsSync(inc)) kinds.push(...fs.readdirSync(inc).sort().map((n) => `incorrect:${n}`));
  return kinds;
}

/** The benchmark's label. All five milestone bases need a change, so an unchanged base is wrong. */
function truthOf(kind) { return kind === 'reference' ? 'correct' : 'wrong'; }

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 600_000 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${String(r.stderr || r.error || '').trim().slice(-2000)}`);
  return r.stdout;
}

/** Run the task's checks on one patch; returns the record. The built repository is not touched. */
function runPatch({ task, kind, repo, timeoutMs = 10_000, ...opts }) {
  const o = { ...DEFAULTS, ...opts };
  const checks = loadChecks(task, o);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan99-'));
  try {
    const work = path.join(tmp, 'work');
    sh('git', ['clone', '-q', '--no-hardlinks', repo, work], tmp);
    const baseRev = sh('git', ['rev-parse', 'HEAD'], work).trim();
    if (kind !== 'base') {
      const tree = kind === 'reference' ? path.join(o.curationDir, task, 'reference')
        : kind.startsWith('incorrect:') ? path.join(o.curationDir, task, 'incorrect', kind.slice('incorrect:'.length)) : null;
      if (!tree || !fs.existsSync(tree)) throw new Error(`unknown patch kind ${kind}`);
      fs.cpSync(tree, work, { recursive: true });
    }
    if (fs.existsSync(path.join(work, 'package-lock.json'))) sh('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], work);
    const out = path.join(tmp, 'qb-checks.json');
    const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: work, checks }), encoding: 'utf8',
      env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: String(timeoutMs) }, timeout: 600_000 });
    if (r.status !== 0) throw new Error(`check runner exited ${r.status}: ${String(r.stderr).slice(-2000)}`);
    const hash = checkSetHash(checks);
    const v = validateCheckResults(fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, checks, hash);
    if (!v.ok) throw new Error(`unusable check results: ${v.reason}`);
    return { schema: SCHEMA, task_id: task, patch_kind: kind, truth: truthOf(kind), base_rev: baseRev,
      check_set_hash: hash, node: process.version, results: v.results };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

/**
 * Cross-tabulate the records against the expected patches.
 * @param {Array} records - runPatch records, or { task_id, patch_kind, error } for a run that failed
 * @param {Array<{task, kind}>} expected
 */
function summarize(records, expected) {
  const key = (t, k) => `${t} ${k}`;
  const want = new Set(expected.map((e) => key(e.task, e.kind)));
  const byKey = new Map();
  const hashes = new Map();
  for (const r of records) {
    const k = key(r.task_id, r.patch_kind);
    if (!want.has(k)) throw new Error(`unexpected ${k}`);
    if (byKey.has(k)) throw new Error(`duplicate ${k}`);
    if (!r.error && r.schema !== SCHEMA) throw new Error(`${k}: not a ${SCHEMA} record (schema ${JSON.stringify(r.schema)})`);
    if (!r.error) {
      if (hashes.has(r.task_id) && hashes.get(r.task_id) !== r.check_set_hash) throw new Error(`${k}: check set hash differs from the task's other records`);
      hashes.set(r.task_id, r.check_set_hash);
    }
    byKey.set(k, r);
  }
  const incomplete = [];
  const patches = expected.map(({ task, kind }) => {
    const r = byKey.get(key(task, kind));
    const truth = truthOf(kind);
    if (!r) { incomplete.push(`${task} ${kind}: missing`); return { task, kind, truth, said: 'incomplete', results: null }; }
    if (r.error) { incomplete.push(`${task} ${kind}: ${String(r.error).trim().split('\n').pop().slice(0, 300)}`); return { task, kind, truth, said: 'incomplete', results: null }; }
    const st = r.results.map((x) => x.status);
    const errs = r.results.filter((x) => x.status === 'error');
    if (errs.length) incomplete.push(`${task} ${kind}: ${errs.map((x) => `${x.ac_id} error (${String(x.detail || '').slice(0, 200)})`).join('; ')}`);
    const said = errs.length ? 'incomplete' : st.every((s) => s === 'pass') ? 'yes' : 'no';
    return { task, kind, truth, said, results: r.results };
  });
  const totals = { correct: { yes: 0, no: 0, incomplete: 0 }, wrong: { yes: 0, no: 0, incomplete: 0 } };
  for (const p of patches) totals[p.truth][p.said]++;

  const lines = ['## KAN-99 scenario checks: base, reference and incorrect patches', '',
    '| Benchmark label | checks said yes | checks said no | incomplete |', '| --- | --- | --- | --- |',
    `| correct (${patches.filter((p) => p.truth === 'correct').length}) | ${totals.correct.yes} | ${totals.correct.no} | ${totals.correct.incomplete} |`,
    `| wrong (${patches.filter((p) => p.truth === 'wrong').length}) | ${totals.wrong.yes} | ${totals.wrong.no} | ${totals.wrong.incomplete} |`, ''];
  for (const task of [...new Set(expected.map((e) => e.task))]) {
    const ps = patches.filter((p) => p.task === task);
    const acs = [...new Set(ps.flatMap((p) => (p.results || []).map((x) => x.ac_id)))].sort(acOrder);
    lines.push(`### ${task}`, '', `| Task | Criterion | ${ps.map((p) => p.kind).join(' | ')} |`, `| --- | --- | ${ps.map(() => '---').join(' | ')} |`);
    for (const ac of acs) lines.push(`| ${task} | ${ac} | ${ps.map((p) => (p.results ? (p.results.find((x) => x.ac_id === ac) || {}).status || '—' : '—')).join(' | ')} |`);
    lines.push(`| ${task} | **said** | ${ps.map((p) => `**${p.said}**`).join(' | ')} |`, '');
  }
  const fails = patches.flatMap((p) => (p.results || []).filter((x) => x.status === 'fail').map((x) => `${p.task} ${p.kind} ${x.ac_id}: ${String(x.detail || '').replace(/\s+/g, ' ').slice(0, 200)}`));
  if (fails.length) lines.push('<details><summary>Failure details</summary>', '', ...fails.map((f) => `- ${f}`), '', '</details>', '');
  lines.push(incomplete.length ? `Incomplete (${incomplete.length}):\n${incomplete.map((x) => `- ${x}`).join('\n')}` : 'Incomplete: none');
  return { patches, totals, incomplete, text: lines.join('\n') + '\n', exitCode: incomplete.length ? 1 : 0 };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'run') {
    const task = rest[0], repo = flag('--repo'), out = flag('--out');
    if (!TASKS.includes(task) || !repo || !out) { console.error('usage: run <task> --repo <built checkout> --out <dir>'); return 2; }
    fs.mkdirSync(out, { recursive: true });
    let rc = 0;
    for (const kind of patchKinds(task)) {
      const file = path.join(out, `${task}-${kind.replace(':', '-')}.json`);
      let rec;
      try { rec = runPatch({ task, kind, repo: path.resolve(repo) }); } catch (e) { rec = { task_id: task, patch_kind: kind, error: String(e.message || e) }; rc = 1; }
      fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
      console.log(`${task} ${kind}: ${rec.error ? `ERROR ${rec.error.split('\n')[0]}` : rec.results.map((x) => `${x.ac_id}=${x.status}`).join(' ')}`);
    }
    return rc;
  }
  if (cmd === 'summary') {
    const dir = rest[0];
    if (!dir) { console.error('usage: summary <dir> [--json <file>]'); return 2; }
    const files = fs.readdirSync(dir, { recursive: true }).filter((f) => /(^|\/)[A-Z]{2}-\d{2}-[^/]+\.json$/.test(f)).sort();
    let s;
    try {
      const records = files.map((f) => {
        let d;
        try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { throw new Error(`${f}: not JSON`); }
        if (!d || typeof d !== 'object') throw new Error(`${f}: not a JSON object`);
        return d;
      });
      s = summarize(records, TASKS.flatMap((task) => patchKinds(task).map((kind) => ({ task, kind }))));
    } catch (e) { console.error(`refused: ${e.message}`); return 2; }
    process.stdout.write(s.text);
    const json = flag('--json');
    if (json) fs.writeFileSync(json, JSON.stringify({ totals: s.totals, patches: s.patches, incomplete: s.incomplete }, null, 2) + '\n');
    return s.exitCode;
  }
  console.error('usage: kan99-scenario-matrix.js run <task> --repo <dir> --out <dir> | summary <dir> [--json <file>]');
  return 2;
}

module.exports = { TASKS, SCHEMA, loadChecks, patchKinds, truthOf, runPatch, summarize };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
