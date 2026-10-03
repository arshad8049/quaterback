#!/usr/bin/env node
/**
 * lib/sandbox/supervisor.js — the detached per-run supervisor (agent-sandbox.md §8.3).
 *
 * Spawned by the CLI (lease.js) in its own session, outside every container.
 * Enforces, whatever happens to the CLI:
 *   - each stage's deadline, measured on this process's monotonic clock from
 *     the moment it acknowledged the stage; lease renewals cannot extend it;
 *   - the CLI lease: no renewal for leaseTimeoutMs means the CLI is gone.
 * At T_end + killGraceMs it kills every container of the run, commits the run's
 * single terminal state, removes all run resources, and exits. If Docker does not
 * answer, it retries with backoff and records infra_error (G5c). It is also the
 * only writer of a normal outcome: the CLI proposes, the supervisor commits.
 *
 * Usage (internal): supervisor.js <runDir> <runId>
 */

const path = require('path');
const P = require('./protocol');
const D = require('./docker');

const [runDir, runId] = process.argv.slice(2);
const f = (n) => path.join(runDir, n);
const opMs = P.CONFIG.dockerOpMs;

let lastSeq = null;
let lastRenew = P.mono();
let stage = null;            // { id, deadline_ms, ackAt, done }
let busy = false;

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Docker unavailable (G5c): nothing can be killed or removed, so retry with
 * backoff for up to dockerDownMaxMs. Returns the call's value, or null on give-up.
 */
let dockerDown = false;
async function whileDockerDown(what, call) {
  const by = P.mono() + P.CONFIG.dockerDownMaxMs;
  for (let attempt = 1; ; attempt++) {
    const v = await call();
    if (v !== null) return v;
    if (!dockerDown) P.event(runDir, 'supervisor', 'docker_unavailable', { during: what });
    dockerDown = true;
    if (P.mono() >= by) { P.event(runDir, 'supervisor', 'docker_unavailable_gave_up', { during: what }); return null; }
    await sleep(Math.min(5000, 250 * 2 ** Math.min(attempt, 5)));
  }
}

/** Kill every running container of the run. True once Docker confirms none is running. */
async function killAll() {
  for (let attempt = 1; ; attempt++) {
    const running = await whileDockerDown('kill', () => D.listContainers(runId, { running: true }));
    if (running === null) return false;
    if (!running.length) return true;
    const r = await D.op(['kill', ...running], { timeoutMs: opMs });
    P.event(runDir, 'supervisor', 'docker_kill', { count: running.length, ok: r.ok, timedOut: r.timedOut, attempt });
    if (!r.ok) await sleep(Math.min(2000, 200 * attempt));
  }
}

/** Remove every run resource; retries while Docker is unavailable. Returns what is left. */
async function cleanup() {
  let left = null;
  await whileDockerDown('remove', async () => {
    left = await D.removeRun(runId);
    return [left.containers, left.networks, left.volumes].includes(null) ? null : left;
  });
  return left;
}

async function finish(state, reason) {
  const enforceAt = new Date().toISOString();
  const t0 = P.mono();
  const stopped = await killAll();
  // Enforcement that needed Docker while it was gone is an infrastructure failure (G5c).
  const [s, why] = dockerDown ? ['infra_error', `docker_unavailable (${reason})`] : [state, reason];
  const kill_ms = P.mono() - t0;
  const won = P.commitTerminal(runDir, s, 'supervisor', why);
  const left = stopped ? await cleanup() : null;
  P.atomicWrite(f('enforcement.json'), { state: s, reason: why, won_terminal: won, enforce_at: enforceAt, kill_ms,
    stopped_confirmed: stopped, docker_unavailable: dockerDown, left, stage });
  P.event(runDir, 'supervisor', 'exit', { state: s, won, left });
  process.exit(0);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = P.mono();
    // Someone else (the CLI's supervisor_lost path) committed: stand down.
    if (P.terminal(runDir)) { P.event(runDir, 'supervisor', 'terminal_seen_exit'); process.exit(0); }

    const s = P.readJson(f('stage.json'));
    if (s && (!stage || s.id !== stage.id)) {
      stage = { id: s.id, deadline_ms: s.deadline_ms, ackAt: now, done: false };
      P.atomicWrite(f('stage-ack.json'), { id: s.id });
      P.event(runDir, 'supervisor', 'stage_ack', { id: s.id, deadline_ms: s.deadline_ms });
    }
    const done = P.readJson(f('stage-done.json'));
    if (stage && done && done.id === stage.id) stage.done = true;

    const lease = P.readJson(f('lease.json'));
    if (lease && lease.seq !== lastSeq) { lastSeq = lease.seq; lastRenew = now; }

    const prop = P.readJson(f('proposal.json'));
    if (prop) {
      P.commitTerminal(runDir, prop.state, 'supervisor', `cli_proposal: ${prop.reason || ''}`.trim());
      const left = (await killAll()) ? await cleanup() : null;
      P.event(runDir, 'supervisor', 'exit_after_proposal', { left });
      process.exit(0);
    }

    const leaseEnd = lastRenew + P.CONFIG.leaseTimeoutMs;
    const stageEnd = stage && !stage.done ? stage.ackAt + stage.deadline_ms : Infinity;
    if (now >= Math.min(leaseEnd, stageEnd) + P.CONFIG.killGraceMs) {
      if (stageEnd <= leaseEnd) await finish('timeout', 'stage_deadline');
      else await finish('ABANDONED', 'lease_expired');
    }
  } finally {
    busy = false;
  }
}

P.atomicWrite(f('supervisor.json'), { ...P.identity(process.pid), proto: 1, ready: true });
P.event(runDir, 'supervisor', 'ready', { config: P.CONFIG });
setInterval(() => { tick().catch((e) => P.event(runDir, 'supervisor', 'tick_error', { error: String(e) })); }, P.CONFIG.pollMs);
