/**
 * bench/arms.js — the experimental arms (QB-28), one API: runArm().
 *
 * Each arm differs from the previous one by exactly one thing (docs/bench/arms.md):
 *
 *   A  native agent        the original prompt; the agent may plan and run tests natively; 1 invocation
 *   B  + retry loop        retries while the repository's OWN visible tests fail, feeding back their
 *                          output (never the hidden grader)
 *   C  + accepted contract the briefing is the spec's human-approved oracle contract (QB-13 path:
 *                          approved_by the spec's oracle author); feedback as B
 *   D  + QB context        C's briefing plus the L2 context package; feedback as B
 *   E  + QB verifier       QB's production pipeline (lib/qb-pipeline.js): L4 verdict + QB-10 repair
 *                          hints + QB-18 refresh; memory OFF (no reads, no writes)
 *   F  + memory            E with memory ON: its own copy of the frozen starting store
 *
 * Budgets (equal agent-time): every arm gets the same total agent wall-clock
 * (`agent_time_ms`); each invocation receives what remains, and no invocation starts once
 * it is spent. QB's other work (L1–L4 model calls, context, verification) is NOT inside that
 * budget — it is recorded (elapsed time, model calls, tokens/cost when reported) and bounded
 * only by the per-trial deadline. Total compute is not controlled.
 *
 * Every arm's final patch is scored by the same external grader (bench/grader.js) — that
 * happens in bench/experiment-run.js, outside the arm.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runAgentSandboxed, executionGate } = require('../agent/runner');
const { buildBriefing } = require('../agent/briefing');
const { buildContext } = require('../context/builder');
const { classifyTestRun } = require('../verify/tests');
const { approve } = require('../intent/contract-state');
const { contractFromObject } = require('../intent/compiler');
const { createMemory } = require('../memory');
const { runPipeline } = require('../lib/qb-pipeline');
const S = require('./schemas');

/** The arm table — the single source for docs, manifests and runs. */
const ARMS = Object.freeze({
  A: { id: 'A', adds: 'native agent (original prompt; may plan and test natively)', contract: 'none', feedback: 'none', context: false, memory: 'off', max_attempts: 1 },
  B: { id: 'B', adds: 'retry loop on the repository\'s own visible test output', contract: 'none', feedback: 'visible_tests', context: false, memory: 'off', max_attempts: 3 },
  C: { id: 'C', adds: 'accepted contract (spec oracle, human-approved)', contract: 'oracle_approved', feedback: 'visible_tests', context: false, memory: 'off', max_attempts: 3 },
  D: { id: 'D', adds: 'QB context package (L2)', contract: 'oracle_approved', feedback: 'visible_tests', context: true, memory: 'off', max_attempts: 3 },
  E: { id: 'E', adds: 'QB verifier and repair policy (L4 + QB-10 routing)', contract: 'oracle_approved', feedback: 'qb_verifier', context: true, memory: 'off', max_attempts: 3 },
  F: { id: 'F', adds: 'memory (own copy of the frozen starting store)', contract: 'oracle_approved', feedback: 'qb_verifier', context: true, memory: 'on', max_attempts: 3 },
});
for (const a of Object.values(ARMS)) S.ArmDefinition.parse(a);

const NATIVE_NOTE = 'Work in this repository to complete the task. You may plan, read the code, and run the project\'s own tests as you see fit.';
const MAX_FEEDBACK = 4000;

/** The spec's human-approved oracle as a QB contract (QB-13 path); null if the spec has none. */
function oracleContract(spec) {
  if (!spec.oracle) return null;
  return approve(contractFromObject({ goal: spec.prompt, ...spec.oracle, clarifying_question: null }, spec.prompt),
    { via: 'benchmark-oracle', note: `approved_by: ${spec.oracle.approved_by}` });
}

/** Visible-test feedback from the sandbox's own run of the repository's tests (stage ⑤). */
function visibleTests(execution) {
  const v = execution && execution.sandbox && execution.sandbox.verification;
  const cls = classifyTestRun(v || null);
  const out = v && typeof v.output === 'string' ? v.output.slice(-MAX_FEEDBACK) : '';
  return { outcome: cls.outcome, reason: cls.reason, output: out };
}

/** Count memory reads and writes (a spy) around a real memory instance. */
function countingMemory(mem) {
  const counts = { recall_calls: 0, persist_calls: 0 };
  const wrap = (fn, key) => (...a) => { counts[key]++; return fn(...a); };
  return {
    counts,
    memory: {
      recallFiles: wrap(mem.recallFiles, 'recall_calls'),
      recallRepairs: wrap(mem.recallRepairs, 'recall_calls'),
      recallPrior: wrap(mem.recallPrior, 'recall_calls'),
      remember: wrap(mem.remember, 'persist_calls'),
      stats: mem.stats,
    },
  };
}

