#!/usr/bin/env node
/**
 * bench/run.js — the LEGACY exploratory runner (QB pipeline vs a raw baseline).
 *
 * Official experiments use bench/experiment-run.js (QB-28): arms A–F through one API,
 * equal agent-time budgets, memory isolation, the external grader (QB-27) and immutable
 * experiment records (QB-29). This runner remains for exploration: tasks without a frozen
 * spec are "ungraded", the QB arm runs lib/qb-pipeline.js (the code qb.js runs) with memory
 * off, and its internal verdicts are never scores.
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
const { program } = require('commander');

const { compile }      = require('../intent/compiler');
const { verify }       = require('../verify/verifier');
const budget = require('../lib/budget');
const { defaultJudgeCacheDir } = require('../verify/judge-cache');
const { runBaseline }  = require('./baseline');
const { createWorkspace } = require('../lib/workspace');
const runStore         = require('../run/store');
const { AGENT_VERSION } = require('../lib/sandbox/agent');
const { contractState, stateReason, approve } = require('../intent/contract-state');
const { contractFromObject } = require('../intent/compiler');
const { inputFromReport } = require('../verify/verdict');
const { runPipeline } = require('../lib/qb-pipeline');   // QB-28: the production orchestration
const { gradeArm }    = require('./grader');
const { loadSpec, checkFrozen } = require('./spec');

program
  .name('bench')
  .description('Quarterback benchmark runner')
  .option('--task <id>',         'Run a single task by ID (e.g. T-003)')
  .option('--no-baseline',       'Skip baseline comparison run')
  .option('--explore',           'Run tasks without a human-approved oracle (exploration: recorded, can never PASS; QB-13)')
  .option('--no-llm-context',    'Skip LLM enrichment in L2 (faster)')
  .option('--max-retries <n>',   'QB repair loop max retries', '3')
  .option('--runs <n>',          'Run the entire task list N times and aggregate', '1')
  .option('--sandbox',           'Use bench/sandbox-tasks.json with fixtures/ repo')
  .option('--tasks <file>',      'Task file (overrides --sandbox)')
  .option('--repo <path>',       'Source repository (overrides the task file)')
  .option('--base-rev <rev>',    'Commit to pin for every arm (overrides the task file)')
  .option('--results <dir>',     'Directory for result JSON files')
  .parse(process.argv);

const opts = program.opts();

const tasksFile = opts.tasks
  ? path.resolve(opts.tasks)
  : opts.sandbox
    ? path.join(__dirname, 'sandbox-tasks.json')
    : path.join(__dirname, 'tasks.json');
const tasks = require(tasksFile);

// Resolve relative repo path
let resolvedRepoPath = opts.repo ? path.resolve(opts.repo) : tasks.meta.repo;
if (!path.isAbsolute(resolvedRepoPath)) {
  resolvedRepoPath = path.join(__dirname, '..', resolvedRepoPath); // QB root + relative
}

const RESULTS_DIR = opts.results ? path.resolve(opts.results) : path.join(__dirname, 'results');
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
      // QB-27: a task is SCORED only by the external grader against its frozen spec.
      // A task without one still runs, but its result is "ungraded" — never a score.
      const spec = task.spec ? loadSpec(path.resolve(path.dirname(tasksFile), task.spec)) : null;
      if (spec) checkFrozen(spec);
      console.log(`\n${D1}`);
      console.log(`  [${task.id}] ${task.difficulty.toUpperCase()}  — ${task.description.slice(0, 65)}`);
      console.log(D1);

      const result = { task_id: task.id, difficulty: task.difficulty, tags: task.tags, description: task.description };

      // Each arm runs in its own disposable checkout of the pinned revision.
      // The source repository is only read, never reset or cleaned (QB-05).

      // ── QB run ─────────────────────────────────────────────────────────────
      console.log('\n  [QB] Running full pipeline...');
      result.qb = await withWorkspace(repoPath, task, 'qb', ws => runQB(task, ws));
      result.qb.grade = await gradeArm(spec, result.qb);
      printQBResult(result.qb);

      // ── Baseline run ───────────────────────────────────────────────────────
      if (opts.baseline !== false && result.qb.blocked) {
        console.log(`\n  [BASE] Skipped: the contract is not finalized (${result.qb.blocked}).`);
      } else if (opts.baseline !== false) {
        console.log('\n  [BASE] Running raw baseline (no pipeline)...');
        result.baseline = await withWorkspace(repoPath, task, 'base', ws => runBaselineTask(task, ws, result.qb.contract));
        result.baseline.grade = await gradeArm(spec, result.baseline);
        printBaselineResult(result.baseline);
        if (result.baseline.workspace.base_tree !== result.qb.workspace.base_tree) {
          throw new Error(`[${task.id}] arms started from different snapshots`);
        }
      }

      // ── Save result ────────────────────────────────────────────────────────
      const outPath = path.join(RESULTS_DIR, `${task.id}_${Date.now()}.json`);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`\n  Saved → ${outPath}`);

      summary.push(result);
      multiRunData[task.id].push(result.qb?.grade?.outcome === 'pass');
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

async function runQB(task, ws) {
  const repoPath   = ws.dir;
  const maxRetries = parseInt(opts.maxRetries, 10) || 3;
  const out = { timing: {} };
  const run = ws.run;

  // L1
  let t = Date.now();
  let contract = await compile(task.description);
  // QB-13: a PASS needs a human-approved test oracle, independent of the model.
  // A task's `oracle` (criteria + checks written by a person, `approved_by`)
  // replaces the generated contract; without one, the task can't score PASS.
  if (task.oracle) {
    contract = approve(contractFromObject({ goal: task.description, ...task.oracle, clarifying_question: null }, task.description),
      { via: 'benchmark-oracle', note: `approved_by: ${task.oracle.approved_by || 'unknown'}` });
    console.log(`     L1 using the task's human-written oracle (approved by ${task.oracle.approved_by || 'unknown'})`);
  }
  out.oracle = contract.approval ? { approved: true, via: contract.approval.via } : { approved: false, via: null };
  out.mode = contract.approval ? 'graded' : opts.explore ? 'exploration' : 'blocked';
  out.timing.l1_ms = Date.now() - t;
  out.contract     = contract;
  out.ac_count     = contract.acceptance_criteria?.length || 0;
  run.setContract(contract);
  console.log(`     L1 ${out.timing.l1_ms}ms — ${out.ac_count} ACs`);

  // Only a finalized contract may reach an agent (QB-08). The benchmark has no
  // one to answer a clarification, so the task is blocked in both arms.
  // QB-13: no agent runs without a human-approved oracle, unless --explore says so explicitly.
  if (out.mode === 'blocked' && contractState(contract).state === 'finalized') {
    console.log("     ✗ no human-approved oracle for this task — blocked (add an `oracle` to the task, or run with --explore)");
    run.event('contract.needs_oracle', {});
    Object.assign(out, { blocked: 'needs_oracle', attempts: [], final_verdict: 'needs_oracle', first_verdict: 'n/a', total_attempts: 0, files_changed: [] });
    out.timing.total_ms = out.timing.l1_ms;
    return out;
  }
  const cs = contractState(contract);
  if (cs.state !== 'finalized') {
    console.log(`     ✗ contract ${cs.state}${cs.question ? `: ${cs.question}` : cs.errors ? `: ${cs.errors.join('; ')}` : ''} — task blocked`);
    run.event(cs.state === 'needs_clarification' ? 'contract.needs_clarification' : 'contract.invalid', cs);
    Object.assign(out, {
      blocked: stateReason(cs), attempts: [], final_verdict: cs.state === 'needs_clarification' ? 'needs_clarification' : 'invalid_contract',
      first_verdict: 'n/a', total_attempts: 0, files_changed: [],
    });
    out.timing.total_ms = out.timing.l1_ms;
    return out;
  }

  // L2 → L3/L4 repair loop: QB's production pipeline, the same code qb.js runs (QB-28).
  // Memory is OFF in this legacy runner (no reads, no writes); arm F is the memory condition.
  t = Date.now();
  const attempts = [];
  let tAttempt = 0;
  const r = await runPipeline({
    contract, repoPath, agent: 'claude-code', maxRetries, run, budgetRun: budget.currentRun(), baseSha: ws.baseSha, memory: null,
    noLlmContext: !opts.llmContext, judgeCache: defaultJudgeCacheDir(), unapprovedExploration: out.mode === 'exploration',
    hooks: {
      contextReady(context, ms) {
        out.timing.l2_ms = ms; out.files_in_scope = context.relevant_files.length; out.symbols = Object.keys(context.symbol_map).length;
        console.log(`     L2 ${ms}ms — ${out.files_in_scope} files, ${out.symbols} symbols`);
      },
      attemptStart() { tAttempt = Date.now(); },
      verified(report, attempt) {
        const ms = Date.now() - tAttempt;
        attempts.push({ attempt, ms, verdict: report.verdict, ac_results: report.criteria_results.map(x => ({ id: x.id, met: x.met, votes: x.votes || null })), failures: report.failures });
        console.log(`     L3+L4 attempt ${attempt}: ${verdictIcon(report.verdict)} ${report.verdict.toUpperCase()} (${ms}ms)`);
      },
    },
  });
  out.attempts        = attempts;
  out.patch           = r.execution?.diff || '';
  out.final_verdict   = r.blocked ? 'blocked' : (r.report?.verdict || 'unknown');   // QB's own verdict — recorded, never the score (QB-27)
  if (r.blocked) out.blocked = r.blocked;
  out.total_attempts  = r.attempt;
  out.first_verdict   = attempts[0]?.verdict || 'unknown';
  out.files_changed   = r.execution?.changes?.map(c => c.file) || [];
  out.agent_ms        = r.agent_ms;
  out.timing.total_ms = Date.now() - t + out.timing.l1_ms;

  return out;
}

// ── Baseline run ──────────────────────────────────────────────────────────────

async function runBaselineTask(task, ws, contract) {
  const repoPath = ws.dir;
  const run = ws.run;
  const out = {};

  run.setContract(contract);
  run.startAttempt({ attempt: 1, base_sha: ws.baseSha });

  const execution = { id: 'baseline', ...(await runBaseline(task.description, repoPath, { contract, exploration: Boolean(opts.explore) && !contract.approval })) };
  out.patch         = execution.diff || '';
  out.agent_ms      = execution.duration_ms;
  out.status        = execution.status;
  out.error         = execution.error || null;
  out.files_changed = execution.changes.map(c => c.file);

  // Run L4 on baseline's change set using the same contract QB used
  const t4 = Date.now();
  const report = await verify(contract, null, execution, { repoPath, judgeCache: defaultJudgeCacheDir() });
  out.l4_ms = Date.now() - t4;
  run.finishAttempt(1, { execution, report, patch: execution.diff, verifyInput: inputFromReport(report, execution),
    checks: runStore.checksFor(1, execution) });

  out.verdict       = report.verdict;
  out.ac_results    = report.criteria_results.map(r => ({ id: r.id, met: r.met }));
  out.failures      = report.failures;
  out.timing_ms     = execution.duration_ms + out.l4_ms;

  return out;
}

// ── Workspaces ────────────────────────────────────────────────────────────────

/**
 * Create a disposable checkout of the pinned revision, run one arm in it with
 * its own run record, and always remove it afterwards.
 */
