/**
 * lib/proc.js — the only way Quarterback starts subprocesses.
 *
 * Every call takes an argv array and runs with shell:false, so repository
 * filenames, branch names and model output can never be interpreted as
 * shell syntax (QB-01). Results always carry exit code, signal, timing and
 * both streams so callers can tell a failing command from a broken one.
 */

const { spawnSync } = require('child_process');

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

module.exports = { run, git, containedPath };
