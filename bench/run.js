#!/usr/bin/env node
/**
 * bench/run.js — Quarterback Benchmark Runner
 *
 * For each task in tasks.json:
 *   1. QB run     — full L1→L2→L3→L4→L5 pipeline
 *   2. Baseline   — raw claude-code, same task description, L4 verification of result
 *
 * Both runs use the same L4 contract so verdicts are directly comparable.
 * Repo is git-reset between every run to guarantee clean state.
 *
 * Usage:
 *   node bench/run.js                      — run all tasks
 *   node bench/run.js --task T-003         — run one task
 *   node bench/run.js --no-baseline        — QB only (faster)
 *   node bench/run.js --no-llm-context     — skip L2 LLM enrichment
 */

require('dotenv').config({ path: require('path').join(__dirname, '../intent/.env') });

const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const { program } = require('commander');

const { compile }      = require('../intent/compiler');
const { buildContext } = require('../context/builder');
const { orchestrate }  = require('../agent/orchestrator');
const { verify }       = require('../verify/verifier');
const { runBaseline }  = require('./baseline');

program
  .name('bench')
  .description('Quarterback benchmark runner')
  .option('--task <id>',         'Run a single task by ID (e.g. T-003)')
  .option('--no-baseline',       'Skip baseline comparison run')
  .option('--no-llm-context',    'Skip LLM enrichment in L2 (faster)')
  .option('--max-retries <n>',   'QB repair loop max retries', '3')
  .option('--runs <n>',          'Run the entire task list N times and aggregate', '1')
  .option('--sandbox',           'Use bench/sandbox-tasks.json with fixtures/ repo')
  .parse(process.argv);

const opts = program.opts();

const tasksFile = opts.sandbox
  ? path.join(__dirname, 'sandbox-tasks.json')
  : path.join(__dirname, 'tasks.json');
const tasks = require(tasksFile);

// Resolve relative repo path
let resolvedRepoPath = tasks.meta.repo;
if (!path.isAbsolute(resolvedRepoPath)) {
  resolvedRepoPath = path.join(__dirname, '..', resolvedRepoPath); // QB root + relative
}

const RESULTS_DIR = path.join(__dirname, 'results');
const D2 = '═'.repeat(72);
const D1 = '─'.repeat(72);

