/**
 * lib/sandbox/protocol.js — the files and identities the supervisor protocol
 * is built on (agent-sandbox.md §8.3).
 *
 *   identity / alive   a process is (pid, start time), so a reused pid never
 *                      counts as the original owner (E4 s7)
 *   atomicWrite        temp + fsync + rename
 *   commitTerminal     create-exclusive: exactly one terminal state per run (E4 s6)
 *   config             protocol timings and stage defaults
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../proc');

const CONFIG = Object.freeze({
  renewMs:        +(process.env.QB_SANDBOX_RENEW_MS || 5_000),
  leaseTimeoutMs: +(process.env.QB_SANDBOX_LEASE_TIMEOUT_MS || 30_000),
  killGraceMs:    +(process.env.QB_SANDBOX_KILL_GRACE_MS || 10_000),
  dockerOpMs:     +(process.env.QB_SANDBOX_DOCKER_OP_MS || 30_000),
  readyMs:        +(process.env.QB_SANDBOX_READY_MS || 10_000),
  ackMs:          +(process.env.QB_SANDBOX_ACK_MS || 10_000),
  dockerDownMaxMs: +(process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS || 10 * 60_000),
  pollMs:         200,
});

/** Monotonic milliseconds; unaffected by wall-clock changes. */
const mono = () => Number(process.hrtime.bigint() / 1_000_000n);

/** { pid, start } for a live process, or null. Linux: /proc stat field 22; elsewhere `ps -o lstart=`. */
function identity(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      return { pid, start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] };
    }
    const r = run('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 });
    const start = String(r.stdout || '').trim();
    return r.status === 0 && start ? { pid, start } : null;
  } catch {
    return null;
  }
}

/** True only if a process with this pid exists and has the recorded start time. */
function alive(id) {
  if (!id || !id.pid) return false;
  const now = identity(id.pid);
  return Boolean(now && now.start === id.start);
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(obj)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Commit the run's single terminal state. Returns true if this call won. */
function commitTerminal(dir, state, actor, reason, extra = {}) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, 'terminal.json'), 'wx', 0o600);
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ state, actor, reason, committed_at: new Date().toISOString(), ...extra }));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return true;
}

const terminal = (dir) => readJson(path.join(dir, 'terminal.json'));

function event(dir, who, what, extra = {}) {
  fs.appendFileSync(path.join(dir, 'events.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), who, what, ...extra }) + '\n');
}

module.exports = { CONFIG, mono, identity, alive, atomicWrite, readJson, commitTerminal, terminal, event };
