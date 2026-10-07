/**
 * lib/sandbox/docker.js — the only way the sandbox talks to Docker.
 *
 * Every command is argv (QB-01) and bounded in time: a hung client or daemon
 * is killed after `opTimeoutMs`, never waited on forever (§8.3). Long-running
 * stages use `runStage`, which drains output while the container runs and
 * reads the evidence only after Docker reports it exited (§8.4, §8.5).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
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

/**
 * `<repo>:c-<hash>` over every build input (paths relative to `root`; directories
 * walked in sorted order). A changed script or Dockerfile yields a new tag, so an
 * updated QB never runs a stale image built from older trusted code.
 */
function contentTag(repo, root, inputs) {
  const h = crypto.createHash('sha256');
  const add = (rel) => {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isDirectory()) { for (const e of fs.readdirSync(abs).sort()) add(path.join(rel, e)); return; }
    h.update(`${rel}\0${st.mode & 0o111 ? 'x' : '-'}\0`).update(st.isSymbolicLink() ? fs.readlinkSync(abs) : fs.readFileSync(abs)).update('\0');
  };
  for (const i of inputs) add(i);
  return `${repo}:c-${h.digest('hex').slice(0, 16)}`;
}

/** Build `tag` from `buildArgs` unless it already exists. Returns the image id. */
async function ensureImage(tag, buildArgs, what) {
  let r = await op(['image', 'inspect', '-f', '{{.Id}}', tag]);
  if (r.ok) return r.stdout.trim();
  r = await op(['build', '-q', '-t', tag, ...buildArgs], { timeoutMs: 20 * 60_000 });
  if (!r.ok) throw Object.assign(new Error(`${what} image build failed: ${r.stderr.slice(-500)}`), { code: 'IMAGE_BUILD_FAILED' });
  return r.stdout.trim();
}

/** A short, bounded Docker command. Resolves to the runBounded result plus `ok`. */
async function rawOp(args, { timeoutMs = DEFAULT_OP_TIMEOUT_MS, input, raw = false, maxBytes = 1024 * 1024 } = {}) {
  const r = await runBounded(DOCKER, args, { timeoutMs, input, raw, maxBytes });
  return { ...r, ok: r.status === 0 && !r.timedOut };
}

// ── Image binding (QB-29: pins bound to what is actually launched) ─────────────
//
// While a binding is active (one experiment arm-trial, including its grading), every
// container the sandbox creates — `create` (runStage) and `run` (keeper, proxy, probes) —
// is launched from the pinned IMMUTABLE image id, never a mutable tag: a pinned tag in the
// arguments is replaced by its id. Each created container's actual image (.Image) is then
// checked against the pinned ids BEFORE it starts; anything else is removed unstarted and
// the launch fails. Every launch is recorded, so the trial's evidence names what ran.
let binding = null;

/**
 * @param {Record<string,string>} refToId  pinned image ref (tag) → image id (sha256:…)
 * @returns {() => Array<{container, image, ref}>} release: ends the binding, returns the launches
 */
function bindImages(refToId) {
  if (binding) throw new Error('an image binding is already active');
  const b = { map: { ...refToId }, allowed: new Set(Object.values(refToId)), launched: [] };
  binding = b;
  return () => { if (binding === b) binding = null; return b.launched; };
}

const failed = (why, t0) => ({ status: 1, signal: null, stdout: '', stderr: why, timedOut: false, duration_ms: Date.now() - t0, ok: false });

/** Check a created (not started) container's image; remove it unstarted if it is not pinned. */
async function verifyCreated(b, id, ref) {
  const r = await rawOp(['inspect', '-f', '{{.Image}}', id]);
  const image = r.ok ? r.stdout.trim() : null;
  if (!image || !b.allowed.has(image)) {
    await rawOp(['rm', '-f', id]);
    return `image identity: container ${id.slice(0, 12)} was created from ${image || 'an unknown image'}, which is not a pinned image — removed before it ran`;
  }
  b.launched.push({ container: id.slice(0, 12), image, ref: ref || null });
  return null;
}