async function main() {
  let taskList = tasks.tasks;
  if (opts.task) {
    taskList = taskList.filter(t => t.id === opts.task);
    if (!taskList.length) {
      console.error(`  Task ${opts.task} not found.`);
      process.exit(1);
    }
  }

  const numRuns   = Math.max(1, parseInt(opts.runs, 10) || 1);
  const repoPath  = resolvedRepoPath;

  console.log(`\n${D2}`);
  console.log(`  QUARTERBACK BENCHMARK`);
  console.log(`  Tasks: ${taskList.length}  |  Repo: ${repoPath}`);
  console.log(`  Baseline: ${opts.baseline !== false ? 'yes' : 'no'}  |  LLM context: ${opts.llmContext !== false ? 'yes' : 'no'}`);
  console.log(`  Runs: ${numRuns}  |  Mode: ${opts.sandbox ? 'sandbox' : 'standard'}`);
  console.log(`${D2}\n`);

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Multi-run tracking: task_id → array of booleans (pass/fail per run)
  const multiRunData = {};
  for (const task of taskList) multiRunData[task.id] = [];

  for (let run = 1; run <= numRuns; run++) {
    if (numRuns > 1) {
      console.log(`\n${D2}`);
      console.log(`  RUN ${run} of ${numRuns}`);
      console.log(`${D2}`);
    }

    const summary = [];

    for (const task of taskList) {
      console.log(`\n${D1}`);
      console.log(`  [${task.id}] ${task.difficulty.toUpperCase()}  — ${task.description.slice(0, 65)}`);
      console.log(D1);

      const result = { task_id: task.id, difficulty: task.difficulty, tags: task.tags, description: task.description };

      // ── Ensure repo is clean ───────────────────────────────────────────────
      resetRepo(repoPath);

      // ── QB run ─────────────────────────────────────────────────────────────
      console.log('\n  [QB] Running full pipeline...');
      result.qb = await runQB(task, repoPath);
      printQBResult(result.qb);

      // ── Reset between runs ─────────────────────────────────────────────────
      resetRepo(repoPath);

      // ── Baseline run ───────────────────────────────────────────────────────
      if (opts.baseline !== false) {
        console.log('\n  [BASE] Running raw baseline (no pipeline)...');
        result.baseline = await runBaselineTask(task, repoPath, result.qb.contract);
        printBaselineResult(result.baseline);
      }

      // ── Reset after all runs ───────────────────────────────────────────────
      resetRepo(repoPath);

      // ── Save result ────────────────────────────────────────────────────────
      const outPath = path.join(RESULTS_DIR, `${task.id}_${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`\n  Saved → ${outPath}`);

      summary.push(result);
      multiRunData[task.id].push(result.qb?.final_verdict === 'pass');
    }

    // ── Per-run summary table ────────────────────────────────────────────────
    printSummary(summary, opts.baseline !== false);
  }

  // ── Multi-run aggregate (only when --runs > 1) ────────────────────────────
  if (numRuns > 1) {
    printMultiRunSummary(taskList, multiRunData, numRuns);
  }
}

// ── Multi-run summary ─────────────────────────────────────────────────────────

function printMultiRunSummary(taskList, multiRunData, numRuns) {
  const D2 = '═'.repeat(72);
  console.log(`\n\n${D2}`);
  console.log(`  MULTI-RUN SUMMARY  (${numRuns} runs)`);
  console.log(D2);

  console.log(`\n  ${'ID'.padEnd(8)} ${'Difficulty'.padEnd(11)} ${'Passes'.padEnd(9)} ${'Mean'.padEnd(8)} ${'Std'.padEnd(8)} ${'95% CI'.padEnd(18)}`);
  console.log('  ' + '─'.repeat(66));

  const aggData = [];
  for (const task of taskList) {
    const runs    = multiRunData[task.id] || [];
    const k       = runs.filter(Boolean).length;
    const n       = runs.length;
    const mean    = n > 0 ? k / n : 0;
    // Sample std dev of Bernoulli trials
    const std     = n > 1 ? Math.sqrt(mean * (1 - mean) * n / (n - 1)) : 0;
    const [lo, hi] = wilsonCI(k, n);

    const ciStr = `[${(lo * 100).toFixed(0)}%–${(hi * 100).toFixed(0)}%]`;
    console.log(`  ${task.id.padEnd(8)} ${(task.difficulty || '?').padEnd(11)} ${`${k}/${n}`.padEnd(9)} ${(mean * 100).toFixed(1).padStart(5)}%   ${(std * 100).toFixed(1).padStart(5)}%   ${ciStr}`);

    aggData.push({ id: task.id, k, n, mean, std, lo, hi });
  }

  // Overall pass rate
  const totalPasses = aggData.reduce((s, d) => s + d.k, 0);
  const totalRuns   = aggData.reduce((s, d) => s + d.n, 0);
  const [gLo, gHi]  = wilsonCI(totalPasses, totalRuns);

  console.log('\n  ' + '─'.repeat(66));
  console.log(`  Overall QB pass rate: ${totalPasses}/${totalRuns} (${(totalPasses/totalRuns*100).toFixed(1)}%,  95% CI: [${(gLo*100).toFixed(0)}%–${(gHi*100).toFixed(0)}%])`);
  console.log(`\n${D2}\n`);

  // Save multi-run JSON
  const ts = Date.now();
  const outPath = path.join(RESULTS_DIR, `multirun_${ts}.json`);
  const doc = {
    meta: { runs: numRuns, tasks: taskList.length, created: new Date().toISOString() },
    per_task: aggData,
    overall: { passes: totalPasses, total: totalRuns, mean: totalPasses / totalRuns, ci_95: [gLo, gHi] },
  };
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2));
  console.log(`  Multi-run summary saved → ${outPath}`);
}

// ── Wilson CI (used in multi-run summary) ─────────────────────────────────────
function wilsonCI(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p      = k / n;
  const denom  = 1 + z * z / n;
  const center = (p + z * z / (2 * n)) / denom;
  const margin = (z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

// ── QB pipeline run ───────────────────────────────────────────────────────────

async function runQB(task, repoPath) {
  const maxRetries = parseInt(opts.maxRetries, 10) || 3;
  const out = { timing: {} };

  // L1
  let t = Date.now();
  const contract = await compile(task.description);
  out.timing.l1_ms = Date.now() - t;
  out.contract     = contract;
  out.ac_count     = contract.acceptance_criteria?.length || 0;
  console.log(`     L1 ${out.timing.l1_ms}ms — ${out.ac_count} ACs`);

  // L2
  t = Date.now();
  const context = await buildContext(contract, repoPath, { noLlm: !opts.llmContext });
  out.timing.l2_ms   = Date.now() - t;
  out.files_in_scope = context.relevant_files.length;
  out.symbols        = Object.keys(context.symbol_map).length;
  console.log(`     L2 ${out.timing.l2_ms}ms — ${out.files_in_scope} files, ${out.symbols} symbols`);

  // L3 + L4 repair loop
  let attempt     = 0;
  let execution   = null;
  let report      = null;
  let repairHints = [];
  const attempts  = [];

  while (attempt < maxRetries) {
    attempt++;

    // L3
    t = Date.now();
    execution = await orchestrate(contract, context, {
      agent:       'claude-code',
      repoPath,
      repairHints,
      attempt,
    });
    const l3_ms = Date.now() - t;

    // L4
    t = Date.now();
    report = await verify(contract, context, execution, { repoPath });
    const l4_ms = Date.now() - t;

    attempts.push({
      attempt,
      l3_ms,
      l4_ms,
      verdict:       report.verdict,
      files_changed: execution.changes.map(c => c.file),
      ac_results:    report.criteria_results.map(r => ({ id: r.id, met: r.met, votes: r.votes || null })),
      failures:      report.failures,
    });

    console.log(`     L3+L4 attempt ${attempt}: ${verdictIcon(report.verdict)} ${report.verdict.toUpperCase()} (${l3_ms + l4_ms}ms)`);

    if (report.verdict === 'pass') break;
    if (report.verdict === 'no-diff') break;
    if (report.failures.length === 0) break;
    if (attempt >= maxRetries) break;
    repairHints = report.repair_hints;
  }

  out.attempts        = attempts;
  out.final_verdict   = report?.verdict || 'unknown';
  out.total_attempts  = attempt;
  out.first_verdict   = attempts[0]?.verdict || 'unknown';
  out.files_changed   = attempts[attempts.length - 1]?.files_changed || [];
  out.timing.total_ms = attempts.reduce((s, a) => s + a.l3_ms + a.l4_ms, 0) + out.timing.l1_ms + out.timing.l2_ms;

  return out;
}

// ── Baseline run ──────────────────────────────────────────────────────────────

async function runBaselineTask(task, repoPath, contract) {
  const out = {};

  const t = Date.now();
  const { diff, status, duration_ms, error } = runBaseline(task.description, repoPath);
  out.agent_ms = duration_ms;
  out.status   = status;
  out.error    = error || null;

  if (!diff) {
    out.verdict       = 'no-diff';
    out.files_changed = [];
    out.timing_ms     = duration_ms;
    return out;
  }

  // Run L4 on baseline's diff using the same contract QB used
  const fakeExecution = { id: 'baseline', diff, changes: parseDiff(diff), status: 'completed' };
  const t4 = Date.now();
  const report = await verify(contract, null, fakeExecution, { repoPath });
  out.l4_ms = Date.now() - t4;

  out.verdict       = report.verdict;
  out.ac_results    = report.criteria_results.map(r => ({ id: r.id, met: r.met }));
  out.failures      = report.failures;
  out.files_changed = fakeExecution.changes.map(c => c.file);
  out.timing_ms     = duration_ms + out.l4_ms;

  return out;
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function resetRepo(repoPath) {
  try {
    execSync('git checkout -- .', { cwd: repoPath, stdio: 'pipe' });
  } catch (_) {}
  try {
    execSync('git clean -fd', { cwd: repoPath, stdio: 'pipe' });
  } catch (_) {}
}

// ── Diff parser (same as runner.js) ──────────────────────────────────────────

function parseDiff(rawDiff) {
  const changes = {};
  let cur = null;
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/b\/(.+)$/);
      if (m) { cur = m[1]; changes[cur] = { file: cur, additions: 0, deletions: 0 }; }
    } else if (cur) {
      if (line.startsWith('+') && !line.startsWith('+++')) changes[cur].additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) changes[cur].deletions++;
    }
  }
  return Object.values(changes);
}

// ── Print helpers ─────────────────────────────────────────────────────────────

function verdictIcon(v) {
  return { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○' }[v] || '?';
}

function printQBResult(r) {
  const icon = verdictIcon(r.final_verdict);
  console.log(`\n     QB  ${icon} ${r.final_verdict.toUpperCase()}  — ${r.total_attempts} attempt(s)  ${(r.timing.total_ms / 1000).toFixed(1)}s`);
  console.log(`         first attempt: ${verdictIcon(r.first_verdict)} ${r.first_verdict}`);
  if (r.files_changed.length) console.log(`         changed: ${r.files_changed.join(', ')}`);
}

function printBaselineResult(r) {
  const icon = verdictIcon(r.verdict);
  console.log(`     BASE ${icon} ${r.verdict.toUpperCase()}  — ${(r.timing_ms / 1000).toFixed(1)}s`);
  if (r.files_changed.length) console.log(`         changed: ${r.files_changed.join(', ')}`);
  if (r.failures?.length) console.log(`         failing ACs: ${r.failures.join(', ')}`);
}

function printSummary(summary, hasBaseline) {
  console.log(`\n\n${D2}`);
  console.log(`  BENCHMARK SUMMARY`);
  console.log(D2);

  const header = hasBaseline
    ? `  ${'ID'.padEnd(7)} ${'Diff'.padEnd(8)} ${'QB'.padEnd(10)} ${'1st'.padEnd(10)} ${'Tries'.padEnd(7)} ${'Time'.padEnd(8)} ${'BASE'.padEnd(10)}`
    : `  ${'ID'.padEnd(7)} ${'Diff'.padEnd(8)} ${'QB'.padEnd(10)} ${'1st'.padEnd(10)} ${'Tries'.padEnd(7)} ${'Time'.padEnd(8)}`;
  console.log(header);
  console.log('  ' + '─'.repeat(hasBaseline ? 66 : 52));

  for (const r of summary) {
    const qbVerdict   = `${verdictIcon(r.qb?.final_verdict)} ${r.qb?.final_verdict || '?'}`;
    const firstV      = `${verdictIcon(r.qb?.first_verdict)} ${r.qb?.first_verdict || '?'}`;
    const tries       = String(r.qb?.total_attempts || '?');
    const time        = r.qb?.timing?.total_ms ? `${(r.qb.timing.total_ms / 1000).toFixed(1)}s` : '?';
    const diff        = r.qb?.difficulty || '?';
    const baseVerdict = r.baseline ? `${verdictIcon(r.baseline?.verdict)} ${r.baseline?.verdict || '?'}` : 'skipped';

    const row = hasBaseline
      ? `  ${r.task_id.padEnd(7)} ${diff.padEnd(8)} ${qbVerdict.padEnd(10)} ${firstV.padEnd(10)} ${tries.padEnd(7)} ${time.padEnd(8)} ${baseVerdict}`
      : `  ${r.task_id.padEnd(7)} ${diff.padEnd(8)} ${qbVerdict.padEnd(10)} ${firstV.padEnd(10)} ${tries.padEnd(7)} ${time}`;
    console.log(row);
  }

  // Aggregate stats
  const qbPasses    = summary.filter(r => r.qb?.final_verdict === 'pass').length;
  const qbFirst     = summary.filter(r => r.qb?.first_verdict === 'pass').length;
  const basePasses  = summary.filter(r => r.baseline?.verdict === 'pass').length;
  const avgMs       = summary.reduce((s, r) => s + (r.qb?.timing?.total_ms || 0), 0) / summary.length;
  const avgAttempts = summary.reduce((s, r) => s + (r.qb?.total_attempts || 0), 0) / summary.length;

  console.log('\n  ' + '─'.repeat(hasBaseline ? 66 : 52));
  console.log(`  QB pass rate:         ${qbPasses}/${summary.length} (${Math.round(qbPasses/summary.length*100)}%)`);
  console.log(`  QB first-attempt:     ${qbFirst}/${summary.length} (${Math.round(qbFirst/summary.length*100)}%)`);
  console.log(`  QB avg attempts:      ${avgAttempts.toFixed(1)}`);
  console.log(`  QB avg time:          ${(avgMs/1000).toFixed(1)}s`);
  if (hasBaseline) {
    console.log(`  Baseline pass rate:   ${basePasses}/${summary.filter(r=>r.baseline).length} (${Math.round(basePasses/summary.filter(r=>r.baseline).length*100)}%)`);
  }
  console.log(`\n${D2}\n`);
}

main().catch(e => {
  console.error('\n  FATAL:', e.message);
  process.exit(1);
});
