/**
 * bench/stats.js — the predeclared analysis (QB-30, docs/bench/protocol.md).
 *
 * Statistical unit: the TASK. Repeated trials are nested within a task and tasks are
 * grouped by repository, so trials are never treated as independent observations.
 *
 *   task effect   d_t = (passes of Y − passes of X) / matched pairs, over that task's
 *                 matched repetitions (both arms scored); a task with no matched pair has
 *                 no effect and is reported as unmatched — never as 0
 *   estimate      the mean of task effects (each task weighs the same, however many trials)
 *   uncertainty   a two-stage CLUSTER BOOTSTRAP: resample repositories with replacement, then
 *                 tasks within each sampled repository with replacement; percentile 95% CI.
 *                 Seeded from the experiment, so the report stays byte-reproducible.
 *
 *   operational   success per ASSIGNED repetition: over the repetitions planned for both arms,
 *                 anything but a pass (fail, agent error, timeout, infra/grader error, missing)
 *                 counts as no success. The complete-case primary drops a pair when either arm
 *                 has no score, so an arm that errors out on hard tasks could look better among
 *                 its surviving runs; this endpoint is reported next to it, with the same bootstrap.
 *
 * Ordinary McNemar over all trial rows is deliberately NOT used: it treats repeated trials
 * of one task as independent and overstates the evidence.
 */

const S = require('./schemas');

const B_DEFAULT = 2000;

function rng(seed) {
  let a = parseInt(S.sha256(Buffer.from(String(seed))).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x) => (x === null ? null : Math.round(x * 10000) / 10000);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Per-task paired effects of Y over X from report rows ({ task_id, repetition, arm, score }).
 * @returns {Array<{ task_id, matched, pass_x, pass_y, effect }>}
 */
function taskEffects(rows, X, Y) {
  const byTask = new Map();
  const key = (r) => `${r.task_id}\0${r.repetition}`;
  const reps = new Map();
  for (const r of rows) {
    if (!reps.has(key(r))) reps.set(key(r), { task_id: r.task_id, arms: {} });
    reps.get(key(r)).arms[r.arm] = r;
  }
  for (const g of reps.values()) {
    const x = g.arms[X]; const y = g.arms[Y];
    if (!byTask.has(g.task_id)) byTask.set(g.task_id, { task_id: g.task_id, matched: 0, pass_x: 0, pass_y: 0 });
    const t = byTask.get(g.task_id);
    if (x && y && x.score && y.score) {
      t.matched++;
      if (x.score === 'pass') t.pass_x++;
      if (y.score === 'pass') t.pass_y++;
    }
  }
  return [...byTask.values()].sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
    .map((t) => ({ ...t, effect: t.matched ? round((t.pass_y - t.pass_x) / t.matched) : null }));
}

/**
 * Per-task operational effects of Y over X: success per repetition assigned (planned) to both arms.
 * @returns {Array<{ task_id, assigned, success_x, success_y, effect }>}
 */
function operationalEffects(rows, X, Y) {
  const reps = new Map();
  for (const r of rows) {
    if (!r.planned) continue;
    const k = `${r.task_id}\0${r.repetition}`;
    if (!reps.has(k)) reps.set(k, { task_id: r.task_id, arms: {} });
    reps.get(k).arms[r.arm] = r;
  }
  const byTask = new Map();
  for (const g of reps.values()) {
    const x = g.arms[X]; const y = g.arms[Y];
    if (!x || !y) continue;
    if (!byTask.has(g.task_id)) byTask.set(g.task_id, { task_id: g.task_id, assigned: 0, success_x: 0, success_y: 0 });
    const t = byTask.get(g.task_id);
    t.assigned++;
    if (x.score === 'pass') t.success_x++;
    if (y.score === 'pass') t.success_y++;
  }
  return [...byTask.values()].sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0))
    .map((t) => ({ ...t, effect: round((t.success_y - t.success_x) / t.assigned) }));
}

/**
 * Two-stage cluster bootstrap of the mean task effect.
 * @param {Array<{ task_id, repository, effect }>} effects  tasks with an effect (matched ≥ 1)
 */
