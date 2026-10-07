#!/usr/bin/env node
/**
 * bench/report.js — the report for ONE experiment (QB-29).
 *
 *   node bench/report.js <experiment-dir> [--format table|markdown|json] [--allow-mixed]
 *   node bench/report.js --legacy bench/results [--format table|markdown|json]
 *
 * - Input is one experiment directory (bench/experiment.js). Every artifact is re-hashed
 *   before use; a mismatch or missing file stops the report, naming it.
 * - Mixed versions are refused by default: a result from another experiment, a trial not
 *   in the plan, or a grade made against another spec version / grader / patch.
 *   `--allow-mixed` reports them anyway, labelled MIXED with every reason listed.
 * - Only external grades `pass` / `fail` are scores. Everything else — needs_adjudication,
 *   grader_error, grade infra_error, ungraded, agent_error, timeout, trial infra_error,
 *   missing, incomplete, not recorded — is attrition, reported per arm, never a win or a loss.
 *   QB's own L4 verdict (`internal_verdict`) is shown separately and never scored.
 * - The primary comparison uses matched pairs only (same task + repetition, both arms scored).
 * - Output is a pure function of the stored files: no clock, stable ordering, so the same
 *   experiment always gives byte-identical output. (Re-running agents is NOT reproducible.)
 * - The old bench/results/*.json files are shown only with --legacy, per file, labelled
 *   "pre-QB-29, not comparable", never deduplicated, merged or aggregated.
 *
 * Statistics beyond counts (the cluster bootstrap over tasks/repositories) are QB-30;
 * `per_task` is structured for it.
 */

const fs = require('fs');
const path = require('path');
const S = require('./schemas');
const { loadExperiment, graderHash, diffPaths, fingerprintPins } = require('./experiment');

const ARM_ORDER = S.ARM_IDS;
const ATTRITION = ['needs_adjudication', 'grader_error', 'grade_infra_error', 'ungraded', 'agent_error', 'timeout', 'trial_infra_error', 'missing', 'incomplete', 'not_recorded'];

const byArm = (a, b) => ARM_ORDER.indexOf(a) - ARM_ORDER.indexOf(b);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Why a loaded trial result does not belong to this experiment's pinned versions. */
function mixedReasons(m, t) {
  const out = [];
  const where = `trials/${t.trial_id}/${t.arm}`;
  if (t.experiment_id !== m.experiment_id) out.push(`${where}: belongs to experiment ${t.experiment_id}`);
  const planned = m.trial_plan.order.find((o) => o.trial_id === t.trial_id && o.arm === t.arm);
  if (!planned) out.push(`${where}: not in the trial plan`);
  else if (planned.task_id !== t.task_id || planned.repetition !== t.repetition) out.push(`${where}: task/repetition differ from the plan`);
  const task = m.tasks.find((x) => x.id === t.task_id);
  if (!task) out.push(`${where}: task ${t.task_id} is not in the manifest`);
  if (t.grade) {
    if (t.grade.task_id !== t.task_id) out.push(`${where}: grade is for task ${t.grade.task_id}`);
    if (task && t.grade.spec_sha256 !== task.spec_sha256) out.push(`${where}: graded against spec ${t.grade.spec_sha256.slice(0, 12)}…, manifest pins ${task.spec_sha256.slice(0, 12)}…`);
    if (t.grade.grader_sha256 !== graderHash(m.pins.grader.files)) out.push(`${where}: graded by an unpinned grader ${t.grade.grader_sha256.slice(0, 12)}…`);
    const patch = t.artifacts['patch.diff'];
    if (!patch) out.push(`${where}: graded without its patch`);
    else if (t.grade.patch_sha256 !== patch.sha256) out.push(`${where}: grade is for another patch`);
  }
  // QB-29 re-review: homogeneity is proven from each trial's own recorded runtime, not from
  // the experiment id it cites.
  const drift = t.runtime && t.runtime.schema === 'qb-runtime/1' ? diffPaths(m.pins, fingerprintPins(t.runtime)) : ['(no qb-runtime/1 fingerprint)'];
  if (drift.length) out.push(`${where}: runtime fingerprint differs from the manifest pins (${drift.join(', ')})`);
  return out;
}