async function boundLaunch(b, args, opts) {
  const t0 = Date.now();
  const ref = args.find((a) => Object.prototype.hasOwnProperty.call(b.map, a)) || null;
  const rewritten = args.map((a) => (Object.prototype.hasOwnProperty.call(b.map, a) ? b.map[a] : a));
  if (args[0] === 'create') {
    const c = await rawOp(rewritten, opts);
    if (!c.ok) return c;
    const why = await verifyCreated(b, c.stdout.trim(), ref);
    return why ? failed(why, t0) : c;
  }
  // `run` = create (verified) + start: the workload never executes from an unpinned image
  const detached = rewritten.includes('-d');
  const remove = rewritten.includes('--rm');
  const c = await rawOp(['create', ...rewritten.slice(1).filter((a) => a !== '-d' && a !== '--rm')], { timeoutMs: opts.timeoutMs });
  if (!c.ok) return c;
  const id = c.stdout.trim();
  const why = await verifyCreated(b, id, ref);
  if (why) return failed(why, t0);
  if (detached) {
    const st = await rawOp(['start', id]);
    return st.ok ? { ...st, stdout: `${id}\n` } : st;
  }
  try {
    return await rawOp(['start', '-a', ...(opts.input !== undefined ? ['-i'] : []), id], opts);
  } finally {
    if (remove) await rawOp(['rm', '-f', id]);
  }
}

async function op(args, opts = {}) {
  if (binding && (args[0] === 'create' || args[0] === 'run')) return boundLaunch(binding, args, opts);
  return rawOp(args, opts);
}

/** `docker inspect` .State of a container, or null. */
async function inspectState(container) {
  const r = await op(['inspect', '-f', '{{json .State}}', container]);
  if (!r.ok) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/**
 * Docker records an OOM kill from a separate containerd event that can be processed
 * after the container's exit. A child OOM-killed under a main process that then exits
 * immediately can therefore inspect as OOMKilled=false for a moment (seen as a CI flake
 * of the OOM classification test). Before trusting OOMKilled=false, re-inspect a few
 * times over ~600 ms so a late OOM event is not missed (QB-02 classification).
 */
async function settleOom(name, state, { tries = OOM_SETTLE_TRIES, delayMs = OOM_SETTLE_DELAY_MS, inspect = inspectState } = {}) {
  let st = state;
  for (let i = 0; i < tries && st && !st.Running && !st.OOMKilled; i++) {
    await new Promise((r) => setTimeout(r, delayMs));
    const again = await inspect(name);
    if (again) st = again;
  }
  return st;
}
const OOM_SETTLE_TRIES = 3;
const OOM_SETTLE_DELAY_MS = 200;

/** True if the daemon answers within the op timeout. */
async function available() {
  const r = await op(['version', '--format', '{{.Server.Version}}'], { timeoutMs: 10_000 });
  return r.ok ? r.stdout.trim() : null;
}

/**
 * Ids of every container (or only running ones) for a run, or null when Docker
 * did not answer. Enforcement must use this: "unknown" is not "none running" (G5c).
 */
async function listContainers(runId, { running = false } = {}) {
  const args = ['ps', '-aq', '--filter', `label=qb.run=${runId}`];
  if (running) args.push('--filter', 'status=running');
  const r = await op(args);
  return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
}

/** listContainers, with an unanswered query read as empty (reporting and tests only). */
async function runContainers(runId, opts) {
  return (await listContainers(runId, opts)) || [];
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
  state = await settleOom(name, state);
  // A stage the CLI stopped at its own wait deadline is a timeout (QB-22: its partial
  // edits are still captured afterwards). Otherwise the caller says why it stopped.
  const ctx = started.timedOut ? { killedBy: 'deadline' }
    : typeof killedBy === 'function' ? { killedBy: killedBy() } : { killedBy };
  return {
    name, ...classifyStage(state, ctx),
    stdout: started.stdout, stderr: started.stderr,
    stdout_dropped: started.stdout_dropped, stderr_dropped: started.stderr_dropped,
    duration_ms: started.duration_ms,
  };
}

/**
 * Remove a run's containers, then networks, then volumes. Returns what is left;
 * a count is null when Docker did not answer, never a guessed 0 (G5c).
 */
async function removeRun(runId) {
  const lbl = `label=qb.run=${runId}`;
  const ids = async (kind) => {
    const r = await op(kind === 'container' ? ['ps', '-aq', '--filter', lbl] : [kind, 'ls', '-q', '--filter', lbl]);
    return r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : null;
  };
  const c = await ids('container'); if (c && c.length) await op(['rm', '-f', ...c]);
  const n = await ids('network');   if (n && n.length) await op(['network', 'rm', ...n]);
  const v = await ids('volume');    if (v && v.length) await op(['volume', 'rm', '-f', ...v]);
  const count = async (kind) => { const x = await ids(kind); return x ? x.length : null; };
  return { containers: await count('container'), networks: await count('network'), volumes: await count('volume') };
}

/** True when removeRun's report shows nothing left (and nothing unknown). */
const removed = (left) => Boolean(left) && left.containers === 0 && left.networks === 0 && left.volumes === 0;

module.exports = { DOCKER, contentTag, ensureImage, op, bindImages, inspectState, settleOom, available, listContainers, runContainers, runStage, removeRun, removed, runLabels };