function clusterBootstrap(effects, { B = B_DEFAULT, seed }) {
  const usable = effects.filter((e) => e.effect !== null);
  const repos = [...new Set(usable.map((e) => e.repository))].sort();
  const byRepo = Object.fromEntries(repos.map((r) => [r, usable.filter((e) => e.repository === r).map((e) => e.effect)]));
  const estimate = round(mean(usable.map((e) => e.effect)));
  if (!usable.length) return { method: 'cluster bootstrap (repositories, then tasks)', estimate: null, ci95: null, B, n_tasks: 0, n_repositories: 0, note: 'no task has a matched pair' };
  const r = rng(seed);
  const stats = [];
  for (let b = 0; b < B; b++) {
    const sample = [];
    for (let i = 0; i < repos.length; i++) {
      const tasks = byRepo[repos[Math.floor(r() * repos.length)]];
      for (let j = 0; j < tasks.length; j++) sample.push(tasks[Math.floor(r() * tasks.length)]);
    }
    stats.push(mean(sample));
  }
  stats.sort((a, b) => a - b);
  const q = (p) => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(p * stats.length)))];
  return {
    method: 'cluster bootstrap (repositories, then tasks)',
    estimate, ci95: [round(q(0.025)), round(q(0.975))], B, seed: String(seed),
    n_tasks: usable.length, n_repositories: repos.length,
    ...(repos.length < 2 ? { note: 'fewer than 2 repositories: the interval reflects task resampling within one repository only and does not generalize across repositories' } : {}),
  };
}

/**
 * The predeclared analysis for an experiment's report data.
 * @param {object} d   reportData() output (rows, arms, primary_comparison)
 * @param {object} m   the manifest (tasks with stratum, arms, seed)
 */
function analyze(d, m) {
  const [X, Y] = d.primary_comparison;
  const stratum = (id) => { const t = m.tasks.find((x) => x.id === id); return (t && t.stratum) || { type: 'unknown', repository: 'unknown' }; };
  const seed = `${m.experiment_id}\0${m.trial_plan.seed}`;
  const effectsFor = (A, Bm) => taskEffects(d.rows, A, Bm).map((e) => ({ ...e, ...stratum(e.task_id) }));
  const primaryTasks = effectsFor(X, Y);
  const primary = { comparison: [X, Y], role: 'primary (predeclared)', tasks: primaryTasks,
    unmatched_tasks: primaryTasks.filter((t) => t.effect === null).map((t) => t.task_id),
    ...clusterBootstrap(primaryTasks, { seed: `${seed}\0${X}\0${Y}` }) };
  const operationalTasks = operationalEffects(d.rows, X, Y).map((e) => ({ ...e, ...stratum(e.task_id) }));
  const operational = { comparison: [X, Y], role: 'operational (predeclared; attrition counts as no success)', tasks: operationalTasks,
    ...clusterBootstrap(operationalTasks, { seed: `${seed}\0operational\0${X}\0${Y}` }) };
  const secondary = m.arms.map((a) => a.id).filter((a) => a !== X && a !== Y).map((Z) => {
    const tasks = effectsFor(X, Z);
    return { comparison: [X, Z], role: 'secondary (exploratory ablation)', n_tasks: tasks.filter((t) => t.effect !== null).length,
      ...clusterBootstrap(tasks, { seed: `${seed}\0${X}\0${Z}` }) };
  });
  const strata = (field) => {
    const groups = [...new Set(primaryTasks.map((t) => t[field]))].sort();
    return groups.map((g) => {
      const ts = primaryTasks.filter((t) => t[field] === g);
      const eff = ts.filter((t) => t.effect !== null);
      return { [field]: g, tasks: ts.length, tasks_matched: eff.length, mean_effect: round(mean(eff.map((t) => t.effect))) };
    });
  };
  const completion = Object.fromEntries(Object.entries(d.arms).map(([a, s]) => [a, {
    planned: s.planned, scored: s.scored, completion_rate: s.planned ? round(s.scored / s.planned) : null,
    pass_rate_of_scored: s.scored ? round(s.pass / s.scored) : null, attrition: s.attrition,
  }]));
  return {
    unit: 'task (trials nested within tasks; tasks grouped by repository)',
    not_used: 'McNemar over trial rows (treats repeated trials as independent)',
    primary, operational, secondary, strata: { by_type: strata('type'), by_repository: strata('repository') }, completion,
  };
}

module.exports = { taskEffects, operationalEffects, clusterBootstrap, analyze, B_DEFAULT };
