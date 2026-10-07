/**
 * lib/budget.js — deadlines, cancellation and usage for one run (QB-21).
 *
 *   per-call deadline   every local-model call ends after QB_MODEL_CALL_TIMEOUT_MS
 *                       (default 180 s) — even if the transport ignores the abort
 *                       signal: the call is raced against its deadline.
 *   total-run deadline  startRun({ deadlineMs }) (qb.js: QB_RUN_DEADLINE_MS / --deadline)
 *                       aborts the run's signal; in-flight and later model calls fail
 *                       with "run deadline (…) exceeded during <stage>", and the stage
 *                       that was interrupted is recorded.
 *   concurrency         at most QB_MODEL_CONCURRENCY (default 2) model calls at once.
 *   usage               (re-review) an honest record: stage times; model calls attempted /
 *                       completed / failed / timed out / cancelled; tokens only when reported
 *                       (unknown is null, never 0; partial coverage labelled); reported model
 *                       ids and endpoints; agent identity with its usage explicitly unknown;
 *                       effective deadlines; cost with provenance or explicit unknown; and the
 *                       budgets that are not enforced.
 *
 * One run is active per process (qb.js / the benchmark start and end it). Without an
 * active run, calls still get the per-call deadline and the concurrency bound.
 */

const envInt = (name, dflt) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : dflt; };
const callTimeoutMs = () => envInt('QB_MODEL_CALL_TIMEOUT_MS', 180_000);
/** The per-call deadline in force: the active run's own (QB-28 manifests), else the environment's. */
const effectiveCallMs = (runMs) => runMs || callTimeoutMs();
const concurrency = () => envInt('QB_MODEL_CONCURRENCY', 2);

class DeadlineError extends Error {
  constructor(message, { stage = null, kind = 'call' } = {}) { super(message); this.name = 'DeadlineError'; this.code = 'DEADLINE'; this.stage = stage; this.kind = kind; }
}

// ── the active run ──
let active = null;

function newUsage() {
  return { stages: [], model: { attempted: 0, completed: 0, failed: 0, timed_out: 0, cancelled: 0,
    calls_reporting: 0, calls_not_reporting: 0, prompt: 0, completion: 0, models_reported: {}, endpoints: {} } };
}

const AGENT_USAGE_REASON = 'the sandboxed agent runs `claude -p --output-format text`, which reports no token usage or cost to QB';
const UNSUPPORTED = [
  'token budget: not enforced (model tokens are recorded when reported, never capped)',
  'cost budget: not enforced (agent cost is not reported to QB)',
  'agent token usage: unknown (' + AGENT_USAGE_REASON + ')',
];
const isLocal = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);

/**
 * The honest usage record (QB-21 re-review): unknown is null with a reason, never 0.
 * Model tokens: `complete` (every completed call reported counts), `partial` (sums cover only
 * the reporting calls), `unknown` (none reported), `none` (no completed calls).
 */
function usageRecord(u, { deadlineMs, agent, sandboxDeadlines, modelCallMs = callTimeoutMs() }) {
  const m = u.model;
  const tokensStatus = m.completed === 0 ? 'none' : m.calls_not_reporting === 0 ? 'complete' : m.calls_reporting === 0 ? 'unknown' : 'partial';
  const known = tokensStatus === 'complete' || tokensStatus === 'partial';
  const hosts = Object.keys(m.endpoints);
  const models = Object.keys(m.models_reported);
  const allLocal = hosts.length > 0 && hosts.every(isLocal) && !models.some((x) => /-cloud$|:cloud$/.test(x));
  const modelCost = m.attempted === 0 ? { usd: 0, status: 'none', basis: 'no model calls' }
    : allLocal ? { usd: 0, status: 'estimated', basis: 'local Ollama inference: no per-call charge (hardware and energy are not metered)' }
      : { usd: null, status: 'unknown', basis: 'remote or cloud model endpoint: billing is not visible to QB' };
  const agentKind = agent && agent.type;
  const agentApplies = agentKind && !['dry-run', 'manual'].includes(agentKind);
  const agentUsage = agentApplies
    ? { identity: agent, usage_status: 'unknown', tokens: null, cost_usd: null, reason: AGENT_USAGE_REASON }
    : { identity: agent || null, usage_status: 'not_applicable', tokens: null, cost_usd: 0, reason: agentKind ? `${agentKind}: no coding-agent model calls` : 'no agent' };
  const agentCost = agentApplies ? { usd: null, status: 'unknown', basis: AGENT_USAGE_REASON } : { usd: 0, status: 'none', basis: agentUsage.reason };
  const total = modelCost.usd !== null && agentCost.usd !== null
    ? { usd: modelCost.usd + agentCost.usd, status: modelCost.status === 'estimated' ? 'estimated' : 'none' }
    : { usd: null, status: 'unknown', basis: 'at least one component is unknown' };
  return {
    schema: 'qb-usage/1',
    deadlines: { run_ms: deadlineMs > 0 ? deadlineMs : null, model_call_ms: modelCallMs, model_concurrency: concurrency(), sandbox_stage_ms: sandboxDeadlines || null },
    stages: u.stages,
    model: {
      configured: process.env.QB_MODEL || 'deepseek-r1:7b',
      models_reported: m.models_reported, endpoints: m.endpoints,
      attempted: m.attempted, completed: m.completed, failed: m.failed, timed_out: m.timed_out, cancelled: m.cancelled,
      tokens: { status: tokensStatus, prompt: known ? m.prompt : null, completion: known ? m.completion : null,
        calls_reporting: m.calls_reporting, calls_not_reporting: m.calls_not_reporting },
    },
    agent: agentUsage,
    cost: { model: modelCost, agent: agentCost, total },
    unsupported: UNSUPPORTED,
  };
}