function categorize(t) {
  if (!t) return 'not_recorded';
  if (t.incomplete) return 'incomplete';
  if (t.status !== 'completed') return t.status === 'infra_error' ? 'trial_infra_error' : t.status;
  if (!t.grade) return 'ungraded';
  if (t.grade.outcome === 'infra_error') return 'grade_infra_error';
  return t.grade.outcome;   // pass | fail | needs_adjudication | grader_error
}

/** The report as data (deterministic). Throws on tampering, or on mixed versions unless allowMixed. */
function reportData(expDir, { allowMixed = false } = {}) {
  const exp = loadExperiment(expDir);
  const m = exp.manifest;
  const mixed = [];
  for (const t of exp.trials) mixed.push(...mixedReasons(m, t));
  for (const inc of exp.incomplete) {
    if (!m.trial_plan.order.some((o) => o.trial_id === inc.trial_id && o.arm === inc.arm)) mixed.push(`${inc.dir}: incomplete record not in the trial plan`);
  }
  mixed.sort(cmpStr);
  if (mixed.length && !allowMixed) {
    throw new Error(`mixed versions refused (use --allow-mixed to report them labelled MIXED):\n  ${mixed.join('\n  ')}`);
  }

  // One cell per (task, repetition, arm): planned cells first, then (allowMixed only) extras.
  const cells = new Map();
  const key = (task, rep, arm) => `${task}\u0000${rep}\u0000${arm}`;
  for (const o of m.trial_plan.order) cells.set(key(o.task_id, o.repetition, o.arm), { trial_id: o.trial_id, task_id: o.task_id, repetition: o.repetition, arm: o.arm, planned: true, t: null });
  for (const inc of exp.incomplete) {
    const o = m.trial_plan.order.find((x) => x.trial_id === inc.trial_id && x.arm === inc.arm);
    if (o) cells.get(key(o.task_id, o.repetition, o.arm)).t = { incomplete: true };
  }
  for (const t of exp.trials) {
    const k = key(t.task_id, t.repetition, t.arm);
    const c = cells.get(k);
    if (c && c.trial_id === t.trial_id && !c.t) c.t = t;
    else cells.set(`${k}\u0000${t.experiment_id}\u0000${t.trial_id}`, { trial_id: t.trial_id, task_id: t.task_id, repetition: t.repetition, arm: t.arm, planned: false, t });
  }

  const rows = [...cells.values()].map((c) => {
    const t = c.t && !c.t.incomplete ? c.t : null;
    // Defense in depth (loadExperiment already refuses it): a score without its patch is not a score.
    const category = t && t.grade && !t.artifacts['patch.diff'] ? 'missing_patch' : categorize(c.t);
    return {
      trial_id: c.trial_id, task_id: c.task_id, repetition: c.repetition, arm: c.arm, planned: c.planned,
      experiment_id: t ? t.experiment_id : m.experiment_id,
      category,
      score: category === 'pass' || category === 'fail' ? category : null,
      internal_verdict: t ? t.internal_verdict : null,
      grade_reason: t && t.grade ? t.grade.reason : null,
      patch: t && t.artifacts['patch.diff'] ? t.artifacts['patch.diff'].path : null,
      grade: t && t.artifacts['grade.json'] ? t.artifacts['grade.json'].path : null,
    };
  }).sort((a, b) => cmpStr(a.task_id, b.task_id) || a.repetition - b.repetition || byArm(a.arm, b.arm) || cmpStr(a.experiment_id, b.experiment_id) || cmpStr(a.trial_id, b.trial_id));

  const armIds = [...new Set([...m.arms.map((a) => a.id), ...rows.map((r) => r.arm)])].sort(byArm);
  const arms = {};
  for (const a of armIds) {
    const mine = rows.filter((r) => r.arm === a);
    const attrition = Object.fromEntries(ATTRITION.map((c) => [c, mine.filter((r) => r.category === c).length]));
    const internal = {};
    for (const r of mine) if (r.internal_verdict !== null) internal[r.internal_verdict] = (internal[r.internal_verdict] || 0) + 1;
    arms[a] = {
      planned: mine.filter((r) => r.planned).length,
      scored: mine.filter((r) => r.score).length,
      pass: mine.filter((r) => r.score === 'pass').length,
      fail: mine.filter((r) => r.score === 'fail').length,
      attrition,
      internal_verdicts: Object.fromEntries(Object.entries(internal).sort(([x], [y]) => cmpStr(x, y))),
    };
  }

  // Matched pairs for the primary comparison.
  const [X, Y] = m.primary_comparison;
  const groups = new Map();
  for (const r of rows) {
    const g = `${r.task_id}\u0000${r.repetition}`;
    if (!groups.has(g)) groups.set(g, { task_id: r.task_id, repetition: r.repetition, arms: {} });
    if (!groups.get(g).arms[r.arm]) groups.get(g).arms[r.arm] = r;
  }
  const pairs = { count: 0, both_pass: 0, both_fail: 0, [`only_${X}`]: 0, [`only_${Y}`]: 0, unmatched: [] };
  const perTask = new Map();
  for (const g of [...groups.values()].sort((a, b) => cmpStr(a.task_id, b.task_id) || a.repetition - b.repetition)) {
    const x = g.arms[X]; const y = g.arms[Y];
    if (!perTask.has(g.task_id)) perTask.set(g.task_id, { task_id: g.task_id, repetitions: [], matched: 0, pass: { [X]: 0, [Y]: 0 } });
    const pt = perTask.get(g.task_id);
    pt.repetitions.push({ repetition: g.repetition, [X]: x ? x.category : 'not_planned', [Y]: y ? y.category : 'not_planned' });
    if (x && y && x.score && y.score) {
      pairs.count++; pt.matched++;
      if (x.score === 'pass') pt.pass[X]++;
      if (y.score === 'pass') pt.pass[Y]++;
      if (x.score === 'pass' && y.score === 'pass') pairs.both_pass++;
      else if (x.score === 'fail' && y.score === 'fail') pairs.both_fail++;
      else if (x.score === 'pass') pairs[`only_${X}`]++;
      else pairs[`only_${Y}`]++;
    } else {
      pairs.unmatched.push({ task_id: g.task_id, repetition: g.repetition, [X]: x ? x.category : 'not_planned', [Y]: y ? y.category : 'not_planned' });
    }
  }

  const task = (id) => m.tasks.find((t) => t.id === id);
  return {
    schema: 'qb-report/1',
    experiment_id: m.experiment_id,
    kind: m.kind,
    mixed: mixed.length > 0,
    mixed_reasons: mixed,
    guarantees: 'Reproducible reporting: this report is regenerated byte-for-byte from the stored, hash-verified artifacts. Execution is not reproducible: re-running an agent from the same manifest may produce a different patch (a new trial). Hashes detect corruption/tampering unless the recorded hash is rewritten too; they are not signatures.',
    pins: {
      qb_commit: m.pins.qb.commit,
      qb_dirty: m.pins.qb.dirty,
      dirty_patch_sha256: m.pins.qb.dirty_patch_sha256,
      agent: m.pins.agent,
      images: m.pins.images,
      node: m.pins.node,
      grader_sha256: graderHash(m.pins.grader.files),
      config_sha256: m.config_sha256,
    },
    tasks: m.tasks.map((t) => ({ id: t.id, version: t.version, split: t.split, spec_sha256: t.spec_sha256 })).sort((a, b) => cmpStr(a.id, b.id)),
    budget: m.budget,
    primary_comparison: [X, Y],
    arms,
    matched_pairs: pairs,
    per_task: [...perTask.values()].map((pt) => ({ ...pt, split: task(pt.task_id) ? task(pt.task_id).split : null })),
    rows,
  };
}

