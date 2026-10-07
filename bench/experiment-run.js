#!/usr/bin/env node
/**
 * bench/experiment-run.js — run an experiment (QB-28): every planned (trial, arm) through
 * the one arm API (bench/arms.js), every arm graded by the same external grader
 * (bench/grader.js), every result recorded immutably (bench/experiment.js).
 *
 *   node bench/experiment-run.js --config <experiment-config.json> [--out bench/experiments]
 *
 * Config: { kind, specs: [<spec file>…], arms: ["A","E",…], primary: ["A","E"], repetitions,
 *   budget: { agent_time_ms, trial_deadline_ms, model_call_deadline_ms }, seed?, order?,
 *   memory_start?: <dir>, protocol?: { path }, approval? }
 *
 * Each arm-trial: a fresh checkout of the spec's pinned base, its own run record, its own
 * budget run with the per-trial deadline, then the grader. An arm that throws is recorded
 * with its status (timeout / infra_error) — attrition is never dropped.
 */

const fs = require('fs');
const path = require('path');
const { createWorkspace } = require('../lib/workspace');
const runStore = require('../run/store');
const budget = require('../lib/budget');
const { AGENT_VERSION } = require('../lib/sandbox/agent');
const { createExperiment, recordTrial, readManifest } = require('./experiment');
const { ARMS, runArm } = require('./arms');
const { grade, GRADER_FILES } = require('./grader');
const { checkFrozen } = require('./spec');
const S = require('./schemas');

const AGENT = { type: 'claude-code', version: AGENT_VERSION, isolation: 'sandbox' };

/** Manifest task entries for frozen specs. */
function taskEntries(specs) {
  return specs.map((s) => ({ id: s.id, version: s.version, spec_sha256: S.specHash(s), split: s.split, repo_commit: s.repo.base_rev, lockfiles: s.repo.lockfiles }));
}

/** The exact arm definitions (bench/arms.js) — a manifest cannot redefine an arm. */
function armDefinitions(ids) {
  return ids.map((id) => { if (!ARMS[id]) throw new Error(`unknown arm ${id}`); return { ...ARMS[id] }; });
}

/** Map the honest qb-usage/1 record onto the trial's usage (unknown stays unknown). */
function trialUsage(u, agentMs) {
  const m = u.model;
  // Every arm runs the coding agent, which reports no tokens (QB-21), so a trial's total
  // tokens are unknown; QB's own model tokens, when reported, stay in usage.json.
  const tokens = 'unknown';
  const returned = Object.keys(m.models_reported).map((name) => ({ role: 'qb-model', requested: m.configured, returned: name }));
  if (m.attempted > 0 && !returned.length) returned.push({ role: 'qb-model', requested: m.configured, returned: 'unknown' });
  returned.push({ role: 'agent', requested: 'claude-code', returned: 'unknown' });
  return {
    agent_ms: agentMs,
    model_calls: m.attempted,
    tokens,
    cost_usd: u.cost.total.usd === null ? 'unknown' : u.cost.total.usd,
    human_approval_ms: 'unknown',             // the oracle was approved when the spec was frozen; not timed
    models_returned: returned,
  };
}

/**
 * Run every planned trial/arm of an experiment that is not yet recorded.
 * @param {string} expDir
 * @param {object} o  { specs: { [taskId]: spec }, memoryStart?: dir, runsDir?, runSandboxed?, grader?: {…}, deps? }
 */
