/**
 * lib/proc.js — the only way Quarterback starts subprocesses.
 *
 * Every call takes an argv array and runs with shell:false, so repository
 * filenames, branch names and model output can never be interpreted as
 * shell syntax (QB-01). Results always carry exit code, signal, timing and
 * both streams so callers can tell a failing command from a broken one.
 */

const { spawnSync, spawn } = require('child_process');

const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;

/**
 * @param {string}   cmd
 * @param {string[]} args
 * @param {object}   opts - { cwd, input, env, timeout, maxBuffer, encoding }
 * @returns {{ status: number|null, signal: string|null, stdout, stderr,
 *             error: Error|null, timedOut: boolean, duration_ms: number }}
 */
function run(cmd, args = [], opts = {}) {
  if (!Array.isArray(args)) throw new TypeError('run(): args must be an array');

  const t0 = Date.now();
  const r = spawnSync(cmd, args, {
    cwd:       opts.cwd,
    input:     opts.input,
    env:       opts.env || process.env,
    timeout:   opts.timeout,
    maxBuffer: opts.maxBuffer || DEFAULT_MAX_BUFFER,
    encoding:  opts.encoding === undefined ? 'utf8' : opts.encoding,
    killSignal: 'SIGKILL',
    shell:     false,
    windowsHide: true,
  });

  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  return {
    status:      r.status,
    signal:      r.signal || null,
    stdout:      r.stdout,
    stderr:      r.stderr,
    error:       r.error || null,
    timedOut,
    duration_ms: Date.now() - t0,
  };
}

/**
 * Run git with argv. Throws on spawn failure or nonzero exit unless
 * opts.allowFail is set, in which case the raw result is returned.
 */
function git(args, cwd, opts = {}) {
  const r = run('git', args, { ...opts, cwd });
  if (opts.allowFail) return r;
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const err = new Error(`git ${args[0]} exited ${r.status}: ${String(r.stderr || '').trim().slice(0, 500)}`);
    err.result = r;
    throw err;
  }
  return r.stdout;
}

/**
 * Resolve a repo-relative path and refuse anything that escapes the repo.
 * Returns the normalised relative path.
 */
function containedPath(repoPath, relPath) {
  const path = require('path');
  const root = path.resolve(repoPath);
  const abs  = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes repository: ${JSON.stringify(relPath)}`);
  }
  return path.relative(root, abs);
}

// ---------------------------------------------------------------------------
// Bounded streaming runner (QB-02, agent-sandbox.md §8.5).
//
// spawnSync with maxBuffer kills the child when output overflows, and waiting
// for exit before reading can leave a child blocked on a full pipe. runBounded
// drains both streams while the child runs into head+tail buffers, never stops
// reading, and reports how many bytes it dropped.
// ---------------------------------------------------------------------------

const DEFAULT_STREAM_BYTES = 256 * 1024;

/** Head + tail buffer: keeps the first and last `limit / 2` bytes of a stream. */
class BoundedBuffer {
  constructor(limit) {
    this.half = Math.max(1, Math.floor(limit / 2));
    this.head = [];
    this.headLen = 0;
    this.tail = Buffer.alloc(0);
    this.total = 0;
  }

  push(chunk) {
    this.total += chunk.length;
    if (this.headLen < this.half) {
      const take = chunk.subarray(0, this.half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length) {
      const joined = Buffer.concat([this.tail, chunk]);
      this.tail = joined.subarray(Math.max(0, joined.length - this.half));
    }
  }

  get droppedBytes() { return Math.max(0, this.total - this.headLen - this.tail.length); }

  toString() {
    const head = Buffer.concat(this.head).toString('utf8');
    if (!this.droppedBytes) return head + this.tail.toString('utf8');
    return `${head}\n[... ${this.droppedBytes} bytes dropped ...]\n${this.tail.toString('utf8')}`;
  }
}

/**
 * @param {string}   cmd
 * @param {string[]} args
 * @param {object}   opts - { input, env, cwd, timeoutMs, maxBytes }
 * @returns {Promise<{ status: number|null, signal: string|null, stdout: string, stderr: string,
 *                     stdout_dropped: number, stderr_dropped: number, timedOut: boolean,
 *                     error: Error|null, duration_ms: number }>}
 */
function runBounded(cmd, args = [], opts = {}) {
  if (!Array.isArray(args)) throw new TypeError('runBounded(): args must be an array');
  const maxBytes = opts.maxBytes || DEFAULT_STREAM_BYTES;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const out = new BoundedBuffer(maxBytes);
    const err = new BoundedBuffer(maxBytes);
    let timedOut = false;
    let spawnError = null;
    const child = spawn(cmd, args, {
      cwd: opts.cwd, env: opts.env || process.env, shell: false, windowsHide: true,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('error', (e) => { spawnError = e; });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, opts.timeoutMs)
      : null;
    child.on('close', (status, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        status, signal: signal || null,
        stdout: out.toString(), stderr: err.toString(),
        stdout_dropped: out.droppedBytes, stderr_dropped: err.droppedBytes,
        timedOut, error: spawnError, duration_ms: Date.now() - t0,
      });
    });
  });
}

/**
 * Start a long-lived helper in its own session (setsid), detached from this
 * process, with stdout/stderr appended to `logFile`. Returns its pid. Used for
 * the sandbox supervisor, which must outlive the CLI (agent-sandbox.md §8.3).
 */
function spawnDetached(cmd, args = [], { logFile, env } = {}) {
  if (!Array.isArray(args)) throw new TypeError('spawnDetached(): args must be an array');
  const fs = require('fs');
  const fd = fs.openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(cmd, args, { detached: true, shell: false, stdio: ['ignore', fd, fd], env: env || process.env });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { run, git, containedPath, runBounded, BoundedBuffer, spawnDetached };