async function withWorkspace(source, task, arm, fn) {
  const baseRev = opts.baseRev || tasks.meta.base_rev || 'HEAD';
  const ws = createWorkspace(source, { baseRev, label: `${task.id}-${arm}` });
  if (ws.sourceDirty) {
    console.log(`     note: source has uncommitted changes; arms use committed ${ws.sourceCommit.slice(0, 12)} only`);
  }
  ws.run = runStore.createRun({
    kind:     arm === 'qb' ? 'bench-qb' : 'bench-baseline',
    request:  task.description,
    repoPath: ws.dir,
    baseSha:  ws.baseSha,
    agent:    { type: 'claude-code', version: AGENT_VERSION, isolation: 'sandbox' },
    config:   { task_id: task.id, base_rev: baseRev, source_commit: ws.sourceCommit, mode: ws.mode, max_retries: opts.maxRetries },
  });

  // QB-21: an honest usage record per benchmark run (model calls, tokens when reported,
  // agent usage explicitly unknown, deadlines, cost with provenance).
  const budgetRun = budget.startRun({ agent: { type: 'claude-code', version: AGENT_VERSION, isolation: 'sandbox' },
    sandboxDeadlines: require('../lib/sandbox/pipeline').DEFAULT_DEADLINES });
  budgetRun.stage(`${arm} ${task.id}`);
  const recordUsage = () => { try { ws.run.event('run.usage', budgetRun.usage()); } catch { /* run already closed */ } budget.endRun(); };
  try {
    const out = await fn(ws);
    recordUsage();
    const verdict = arm === 'qb' ? out.final_verdict : out.verdict;
    if (out.blocked) ws.run.finish('BLOCKED', { reason: out.blocked });
    else ws.run.finish(runStore.outcomeFor(verdict), { legacy_verdict: verdict });
    out.run_id = ws.run.id;
    out.workspace = { base_rev: baseRev, source_commit: ws.sourceCommit, base_sha: ws.baseSha, base_tree: ws.baseTree, mode: ws.mode };
    return out;
  } catch (e) {
    if (budget.currentRun()) recordUsage();
    ws.run.abort('ERROR', e.message);
    throw e;
  } finally {
    ws.cleanup();
  }
}

