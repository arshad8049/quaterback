/**
 * E4 prototype — shared pieces of the §8.3 supervisor protocol.
 *
 * Spike code, not product code: just enough of the protocol to test it against
 * real Docker. Every file write is atomic (temp + fsync + rename) except the
 * terminal state, which is create-exclusive so exactly one writer can win.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CFG = {
  renewMs:        +(process.env.E4_RENEW_MS || 1000),
  leaseTimeoutMs: +(process.env.E4_LEASE_TIMEOUT_MS || 5000),
  killGraceMs:    +(process.env.E4_KILL_GRACE_MS || 3000),
  dockerOpMs:     +(process.env.E4_DOCKER_OP_MS || 10000),
  readyMs:        +(process.env.E4_READY_MS || 10000),
  pollMs:         200,
};

const DOCKER = process.env.E4_DOCKER || 'docker';

/** Monotonic milliseconds (never affected by wall-clock changes). */
const mono = () => Number(process.hrtime.bigint() / 1000000n);

/** Process identity: pid + start time, so a reused pid is never mistaken for the original. */
function identity(pid) {
  try {
    if (fs.existsSync('/proc')) {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return { pid, start: fields[19] };        // field 22 overall = index 19 after "(comm) "
    }
    const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
    const start = r.stdout.trim();
    return start ? { pid, start } : null;
  } catch {
    return null;
  }
}

/** True only if a process with this pid exists *and* has the recorded start time. */
function alive(id) {
  if (!id) return false;
  const now = identity(id.pid);
  return !!now && now.start === id.start;
}

function atomicWrite(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(obj));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** Commit the run's single terminal state. Returns true if this call won. */
function commitTerminal(runDir, state, actor, reason) {
  const file = path.join(runDir, 'terminal.json');
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  fs.writeSync(fd, JSON.stringify({ state, actor, reason, committed_at: new Date().toISOString() }));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return true;
}

function event(runDir, who, what, extra = {}) {
  fs.appendFileSync(path.join(runDir, 'events.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), who, what, ...extra }) + '\n');
}

/** Run a docker command with a hard timeout; a hung client is killed, never waited on forever. */
function docker(args, timeoutMs = CFG.dockerOpMs) {
  const r = spawnSync(DOCKER, args, { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL' });
  return {
    ok: r.status === 0,
    timedOut: !!(r.error && r.error.code === 'ETIMEDOUT'),
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

const ids = (runId, extra = []) =>
  docker(['ps', '-aq', '--filter', `label=qb.run=${runId}`, ...extra]).stdout.split('\n').filter(Boolean);

/**
 * Kill every workload, then support services, and wait until none is running.
 * Retries with backoff while Docker misbehaves; returns timings.
 */
function killAll(runDir, who, runId) {
  const t0 = Date.now();
  let attempt = 0;
  for (;;) {
    const running = ids(runId, ['--filter', 'status=running']);
    if (!running.length && attempt > 0) break;
    if (running.length) {
      const r = docker(['kill', ...running]);
      event(runDir, who, 'docker_kill', { count: running.length, ok: r.ok, timedOut: r.timedOut });
    }
    attempt++;
    if (!ids(runId, ['--filter', 'status=running']).length) break;
    sleepMs(Math.min(2000, 200 * attempt));
  }
  return { kill_ms: Date.now() - t0 };
}

/** Remove containers, then networks, then volumes for the run; report what is left. */
function cleanup(runDir, who, runId) {
  const t0 = Date.now();
  const lbl = `label=qb.run=${runId}`;
  // Save workload logs as evidence before the containers disappear.
  for (const id of ids(runId)) {
    const name = docker(['inspect', '-f', '{{.Name}}', id]).stdout.replace(/^\//, '');
    const logs = docker(['logs', id]);
    fs.writeFileSync(path.join(runDir, `logs-${name}.txt`), logs.stdout + (logs.stderr ? '\n' + logs.stderr : ''));
    const st = docker(['inspect', '-f', '{{json .State}}', id]).stdout;
    fs.writeFileSync(path.join(runDir, `state-${name}.json`), st);
  }
  const c = ids(runId);
  if (c.length) docker(['rm', '-f', ...c]);
  const n = docker(['network', 'ls', '-q', '--filter', lbl]).stdout.split('\n').filter(Boolean);
  if (n.length) docker(['network', 'rm', ...n]);
  const v = docker(['volume', 'ls', '-q', '--filter', lbl]).stdout.split('\n').filter(Boolean);
  if (v.length) docker(['volume', 'rm', '-f', ...v]);
  const left = {
    containers: ids(runId).length,
    networks: docker(['network', 'ls', '-q', '--filter', lbl]).stdout.split('\n').filter(Boolean).length,
    volumes: docker(['volume', 'ls', '-q', '--filter', lbl]).stdout.split('\n').filter(Boolean).length,
  };
  event(runDir, who, 'cleanup', { ms: Date.now() - t0, left });
  return left;
}

function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

module.exports = { CFG, mono, identity, alive, atomicWrite, readJson, commitTerminal, event,
                   docker, ids, killAll, cleanup, sleepMs };