// ── Formatting ────────────────────────────────────────────────────────────────

function lines(d, md) {
  const L = [];
  const [X, Y] = d.primary_comparison;
  const h = (t) => L.push(md ? `## ${t}` : `\n${t}\n${'─'.repeat(t.length)}`);
  L.push(md ? `# Experiment ${d.experiment_id}${d.mixed ? ' — MIXED' : ''}` : `QUARTERBACK EXPERIMENT REPORT — ${d.experiment_id}${d.mixed ? '  [MIXED]' : ''}`);
  L.push('');
  if (d.mixed) {
    L.push(`MIXED: this report includes results that do not match the experiment's pinned versions:`);
    for (const r of d.mixed_reasons) L.push(`- ${r}`);
    L.push('');
  }
  L.push(`Kind: ${d.kind}. QB ${d.pins.qb_commit.slice(0, 12)}${d.pins.qb_dirty ? ` + archived dirty diff ${d.pins.dirty_patch_sha256.slice(0, 12)}` : ''}; agent ${d.pins.agent.adapter_version} (CLI ${d.pins.agent.cli_version}); Node ${d.pins.node}; grader ${d.pins.grader_sha256.slice(0, 12)}; config ${d.pins.config_sha256.slice(0, 12)}.`);
  L.push(`Images: ${Object.entries(d.pins.images).map(([n, i]) => `${n} ${i.digest}`).join(', ') || 'none pinned'}.`);
  L.push(`Budget: equal agent-time ${d.budget.agent_time_ms} ms per arm; trial deadline ${d.budget.trial_deadline_ms} ms; total compute NOT controlled.`);
  L.push(d.guarantees);
  L.push('');

  h('Arms (only external pass/fail grades are scores)');
  const cols = ['arm', 'planned', 'scored', 'pass', 'fail', ...ATTRITION];
  if (md) { L.push(`| ${cols.join(' | ')} |`); L.push(`|${cols.map(() => '---').join('|')}|`); }
  else L.push(cols.join('\t'));
  for (const [a, s] of Object.entries(d.arms)) {
    const vals = [a, s.planned, s.scored, s.pass, s.fail, ...ATTRITION.map((c) => s.attrition[c])];
    L.push(md ? `| ${vals.join(' | ')} |` : vals.join('\t'));
  }
  L.push('');
  L.push(`Internal QB verdicts (recorded, never scored): ${Object.entries(d.arms).map(([a, s]) => `${a} ${JSON.stringify(s.internal_verdicts)}`).join('; ')}`);
  L.push('');

  h(`Primary comparison ${X} vs ${Y} — matched pairs only`);
  const p = d.matched_pairs;
  L.push(`Matched pairs: ${p.count} (both pass ${p.both_pass}, both fail ${p.both_fail}, only ${X} ${p[`only_${X}`]}, only ${Y} ${p[`only_${Y}`]}).`);
  L.push(`Unmatched (excluded from the comparison, counted above as attrition): ${p.unmatched.length}`);
  for (const u of p.unmatched) L.push(`${md ? '- ' : '  '}${u.task_id} r${u.repetition}: ${X} ${u[X]}, ${Y} ${u[Y]}`);
  L.push('');

  h('Trials (each score links to its patch and grade)');
  const rc = ['task', 'rep', 'arm', 'trial', 'category', 'score', 'internal', 'patch', 'grade'];
  if (md) { L.push(`| ${rc.join(' | ')} |`); L.push(`|${rc.map(() => '---').join('|')}|`); }
  else L.push(rc.join('\t'));
  for (const r of d.rows) {
    const vals = [r.task_id, r.repetition, r.arm, `${r.trial_id}${r.planned ? '' : ' (unplanned)'}`, r.category, r.score || '—', r.internal_verdict || '—', r.patch || '—', r.grade || '—'];
    L.push(md ? `| ${vals.join(' | ')} |` : vals.join('\t'));
  }
  return `${L.join('\n')}\n`;
}

