#!/usr/bin/env node
/**
 * E4 prototype — the detached per-run supervisor (§8.3).
 *
 * Enforces, independently of the CLI's lifetime:
 *   - the stage deadline (immutable once acknowledged, measured on this
 *     process's own monotonic clock; lease renewals cannot extend it), and
 *   - the CLI lease (no renewal for LEASE_TIMEOUT means the CLI is gone).
 * At T_end + KILL_GRACE it kills every container of the run, commits the
 * single terminal state, and removes all run resources.
 *
 * Usage: supervisor.js <runDir>     (spawned detached by cli.js)
 */

const fs = require('fs');
const path = require('path');
const C = require('./common');

const runDir = process.argv[2];
const runId = path.basename(runDir);
const f = (n) => path.join(runDir, n);

// Scenario hook: a supervisor that never becomes ready (E4 case 4c).
if (process.env.E4_SUP_NO_READY === '1') {
  C.event(runDir, 'supervisor', 'started_never_ready');
  setInterval(() => {}, 1 << 30);
  return;
}

C.atomicWrite(f('supervisor.json'), { ...C.identity(process.pid), proto: 1, ready: true });
C.event(runDir, 'supervisor', 'ready', C.CFG);

let lastSeq = null;
let lastRenew = C.mono();          // the lease clock starts when the supervisor starts
let stage = null;                  // { id, deadline_ms, ackAt }

function finish(state, reason, cause) {
  const enforceWall = Date.now();
  const k = C.killAll(runDir, 'supervisor', runId);
  const won = C.commitTerminal(runDir, state, 'supervisor', reason);
  const left = C.cleanup(runDir, 'supervisor', runId);
  C.atomicWrite(f('enforcement.json'), {
    cause, state, reason, won_terminal: won,
    enforce_at: new Date(enforceWall).toISOString(),
    kill_ms: k.kill_ms, left,
    stage, lease_age_ms_at_enforce: C.mono() - lastRenew,
  });
  C.event(runDir, 'supervisor', 'exit', { state, won });
  process.exit(0);
}

setInterval(() => {
  const now = C.mono();

  // A terminal state committed by someone else (e.g. the CLI's supervisor_lost path): stand down.
  if (fs.existsSync(f('terminal.json'))) { C.event(runDir, 'supervisor', 'terminal_seen_exit'); process.exit(0); }

  // New stage record → acknowledge and start its deadline on our own clock. Never re-read later.
  const s = C.readJson(f('stage.json'));
  if (s && (!stage || s.id !== stage.id)) {
    stage = { id: s.id, deadline_ms: s.deadline_ms, ackAt: now };
    C.atomicWrite(f('stage-ack.json'), { id: s.id });
    C.event(runDir, 'supervisor', 'stage_ack', { id: s.id, deadline_ms: s.deadline_ms });
  }
  const done = C.readJson(f('stage-done.json'));
  if (stage && done && done.id === stage.id) stage = { ...stage, done: true };

  // Lease: only a changed sequence number counts as a renewal.
  const lease = C.readJson(f('lease.json'));
  if (lease && lease.seq !== lastSeq) { lastSeq = lease.seq; lastRenew = now; }

  // The CLI proposes an outcome; the supervisor is the only one that commits it.
  const prop = C.readJson(f('proposal.json'));
  if (prop) {
    C.commitTerminal(runDir, prop.state, 'supervisor', `cli_proposal:${prop.reason || ''}`);
    C.cleanup(runDir, 'supervisor', runId);
    C.event(runDir, 'supervisor', 'exit_after_proposal');
    process.exit(0);
  }

  const leaseEnd = lastRenew + C.CFG.leaseTimeoutMs;
  const stageEnd = stage && !stage.done ? stage.ackAt + stage.deadline_ms : Infinity;
  const tEnd = Math.min(leaseEnd, stageEnd);
  if (now >= tEnd + C.CFG.killGraceMs) {
    if (stageEnd <= leaseEnd) finish('timeout', 'stage_deadline', 'deadline');
    else finish('ABANDONED', 'lease_expired', 'lease');
  }
}, C.CFG.pollMs);
