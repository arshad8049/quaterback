/**
 * memory/lock.js — a per-repository, cross-process lock for the memory store (QB-25).
 *
 * Same claim pattern as the judge cache (verify/judge-cache.js), synchronous because
 * every memory critical section is a short file update:
 *   - claim: `<dir>/.lock` created exclusively (O_EXCL) with { pid, host, token };
 *   - a held claim is waited for (bounded by waitMs, polling every pollMs);
 *   - a claim whose owner is dead (same host, pid gone) or that is older than staleMs
 *     (critical sections take milliseconds) is taken over by atomic rename — only one
 *     waiter's rename succeeds, and it checks the token it judged stale;
 *   - release removes the lock only if it still holds our token.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEPER, 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

class MemoryLockTimeout extends Error {
  constructor(dir, waitMs) { super(`memory store ${dir} is locked by another process (waited ${waitMs} ms)`); this.code = 'MEMORY_LOCK_TIMEOUT'; }
}

/**
 * Run fn() while holding the repository's lock.
 * @param {string} dir  the repository's memory directory
 * @param {Function} fn
 * @param {{ waitMs?: number, staleMs?: number, pollMs?: number }} [o]
 */
function withLock(dir, fn, { waitMs = 10_000, staleMs = 30_000, pollMs = 5 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, '.lock');
  const token = crypto.randomBytes(12).toString('hex');
  const host = os.hostname();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lf, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let owner = null;
    let st = null;
    try { st = fs.statSync(lf); owner = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch { /* released or half-written meanwhile */ }
    const dead = owner && owner.host === host && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
    if (st && (dead || Date.now() - st.mtimeMs > staleMs)) {
      const moved = `${lf}.stale.${token}`;
      try {
        fs.renameSync(lf, moved);
        const was = JSON.parse(fs.readFileSync(moved, 'utf8'));
        if (owner && was.token !== owner.token) { try { fs.linkSync(moved, lf); } catch { /* claimed meanwhile */ } }
        fs.unlinkSync(moved);
      } catch { /* another waiter took it over */ }
      continue;
    }
    if (Date.now() >= deadline) throw new MemoryLockTimeout(dir, waitMs);
    sleepSync(pollMs);
  }
  try { return fn(); } finally {
    try { if (JSON.parse(fs.readFileSync(lf, 'utf8')).token === token) fs.unlinkSync(lf); } catch { /* gone */ }
  }
}

module.exports = { withLock, MemoryLockTimeout };