/** The report text for one experiment directory (deterministic). */
function buildReport(expDir, { format = 'table', allowMixed = false } = {}) {
  const d = reportData(expDir, { allowMixed });
  if (format === 'json') return `${JSON.stringify(d, null, 2)}\n`;
  if (format === 'markdown') return lines(d, true);
  if (format === 'table') return lines(d, false);
  throw new Error(`unknown format: ${format}`);
}

// ── Legacy (pre-QB-29) results ────────────────────────────────────────────────

const LEGACY_LABEL = 'LEGACY RESULTS — pre-QB-29, not comparable: no pinned versions, graded against QB-generated contracts, no external grader. Shown per file; never deduplicated, merged or aggregated.';

function legacyData(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const entries = [];
  for (const f of files) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { entries.push({ file: f, unreadable: true }); continue; }
    if (!r || typeof r !== 'object' || !r.task_id) { entries.push({ file: f, skipped: 'not a per-task result (e.g. an old multi-run summary)' }); continue; }
    entries.push({
      file: f,
      task_id: r.task_id,
      qb_internal_verdict: r.qb && r.qb.final_verdict ? r.qb.final_verdict : null,
      baseline_internal_verdict: r.baseline ? (r.baseline.verdict || null) : 'not run',
      contract_sha256: r.qb && r.qb.contract ? S.hashOf(r.qb.contract) : null,
    });
  }
  return { schema: 'qb-legacy-report/1', comparable: false, label: LEGACY_LABEL, entries };
}

