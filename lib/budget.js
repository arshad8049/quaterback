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
 *   usage               time per stage; model calls, prompt/completion tokens (when the
 *                       model reports them), timeouts.
 *
 * One run is active per process (qb.js / the benchmark start and end it). Without an
 * active run, calls still get the per-call deadline and the concurrency bound.
 */

const envInt = (name, dflt) => { const n = Number(process.env[name]); return Number.isInteger(n) && n > 0 ? n : dflt; };
const callTimeoutMs = () => envInt('QB_MODEL_CALL_TIMEOUT_MS', 180_000);
const concurrency = () => envInt('QB_MODEL_CONCURRENCY', 2);

class DeadlineError extends Error {
  constructor(message, { stage = null, kind = 'call' } = {}) { super(message); this.name = 'DeadlineError'; this.code = 'DEADLINE'; this.stage = stage; this.kind = kind; }
}

// ── the active run ──
let active = null;

function newUsage() { return { stages: [], model: { calls: 0, prompt_tokens: 0, completion_tokens: 0, timeouts: 0 } }; }

function startRun({ deadlineMs = 0 } = {}) {
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
  active = {
    signal: controller.signal,
    counters: usage,
    stage(name) { closeStage(); current = { stage: String(name), t0: Date.now() }; usage.stages.push(current); },
    interrupted: () => interrupted,
    cancel(reason) { if (!controller.signal.aborted) controller.abort(new DeadlineError(reason, { stage: current && current.stage, kind: 'cancel' })); },
    usage: () => { const out = JSON.parse(JSON.stringify(usage)); const open = out.stages.find((s) => s.t0 !== undefined); if (open) { open.ms = Date.now() - open.t0; delete open.t0; } return out; },
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
  const ms = callTimeoutMs();
  const run = active;
  if (run && run.signal.aborted) throw run.signal.reason;
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
      if (run) {
        run.counters.model.calls++;
        if (Number.isInteger(data && data.prompt_eval_count)) run.counters.model.prompt_tokens += data.prompt_eval_count;
        if (Number.isInteger(data && data.eval_count)) run.counters.model.completion_tokens += data.eval_count;
      }
      return data;
    } finally { if (holding) { holding = false; release(); } }
  } catch (e) {
    if (run && e && e.code === 'DEADLINE') run.counters.model.timeouts++;
    throw e;
  } finally {
    clearTimeout(timer);
    if (run) run.signal.removeEventListener('abort', onRunAbort);
  }
}

module.exports = { startRun, endRun, currentRun, checkpoint, modelCall, DeadlineError, callTimeoutMs };
