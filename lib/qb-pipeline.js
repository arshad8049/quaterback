/**
 * lib/qb-pipeline.js — QB's production orchestration after L1, as ONE API (QB-28).
 *
 *   L5 recall (file hints, prior repairs) → L2 context → L3/L4 attempt loop with QB-10
 *   routing and QB-18 context refresh → L5 persist
 *
 * Used by qb.js (ordinary runs) and by the benchmark's QB arms (bench/arms.js), so the
 * benchmark measures the code users run. It was extracted from qb.js unchanged; the
 * golden tests in test/unit/qb28-orchestration-golden.test.js pin the behaviour.
 *
 * All console output goes through `hooks` (qb.js prints exactly what it printed before;
 * the benchmark stays quiet). `memory` is the memory instance to use, or null for a run
 * with memory OFF — then nothing is recalled AND nothing is persisted.
 */

const { buildContext, refreshContext } = require('../context/builder');
const { orchestrate } = require('../agent/orchestrator');
const { verify } = require('../verify/verifier');
const { routeRepair } = require('../verify/routing');
const { inputFromReport } = require('../verify/verdict');
const { attemptEntry } = require('../memory/repairs');
const runStore = require('../run/store');
const budget = require('./budget');

const noop = () => {};

/**
 * QB-28 re-review: what an equal agent-time budget debits — the trusted agent-stage
 * duration the sandbox reports (sandbox.stages.agent.duration_ms), not seed, dependency
 * install, capture or verification. If a result carries no stage duration, the whole
 * invocation is debited (conservative) and the basis says so.
 */
function agentStageMs(execution, invocationMs) {
  const d = execution && execution.sandbox && execution.sandbox.stages && execution.sandbox.stages.agent
    ? execution.sandbox.stages.agent.duration_ms : undefined;
  return Number.isFinite(d) && d >= 0 ? { ms: d, basis: 'agent_stage' } : { ms: invocationMs, basis: 'invocation_wall (agent-stage duration unavailable)' };
}

/**
 * @param {object} o
 * @param {object} o.contract        finalized (and, for a real agent, approved) contract
 * @param {string} o.repoPath
 * @param {string} o.agent           dry-run | claude-code | manual
 * @param {number} o.maxRetries
 * @param {object} o.run             run record (run/store.js createRun)
 * @param {object} [o.budgetRun]     lib/budget.js run (stages, signal)
 * @param {string|null} [o.baseSha]
 * @param {object|null} o.memory     memory instance, or null = memory OFF (no reads, no writes)
 * @param {boolean} [o.noLlmContext] @param {boolean} [o.noLlmVerify] @param {string} [o.judgeCache]
 * @param {boolean} [o.unapprovedExploration]  benchmark exploration mode (never PASS)
 * @param {number} [o.agentTimeMs]   QB-28: total agent wall-clock for ALL attempts (equal agent-time
 *   experiments); each invocation gets what remains, and no attempt starts once it is spent
 * @param {Function} [o.runSandboxed] test seam: replaces the sandbox for every agent invocation
 * @param {object} [o.hooks]         console/artifact callbacks (see qb.js)
 * @param {object} [o.deps]          { orchestrate, verify, buildContext, refreshContext } — tests only
 * @returns {Promise<{ blocked?: string, execution, report, attempt, attemptHistory, context, agent_ms, agent_time_exhausted }>}
 */