function legacyReport(dir, { format = 'table' } = {}) {
  const d = legacyData(dir);
  if (format === 'json') return `${JSON.stringify(d, null, 2)}\n`;
  const md = format === 'markdown';
  const L = [md ? `# ${d.label}` : d.label, ''];
  const cols = ['file', 'task', 'qb internal verdict', 'baseline internal verdict', 'contract'];
  if (md) { L.push(`| ${cols.join(' | ')} |`); L.push(`|${cols.map(() => '---').join('|')}|`); } else L.push(cols.join('\t'));
  for (const e of d.entries) {
    const vals = e.unreadable ? [e.file, 'unreadable', '', '', ''] : e.skipped ? [e.file, `skipped: ${e.skipped}`, '', '', '']
      : [e.file, e.task_id, e.qb_internal_verdict || '—', e.baseline_internal_verdict || '—', e.contract_sha256 ? e.contract_sha256.slice(0, 12) : '—'];
    L.push(md ? `| ${vals.join(' | ')} |` : vals.join('\t'));
  }
  return `${L.join('\n')}\n`;
}

module.exports = { buildReport, reportData, legacyReport, legacyData, LEGACY_LABEL };

if (require.main === module) {
  const { program } = require('commander');
  program
    .name('report')
    .argument('[experiment-dir]', 'one experiment directory (bench/experiments/<id>)')
    .option('--format <type>', 'table | markdown | json', 'table')
    .option('--allow-mixed', 'report results with mismatched versions, labelled MIXED')
    .option('--legacy <dir>', 'show pre-QB-29 bench/results files, labelled not comparable')
    .parse(process.argv);
  const o = program.opts();
  try {
    if (o.legacy) process.stdout.write(legacyReport(path.resolve(o.legacy), { format: o.format }));
    else if (program.args[0]) process.stdout.write(buildReport(path.resolve(program.args[0]), { format: o.format, allowMixed: Boolean(o.allowMixed) }));
    else { console.error('usage: node bench/report.js <experiment-dir> [--format …] [--allow-mixed]   |   --legacy <results-dir>'); process.exit(2); }
  } catch (e) { console.error(`report refused: ${e.message}`); process.exit(1); }
}