// ── Print helpers ─────────────────────────────────────────────────────────────

function verdictIcon(v) {
  return { pass: '✓', fail: '✗', partial: '~', 'no-diff': '○', error: '!', unresolved: '~' }[v] || '?';
}

const gradeOf = (arm) => (arm && arm.grade ? arm.grade.outcome : 'ungraded');

function printQBResult(r) {
  console.log(`\n     QB  score: ${gradeOf(r).toUpperCase()}${r.grade?.reason ? ` (${r.grade.reason})` : ''}  — ${r.total_attempts} attempt(s)  ${(r.timing.total_ms / 1000).toFixed(1)}s`);
  console.log(`         internal QB verdict (not a score): ${r.final_verdict}; first attempt: ${r.first_verdict}`);
  if (r.files_changed.length) console.log(`         changed: ${r.files_changed.join(', ')}`);
}

function printBaselineResult(r) {
  console.log(`     BASE score: ${gradeOf(r).toUpperCase()}${r.grade?.reason ? ` (${r.grade.reason})` : ''}  — ${(r.timing_ms / 1000).toFixed(1)}s`);
  console.log(`         internal verdict (not a score): ${r.verdict}`);
  if (r.files_changed.length) console.log(`         changed: ${r.files_changed.join(', ')}`);
}