async function runPipeline(o) {
  const h = { ...Object.fromEntries(HOOKS.map((k) => [k, noop])), ...(o.hooks || {}) };
  const d = { orchestrate, verify, buildContext, refreshContext, ...(o.deps || {}) };
  const { contract, repoPath, run, budgetRun } = o;
  const stage = (name) => { if (budgetRun) budgetRun.stage(name); };

  // ── Layer 5 recall → Layer 2 context (memory-boosted) ───────────────────────
  const fileHints = o.memory ? o.memory.recallFiles(repoPath, contract.goal) : [];
  const priorRepairs = o.memory ? o.memory.recallRepairs(repoPath, contract.acceptance_criteria) : [];
  h.memoryRecalled(fileHints, priorRepairs);

  stage('L2 context');
  h.contextStart();
  const t2 = Date.now();
  let context = await d.buildContext(contract, repoPath, { noLlm: Boolean(o.noLlmContext), fileHints });
  budget.checkpoint();
  h.contextReady(context, Date.now() - t2);

  // ── Repair loop: L3 → L4 ──────────────────────────────────────────────────
  let execution = null;
  let report = null;
  let attempt = 0;
  let previousPatch;                 // QB-10: no-progress detection across attempts
  let repairHints = priorRepairs.map((r) => ({
    criterion_id: r.criterion_id,
    // QB-23: say what memory knows — a proven fix vs an unconfirmed or legacy suggestion
    diagnosis: `[${r.proven ? 'proven fix from a past run' : 'past suggestion, not proven'}] ${r.diagnosis}`,
    suggested_fix: r.fix,
  }));
  const attemptHistory = [];         // QB-23: append-only, one entry per verified attempt
  let agentMs = 0;                   // QB-28: trusted agent-STAGE time spent so far
  const timing = [];                 // per attempt: agent stage vs whole invocation
  let exhausted = false;

  while (attempt < o.maxRetries) {
    if (o.agentTimeMs && o.agentTimeMs - agentMs <= 0) {
      exhausted = true;
      run.event('budget.agent_time_exhausted', { after_attempt: attempt, agent_time_ms: o.agentTimeMs, agent_ms: agentMs });
      break;
    }
    attempt++;
    const isRetry = attempt > 1;
    stage(`L3 agent (attempt ${attempt})`);
    h.attemptStart(attempt, isRetry);

    run.startAttempt({
      attempt,
      parent_attempt: isRetry ? attempt - 1 : null,
      repair_reason: repairHints.map((x) => x.criterion_id),
      base_sha: o.baseSha ?? null,
    });

    const t3 = Date.now();
    execution = await d.orchestrate(contract, context, {
      agent: o.agent,
      ...(o.unapprovedExploration ? { unapprovedExploration: true } : {}),
      repoPath,
      repairHints,
      attempt,
      signal: budgetRun && budgetRun.signal,   // QB-21: a run deadline cancels the sandbox
      ...(o.agentTimeMs ? { timeoutMs: o.agentTimeMs - agentMs } : {}),
      ...(o.runSandboxed ? { runSandboxed: o.runSandboxed } : {}),
    });
    const spent = agentStageMs(execution, Date.now() - t3);
    agentMs += spent.ms;
    timing.push({ attempt, agent_stage_ms: spent.ms, basis: spent.basis, invocation_ms: Date.now() - t3 });
    budget.checkpoint();
    h.executed(execution, attempt, isRetry, Date.now() - t3);

    // A blocked sandbox (Docker unavailable, unsupported project, auth not ready)
    // never reaches verification: the caller ends the run BLOCKED with the reason.
    if (execution.status === 'blocked') {
      run.event('sandbox.blocked', { reason: execution.error, sandbox: execution.sandbox || null });
      return { blocked: execution.error, execution, report, attempt, attemptHistory, context, agent_ms: agentMs, agent_time_exhausted: false, timing };
    }
    if (execution.sandbox?.run_id) run.event('sandbox.run', { sandbox: execution.sandbox });

    // ── Layer 4: Verify ──────────────────────────────────────────────────────
    stage(`L4 verification (attempt ${attempt})`);
    h.verifyStart();
    const t4 = Date.now();
    report = await d.verify(contract, context, execution, {
      ...(o.noLlmVerify !== undefined ? { noLlm: Boolean(o.noLlmVerify) } : {}),
      repoPath,
      judgeCache: o.judgeCache,   // QB-15: an unchanged patch is never re-sampled into a pass
    });
    budget.checkpoint();
    run.finishAttempt(attempt, {
      execution,
      report,
      patch: execution.diff,
      verifyInput: inputFromReport(report, execution),
      checks: runStore.checksFor(attempt, execution),
    });
    attemptHistory.push(attemptEntry(attempt, report, (run.manifest.attempts.find((a) => a.attempt === attempt) || {}).patch_sha256));
    // Exact patch bytes and touched-path baseline for `qb patch` (QB-02 §9.3).
    if (execution.patch_raw) run.artifact(`a${attempt}-patch-raw`, execution.patch_raw, { ext: 'bin' });
    if (execution.base_listing) run.artifact(`a${attempt}-base-ls`, execution.base_listing, { ext: 'bin' });
    h.verified(report, attempt, Date.now() - t4);

    if (report.verdict === 'pass') { h.passed(execution, report); break; }
    // QB-10: one routing decision: repair only with concrete actions, never code-repair
    // an environment problem, stop on no progress.
    const route = routeRepair(report, { patch: execution.diff, previousPatch: attempt > 1 ? previousPatch : undefined });
    previousPatch = execution.diff;
    run.event('attempt.routed', { attempt, action: route.action, reason: route.reason });
    if (route.action === 'environment') { h.environment(route, execution, report); break; }
    if (route.action === 'stop') { h.stopped(route, execution, report); break; }
    if (attempt >= o.maxRetries) { h.maxRetries(o.maxRetries); break; }

    repairHints = route.hints;
    // QB-18: refresh the context from this attempt's patch (new/changed files and their neighbours).
    const refreshed = d.refreshContext(context, contract, repoPath, execution, { attempt });
    context = refreshed.context;
    run.event('context.refreshed', refreshed.refresh);
    h.retrying(route, report);
  }
  h.loopDone(report);

  // ── Layer 5: Memory — persist this run (memory OFF: nothing is written) ────
  if (o.memory) {
    stage('L5 memory');
    await o.memory.remember(repoPath, contract, { ...report, attempts: attempt }, execution,
      { history: attemptHistory, runId: run.manifest.run_id, baseSha: o.baseSha ?? null });
    h.remembered(o.memory.stats(repoPath));
  }
  return { execution, report, attempt, attemptHistory, context, agent_ms: agentMs, agent_time_exhausted: exhausted, timing };
}

const HOOKS = ['memoryRecalled', 'contextStart', 'contextReady', 'attemptStart', 'executed', 'verifyStart', 'verified',
  'passed', 'environment', 'stopped', 'maxRetries', 'retrying', 'loopDone', 'remembered'];

module.exports = { runPipeline, agentStageMs, HOOKS };