/**
 * @param {object} [o]
 * @param {number} [o.modelCallMs] QB-28 re-review: this run's per-call model deadline (an
 *   experiment manifest's model_call_deadline_ms); overrides QB_MODEL_CALL_TIMEOUT_MS while
 *   the run is active, and is what the usage record reports.
 */
function startRun({ deadlineMs = 0, agent = null, sandboxDeadlines = null, modelCallMs = null } = {}) {
  const controller = new AbortController();
  const usage = newUsage();
  let current = null;
  let interrupted = null;
  let timer = null;
  const closeStage = () => { if (current) { current.ms = Date.now() - current.t0; delete current.t0; current = null; } };
  if (deadlineMs > 0) {
    timer = setTimeout(() => {
      interrupted = { stage: current ? current.stage : null, deadline_ms: deadlineMs };
      controller.abort(new DeadlineError(`run deadline (${deadlineMs}ms) exceeded during ${interrupted.stage || 'startup'}`, { stage: interrupted.stage, kind: 'run' }));
    }, deadlineMs);
    timer.unref();
  }
  const runCallMs = Number.isInteger(modelCallMs) && modelCallMs > 0 ? modelCallMs : null;
  active = {
    modelCallMs: runCallMs,
    signal: controller.signal,
    counters: usage,
    stage(name) { closeStage(); current = { stage: String(name), t0: Date.now() }; usage.stages.push(current); },
    interrupted: () => interrupted,
    cancel(reason) { if (!controller.signal.aborted) controller.abort(new DeadlineError(reason, { stage: current && current.stage, kind: 'cancel' })); },
    usage: () => {
      const out = JSON.parse(JSON.stringify(usage));
      const open = out.stages.find((s) => s.t0 !== undefined);
      if (open) { open.ms = Date.now() - open.t0; delete open.t0; }
      return usageRecord(out, { deadlineMs, agent, sandboxDeadlines, modelCallMs: effectiveCallMs(runCallMs) });
    },
    end() { closeStage(); if (timer) clearTimeout(timer); },
  };
  return active;
}
function endRun() { if (active) active.end(); active = null; }
/** Throws the run's cancellation reason if the run deadline has passed (between stages). */
function checkpoint() { if (active && active.signal.aborted) throw active.signal.reason; }
const currentRun = () => active;

// ── bounded concurrency for local-model calls ──
let inFlight = 0;
const waiting = [];
async function acquire(signal) {
  while (inFlight >= concurrency()) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      waiting.push(entry);
      if (signal) signal.addEventListener('abort', () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); }, { once: true });
    });
  }
  inFlight++;
}
function release() { inFlight--; const next = waiting.shift(); if (next) next.resolve(); }

/**
 * One deadline-bound, cancellable, concurrency-bounded JSON POST to the local model.
 * Resolves the parsed JSON body; throws DeadlineError on a per-call timeout or when the
 * run is cancelled, and a plain Error on an HTTP error.
 */
async function modelCall(url, body) {
  const run = active;
  const ms = effectiveCallMs(run && run.modelCallMs);
  const mc = run && run.counters.model;
  if (mc) {
    mc.attempted++;
    let host = 'unknown';
    try { host = new URL(url).host; } catch { /* keep unknown */ }
    mc.endpoints[host] = (mc.endpoints[host] || 0) + 1;
  }
  if (run && run.signal.aborted) { mc.cancelled++; throw run.signal.reason; }
  const ctl = new AbortController();
  const onRunAbort = () => ctl.abort(run.signal.reason);
  if (run) run.signal.addEventListener('abort', onRunAbort, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new DeadlineError(`model call timed out after ${ms}ms`); ctl.abort(e); reject(e); }, ms);
    ctl.signal.addEventListener('abort', () => reject(ctl.signal.reason), { once: true });
  });
  deadline.catch(() => {});
  let holding = false;
  const slot = acquire(ctl.signal).then(() => { holding = true; if (ctl.signal.aborted) { holding = false; release(); } });
  slot.catch(() => {});
  try {
    await Promise.race([slot, deadline]);
    try {
      const res = await Promise.race([fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }), deadline]);
      if (!res.ok) throw new Error(`Ollama ${res.status}`);
      const data = await Promise.race([res.json(), deadline]);
      if (mc) {
        mc.completed++;
        const p = data && data.prompt_eval_count, c = data && data.eval_count;
        if (Number.isInteger(p) && Number.isInteger(c)) { mc.calls_reporting++; mc.prompt += p; mc.completion += c; }
        else mc.calls_not_reporting++;     // unknown is never counted as zero
        if (data && typeof data.model === 'string') mc.models_reported[data.model] = (mc.models_reported[data.model] || 0) + 1;
      }
      return data;
    } finally { if (holding) { holding = false; release(); } }
  } catch (e) {
    if (mc) { if (e && e.code === 'DEADLINE') { if (e.kind === 'call') mc.timed_out++; else mc.cancelled++; } else mc.failed++; }
    throw e;
  } finally {
    clearTimeout(timer);
    if (run) run.signal.removeEventListener('abort', onRunAbort);
  }
}

module.exports = { startRun, endRun, currentRun, checkpoint, modelCall, DeadlineError, callTimeoutMs };
