/**
 * lib/sandbox/lease.js — the CLI's side of the supervisor protocol (agent-sandbox.md §8.3).
 *
 *   const s = await Supervision.start(runDir, runId);   // readiness handshake first
 *   await s.beginStage('agent', 600_000);               // immutable deadline; waits for the ack
 *   ...run the stage...
 *   s.endStage('agent');
 *   await s.propose('completed', 'exit 0');             // the supervisor commits it
 *
 * Nothing per-run may be created in Docker before start() resolves. While the
 * object lives it renews the lease and watches the supervisor's identity; if
 * the supervisor dies first, `onSupervisorLost` runs once (the caller kills
 * and cleans up, then commits infra_error / supervisor_lost).
 */

const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { spawnDetached } = require('../proc');

const SUPERVISOR = path.join(__dirname, 'supervisor.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Supervision {
  constructor(runDir, runId, supId) {
    this.runDir = runDir;
    this.runId = runId;
    this.supervisor = supId;
    this.seq = 0;
    this.lost = false;
    this.onSupervisorLost = null;
    this._renew = setInterval(() => this.renew(), P.CONFIG.renewMs);
    this._watch = setInterval(() => this._check(), 500);
    this.renew();
  }

  /**
   * Spawn the supervisor and wait for its readiness handshake.
   * `supervisorPath` is injectable for tests only (no env or flag selects it).
   * Throws (after killing the spawned process) if it is not ready in time.
   */
  static async start(runDir, runId, { supervisorPath = SUPERVISOR } = {}) {
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    P.atomicWrite(path.join(runDir, 'run.json'), { run_id: runId, cli: P.identity(process.pid), created_at: new Date().toISOString() });
    const pid = spawnDetached(process.execPath, [supervisorPath, runDir, runId], { logFile: path.join(runDir, 'supervisor.log') });
    const by = P.mono() + P.CONFIG.readyMs;
    while (P.mono() < by) {
      const s = P.readJson(path.join(runDir, 'supervisor.json'));
      if (s && s.ready && s.pid === pid) {
        const run = P.readJson(path.join(runDir, 'run.json'));
        P.atomicWrite(path.join(runDir, 'run.json'), { ...run, supervisor: { pid: s.pid, start: s.start } });
        P.event(runDir, 'cli', 'supervisor_ready', { pid });
        return new Supervision(runDir, runId, { pid: s.pid, start: s.start });
      }
      await sleep(100);
    }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    P.commitTerminal(runDir, 'infra_error', 'cli', 'supervisor_not_ready');
    P.event(runDir, 'cli', 'supervisor_not_ready', { pid });
    const err = new Error('sandbox supervisor did not become ready');
    err.code = 'SUPERVISOR_NOT_READY';
    throw err;
  }

  renew() {
    if (this.closed) return;
    P.atomicWrite(path.join(this.runDir, 'lease.json'), { seq: ++this.seq, at: new Date().toISOString() });
  }

  /** Hand a stage to the supervisor and wait for its ack before the stage may start. */
  async beginStage(id, deadlineMs) {
    P.atomicWrite(path.join(this.runDir, 'stage.json'), { id, deadline_ms: deadlineMs });
    const by = P.mono() + P.CONFIG.ackMs;
    while (P.mono() < by) {
      const ack = P.readJson(path.join(this.runDir, 'stage-ack.json'));
      if (ack && ack.id === id) { P.event(this.runDir, 'cli', 'stage_acked', { id }); return; }
      if (this.lost) break;
      await sleep(100);
    }
    const err = new Error(`supervisor did not acknowledge stage ${id}`);
    err.code = 'STAGE_NOT_ACKED';
    throw err;
  }

  endStage(id) { P.atomicWrite(path.join(this.runDir, 'stage-done.json'), { id }); }

  /** True once the supervisor killed the run for a deadline (or committed anything). */
  terminal() { return P.terminal(this.runDir); }

  /** Propose a normal outcome; resolves to the committed terminal (which may differ, e.g. timeout won). */
  async propose(state, reason) {
    P.atomicWrite(path.join(this.runDir, 'proposal.json'), { state, reason });
    const by = P.mono() + P.CONFIG.dockerOpMs * 3;
    while (P.mono() < by) {
      const t = this.terminal();
      if (t && !P.alive(this.supervisor)) { this.close(); return t; }
      await sleep(200);
    }
    this.close();
    return this.terminal();
  }

  _check() {
    if (this.lost || this.closed || this.terminal()) return;
    if (!P.alive(this.supervisor)) {
      this.lost = true;
      P.event(this.runDir, 'cli', 'supervisor_lost', this.supervisor);
      if (this.onSupervisorLost) Promise.resolve(this.onSupervisorLost()).catch(() => {});
    }
  }

  close() {
    this.closed = true;
    clearInterval(this._renew);
    clearInterval(this._watch);
  }
}

module.exports = { Supervision, SUPERVISOR };
