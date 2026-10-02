/**
 * lib/sandbox/docker.js — the only way the sandbox talks to Docker.
 *
 * Every command is argv (QB-01) and bounded in time: a hung client or daemon
 * is killed after `opTimeoutMs`, never waited on forever (§8.3). Long-running
 * stages use `runStage`, which drains output while the container runs and
 * reads the evidence only after Docker reports it exited (§8.4, §8.5).
 */

const { runBounded } = require('../proc');
const { classifyStage } = require('./states');

const DOCKER = process.env.QB_DOCKER_BIN || 'docker';
const DEFAULT_OP_TIMEOUT_MS = 30_000;

/** Label set every per-run resource carries, for cleanup and the reaper. */
function runLabels(runId, role) {
  const l = ['--label', `qb.run=${runId}`];
  if (role) l.push('--label', `qb.role=${role}`);
  return l;
}

/** A short, bounded Docker command. Resolves to the runBounded result plus `ok`. */
async function op(args, { timeoutMs = DEFAULT_OP_TIMEOUT_MS, input } = {}) {
  const r = await runBounded(DOCKER, args, { timeoutMs, input, maxBytes: 1024 * 1024 });
  return { ...r, ok: r.status === 0 && !r.timedOut };
}

/** `docker inspect` .State of a container, or null. */
async function inspectState(container) {
  const r = await op(['inspect', '-f', '{{json .State}}', container]);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** True if the daemon answers within the op timeout. */
async function available() {
  const r = await op(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

/** Ids of every container (or only running ones) for a run. */
async function runContainers(runId, { running = false } = {}) {
  const args = ['ps', '-aq', '--filter', `label=qb.run=${runId}`];
  if (running) args.push('--filter', 'status=running');
  const r = await op(args);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * Run one stage container to completion and classify it.
 *
 * `createArgs` are the `docker create` arguments (flags, image, command). The
 * container is created, then started attached so its output streams into
 * bounded buffers; the host-side wait has its own timeout as a backstop.
 * The supervisor (not this function) owns the stage deadline; `killedBy` lets
 * the caller tell classification why the container stopped.
 *
 * @returns {Promise<{ name, state, reason, exit_code, oom_killed, stdout, stderr,
 *                     stdout_dropped, stderr_dropped, duration_ms }>}
 */
async function runStage(name, createArgs, { input, waitTimeoutMs, maxBytes, killedBy } = {}) {
  const created = await op(['create', '--name', name, ...(input !== undefined ? ['-i'] : []), ...createArgs]);
  if (!created.ok) {
    return { name, ...classifyStage(null, { infraError: `create failed: ${created.stderr.trim().slice(0, 300) || 'timeout'}` }),
      stdout: '', stderr: created.stderr, stdout_dropped: 0, stderr_dropped: 0, duration_ms: created.duration_ms };
  }
  const started = await runBounded(DOCKER, ['start', '-a', ...(input !== undefined ? ['-i'] : []), name],
    { input, timeoutMs: waitTimeoutMs, maxBytes });
  // Evidence is read only after Docker confirms the container exited (§8.4).
  let state = await inspectState(name);
  if (state && state.Running) {
    await op(['kill', name]);
    await op(['wait', name]);
    state = await inspectState(name);
  }
  const ctx = typeof killedBy === 'function' ? { killedBy: killedBy() } : { killedBy };
  return {
    name, ...classifyStage(state, ctx),
    stdout: started.stdout, stderr: started.stderr,
    stdout_dropped: started.stdout_dropped, stderr_dropped: started.stderr_dropped,
    duration_ms: started.duration_ms,
  };
}

/** Remove a run's containers, then networks, then volumes. Returns what is left. */
async function removeRun(runId) {
  const lbl = `label=qb.run=${runId}`;
  const ids = async (kind) => {
    const r = await op(kind === 'container' ? ['ps', '-aq', '--filter', lbl] : [kind, 'ls', '-q', '--filter', lbl]);
    return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  };
  const c = await ids('container'); if (c.length) await op(['rm', '-f', ...c]);
  const n = await ids('network');   if (n.length) await op(['network', 'rm', ...n]);
  const v = await ids('volume');    if (v.length) await op(['volume', 'rm', '-f', ...v]);
  return { containers: (await ids('container')).length, networks: (await ids('network')).length, volumes: (await ids('volume')).length };
}

module.exports = { DOCKER, op, inspectState, available, runContainers, runStage, removeRun, runLabels };