/** A private copy of the frozen starting store for ONE memory-on trial; checks its hash. */
function memoryCopy(startingStore, expectedSha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-arm-mem-'));
  if (startingStore) {
    if (S.treeHash(startingStore) !== expectedSha) throw new Error('starting memory store does not match the manifest hash');
    fs.cpSync(startingStore, dir, { recursive: true });
  } else if (expectedSha !== null) throw new Error('the manifest pins a starting store, but none was given');
  return { dir, before: startingStore ? expectedSha : S.treeHash(dir), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The native-style arms A–D: agent invocation(s) with a fixed briefing, retrying (B–D)
 * while the repository's own tests fail, inside the agent-time budget.
 */
async function nativeArm(def, o) {
  const { spec, repoPath, run } = o;
  const contract = oracleContract(spec);
  // QB-13: every path that can run an agent passes the execution gate — here on the frozen
  // spec's approved oracle, even for A/B, which never see it.
  const gate = contract ? executionGate(contract, { agent: 'claude-code' }) : 'the frozen spec has no approved oracle';
  if (gate) return { status: 'agent_error', detail: `blocked: ${gate}`, patch: '', attempts: 0, agent_ms: 0 };
  let base;
  if (def.contract === 'none') base = `${spec.prompt}\n\n${NATIVE_NOTE}\n`;
  else {
    const context = def.context ? await buildContext(contract, repoPath, { noLlm: Boolean(o.noLlmContext) }) : null;
    base = buildBriefing(contract, context, { repairHints: [], attempt: 1 });
  }
  let agentMs = 0; let attempt = 0; let execution = null; let feedback = null;
  while (attempt < def.max_attempts) {
    const remaining = o.agentTimeMs - agentMs;
    if (remaining <= 0) { run.event('budget.agent_time_exhausted', { after_attempt: attempt, agent_time_ms: o.agentTimeMs, agent_ms: agentMs }); break; }
    attempt++;
    run.startAttempt({ attempt, parent_attempt: attempt > 1 ? attempt - 1 : null, repair_reason: feedback ? ['visible_tests'] : [], base_sha: o.baseSha ?? null });
    const briefing = feedback
      ? `${base}\n\n## Previous attempt\nThe project's own tests did not pass after your previous attempt (${feedback.reason}). Test output (tail):\n\n\`\`\`\n${feedback.output}\n\`\`\`\n`
      : base;
    const t = Date.now();
    const r = await runAgentSandboxed(briefing, repoPath, { timeoutMs: remaining, runSandboxed: o.runSandboxed, signal: o.signal,
      checks: [] });
    agentMs += Date.now() - t;
    execution = r;
    run.event('arm.attempt', { attempt, status: r.status, visible_tests: visibleTests(r).outcome });
    if (r.status === 'blocked' || r.status === 'infra_error') return { status: r.status === 'blocked' ? 'agent_error' : 'infra_error', detail: r.error, patch: r.diff || '', attempts: attempt, agent_ms: agentMs };
    if (def.feedback !== 'visible_tests') break;
    const vt = visibleTests(r);
    if (vt.outcome === 'passed' || vt.outcome === 'not_run') break;   // nothing to feed back
    feedback = vt;
  }
  return { status: 'completed', patch: (execution && execution.diff) || '', attempts: attempt, agent_ms: agentMs,
    internal_verdict: null, visible_tests: execution ? visibleTests(execution).outcome : null };
}

/**
 * Run one arm on a fresh workspace.
 * @param {object} o
 * @param {string} o.arm              A–F
 * @param {object} o.spec             frozen qb-task-spec/1
 * @param {string} o.repoPath         a fresh checkout of spec.repo.base_rev (the arm's own)
 * @param {object} o.run              run record (run/store.js)
 * @param {object} [o.budgetRun]      lib/budget.js run (per-trial deadline, usage)
 * @param {number} o.agentTimeMs      the experiment's equal agent-time budget
 * @param {object} [o.memoryStart]    { store: dir|null, sha256: string|null } — F only
 * @param {Function} [o.runSandboxed] test seam for every agent invocation
 * @returns {Promise<{ status, detail?, patch, attempts, agent_ms, internal_verdict, memory }>}
 */
async function runArm(o) {
  const def = ARMS[o.arm];
  if (!def) throw new Error(`unknown arm ${o.arm}`);
  const memOff = { mode: 'off', store_sha256_before: null, recall_calls: 0, persist_calls: 0 };
  if (def.feedback !== 'qb_verifier') return { ...(await nativeArm(def, o)), memory: memOff };

  const contract = oracleContract(o.spec);
  if (!contract) return { status: 'agent_error', detail: 'blocked: the frozen spec has no approved oracle', patch: '', attempts: 0, agent_ms: 0, internal_verdict: null, memory: memOff };
  let mem = null; let counts = null; let copy = null;
  if (def.memory === 'on') {
    copy = memoryCopy(o.memoryStart && o.memoryStart.store, o.memoryStart ? o.memoryStart.sha256 : null);
    ({ memory: mem, counts } = countingMemory(createMemory({ root: copy.dir })));
  }
  try {
    const r = await runPipeline({
      contract, repoPath: o.repoPath, agent: 'claude-code', maxRetries: def.max_attempts, run: o.run, budgetRun: o.budgetRun,
      baseSha: o.baseSha ?? null, memory: mem, noLlmContext: Boolean(o.noLlmContext), judgeCache: o.judgeCache,
      agentTimeMs: o.agentTimeMs, runSandboxed: o.runSandboxed, deps: o.deps,
    });
    const memory = def.memory === 'on'
      ? { mode: 'on', store_sha256_before: copy.before, ...counts }
      : memOff;
    if (r.blocked) return { status: 'agent_error', detail: `blocked: ${r.blocked}`, patch: '', attempts: r.attempt, agent_ms: r.agent_ms, internal_verdict: null, memory };
    return { status: 'completed', patch: (r.execution && r.execution.diff) || '', attempts: r.attempt, agent_ms: r.agent_ms,
      internal_verdict: r.report ? r.report.verdict : null, memory };
  } finally {
    if (copy) copy.cleanup();
  }
}

module.exports = { ARMS, runArm, oracleContract, visibleTests, countingMemory, memoryCopy };