/**
 * QB-27: scores come only from the external grader. pass/fail are scores; every other
 * outcome (ungraded, needs_adjudication, grader_error, infra_error) is listed, never
 * counted as a pass or a fail. Matched comparisons and statistics: bench/report.js (QB-29/30).
 */
function printSummary(summary, hasBaseline) {
  console.log(`\n\n${D2}`);
  console.log(`  BENCHMARK SUMMARY  (scores: external grader only)`);
  console.log(D2);
  console.log(`  ${'ID'.padEnd(8)} ${'QB score'.padEnd(20)} ${'QB internal'.padEnd(14)}${hasBaseline ? ` ${'BASE score'.padEnd(20)}` : ''}`);
  for (const r of summary) {
    console.log(`  ${r.task_id.padEnd(8)} ${gradeOf(r.qb).padEnd(20)} ${String(r.qb?.final_verdict || '?').padEnd(14)}${hasBaseline ? ` ${(r.baseline ? gradeOf(r.baseline) : 'missing').padEnd(20)}` : ''}`);
  }
  const tally = (arm) => {
    const outs = summary.map((r) => (r[arm] ? gradeOf(r[arm]) : 'missing'));
    const scored = outs.filter((o) => o === 'pass' || o === 'fail');
    const other = {};
    for (const o of outs) if (o !== 'pass' && o !== 'fail') other[o] = (other[o] || 0) + 1;
    return `${scored.filter((o) => o === 'pass').length}/${scored.length} scored passed` + (Object.keys(other).length ? `; not scored: ${Object.entries(other).map(([k, n]) => `${k} ${n}`).join(', ')}` : '');
  };
  console.log(`\n  QB:       ${tally('qb')}`);
  if (hasBaseline) console.log(`  Baseline: ${tally('baseline')}`);
  console.log(`\n${D2}\n`);
}

main().catch(e => {
  console.error('\n  FATAL:', e.message);
  process.exit(1);
});