async function runExperiment(expDir, o) {
  const m = readManifest(expDir);
  for (const t of m.tasks) {
    const spec = o.specs[t.id];
    if (!spec || S.specHash(spec) !== t.spec_sha256) throw new Error(`spec for ${t.id} does not match the manifest`);
  }
  for (const a of m.arms) {
    if (S.hashOf(a) !== S.hashOf(ARMS[a.id])) throw new Error(`arm ${a.id} in the manifest differs from the arm table`);
  }
  if (o.memoryStart ? S.treeHash(o.memoryStart) !== m.memory.starting_store_sha256 : m.memory.starting_store_sha256 !== null) {
    throw new Error('starting memory store does not match the manifest');
  }
  const results = [];
  for (const p of m.trial_plan.order) {
    if (fs.existsSync(path.join(expDir, 'trials', p.trial_id, p.arm, 'result.json'))) continue;   // recorded
    const spec = o.specs[p.task_id];
    const started = new Date();
    let ws = null; let run = null; let out; let usage = null;
    const budgetRun = budget.startRun({ deadlineMs: m.budget.trial_deadline_ms, agent: AGENT });
    try {
      ws = createWorkspace(spec.repo.source, { baseRev: spec.repo.base_rev, label: `${p.task_id}-${p.arm}` });
      run = runStore.createRun({ kind: 'bench-arm', request: spec.prompt, repoPath: ws.dir, baseSha: ws.baseSha, agent: AGENT,
        config: { experiment_id: m.experiment_id, trial_id: p.trial_id, arm: p.arm, task_id: p.task_id }, runsDir: o.runsDir });
      out = await runArm({ arm: p.arm, spec, repoPath: ws.dir, run, budgetRun, baseSha: ws.baseSha, agentTimeMs: m.budget.agent_time_ms,
        memoryStart: ARMS[p.arm].memory === 'on' ? { store: o.memoryStart || null, sha256: m.memory.starting_store_sha256 } : null,
        runSandboxed: o.runSandboxed, deps: o.deps, signal: budgetRun.signal });
      // The run record keeps QB's own outcome (E/F) — the SCORE is the external grade below.
      if (out.status !== 'completed') run.finish('ERROR', { reason: out.detail || out.status });
      else if (out.internal_verdict) run.finish(runStore.outcomeFor(out.internal_verdict), { legacy_verdict: out.internal_verdict, reason: 'internal verdict; scored by the external grader' });
      else run.finish('UNRESOLVED', { reason: 'no internal verdict (native arm); scored by the external grader' });
    } catch (e) {
      const timedOut = e && (e.code === 'DEADLINE' || /deadline/i.test(String(e.message)));
      out = { status: timedOut ? 'timeout' : 'infra_error', detail: String(e && e.message).slice(0, 500), patch: '', attempts: 0, agent_ms: 0, internal_verdict: null,
        memory: { mode: ARMS[p.arm].memory, store_sha256_before: ARMS[p.arm].memory === 'on' ? m.memory.starting_store_sha256 : null, recall_calls: 0, persist_calls: 0 } };
      if (run) { try { run.abort('ERROR', out.detail); } catch { /* closed */ } }
    } finally {
      usage = budgetRun.usage();
      budget.endRun();
      if (ws) ws.cleanup();
    }
    // QB-27: the same external grader for every arm; nothing about the arm reaches it.
    const g = out.status === 'completed' ? await grade({ spec, patch: out.patch, ...(o.grader || {}) }) : null;
    const finished = new Date();
    const artifacts = { 'patch.diff': out.patch || '', 'usage.json': usage };
    if (g) artifacts['grade.json'] = g;
    if (run) artifacts['run.json'] = { run_id: run.id, outcome: run.manifest.outcome, attempts: run.manifest.attempts.length };
    results.push(recordTrial(expDir, {
      experiment_id: m.experiment_id, trial_id: p.trial_id, task_id: p.task_id, repetition: p.repetition, arm: p.arm,
      status: out.status, ...(out.detail ? { detail: out.detail } : {}),
      started_at: started.toISOString(), finished_at: finished.toISOString(), elapsed_ms: finished - started,
      internal_verdict: out.internal_verdict ?? null, grade_outcome: g ? g.outcome : null,
      usage: trialUsage(usage, out.agent_ms || 0), memory: out.memory,
    }, artifacts));
  }
  return results;
}

async function main(argv) {
  const { program } = require('commander');
  program.name('experiment-run').requiredOption('--config <file>').option('--out <dir>', 'experiments root', path.join(__dirname, 'experiments')).parse(argv);
  const opts = program.opts();
  const cfgFile = path.resolve(opts.config);
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  const specs = (cfg.specs || []).map((f) => JSON.parse(fs.readFileSync(path.resolve(path.dirname(cfgFile), f), 'utf8')));
  for (const s of specs) checkFrozen(s);
  const protocol = cfg.protocol ? { path: cfg.protocol.path, sha256: S.sha256File(path.resolve(path.dirname(cfgFile), cfg.protocol.path)) } : null;
  const memoryStart = cfg.memory_start ? path.resolve(path.dirname(cfgFile), cfg.memory_start) : null;
  const { dir } = createExperiment({
    dir: path.resolve(opts.out), kind: cfg.kind, tasks: taskEntries(specs), arms: armDefinitions(cfg.arms),
    primary_comparison: cfg.primary, budget: { ...cfg.budget, total_compute_controlled: false },
    repetitions: cfg.repetitions || 1, seed: cfg.seed || 'none', order: cfg.order, config: cfg, protocol, approval: cfg.approval || null,
    memory: { starting_store_sha256: memoryStart ? S.treeHash(memoryStart) : null }, graderFiles: GRADER_FILES,
    models: [{ role: 'qb-model', requested: process.env.QB_MODEL || 'deepseek-r1:7b' }],
  });
  console.log(`experiment ${dir}`);
  await runExperiment(dir, { specs: Object.fromEntries(specs.map((s) => [s.id, s])), memoryStart });
  console.log(`done — report: node bench/report.js ${dir}`);
}

if (require.main === module) main(process.argv).catch((e) => { console.error(`experiment-run: ${e.message}`); process.exit(1); });

module.exports = { runExperiment, taskEntries, armDefinitions, trialUsage };
