/**
 * memory/lock.js — a per-repository, cross-process lock for the memory store (QB-25).
 *
 * Synchronous (every memory critical section is a short file update).
 *
 * Re-review 3 — claims are PUBLISHED ATOMICALLY, and nothing unidentifiable is ever
 * reclaimed:
 *   - a claim is written complete ({ pid, host, token }) to a private temp file, then
 *     hard-linked to `<dir>/.lock`. link() is atomic and fails if `.lock` exists, so the
 *     lock is either absent or names its owner — it can never be seen half-written. (The
 *     old open('wx') + write left an empty claim visible; a paused creator could then be
 *     "reclaimed by age" while alive and enter alongside another process.)
 *   - the claim is re-read before entering: a process whose claim is not the current
 *     `.lock` never enters.
 *   - a lock is taken over ONLY when its owner is provably dead (same host, pid gone),
 *     and only under the takeover claim `<dir>/.lock.takeover`, itself published the same
 *     atomic way. While it is held nobody else may remove `.lock`, so "still the dead
 *     owner's token? → remove" cannot race a fresh claim (only the owner, which is dead,
 *     or the takeover holder ever removes `.lock`; a new claimant can only create it once
 *     it is gone).
 *   - NOTHING is reclaimed by age: a live owner (however paused), an owner on another
 *     host, an unreadable `.lock` (only possible through outside corruption now), and a
 *     takeover claim left by a crashed taker (clearing it would race a new taker). The
 *     waiter times out with MEMORY_LOCK_TIMEOUT, and the error names the file to remove
 *     by hand when no Quarterback process is running.
 *   - every wait iteration ends at the deadline check; no progress → back off (doubling
 *     up to 50 ms, never past the deadline).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEPER, 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const MAX_BACKOFF_MS = 50;

class MemoryLockTimeout extends Error {
  constructor(dir, waitMs, why) {
    super(`memory store ${dir} is locked${why ? `: ${why}` : ''} (waited ${waitMs} ms)`);
    this.code = 'MEMORY_LOCK_TIMEOUT';
  }
}

const readOwner = (file) => {
  try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && typeof o === 'object' && typeof o.token === 'string' ? o : null; } catch { return null; }
};

/**
 * Publish `owner` at `file` atomically: complete content in a private temp file, then
 * link() — which fails with EEXIST if `file` exists. Returns true if published.
 */
function publish(file, owner) {
  const tmp = `${file}.${owner.token}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(owner), { mode: 0o600, flag: 'wx' });
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}

/** Why the current holder cannot be displaced (for the timeout message), or null. */
function blocker(lf, host) {
  const tf = `${lf}.takeover`;
  if (fs.existsSync(tf)) {
    const t = readOwner(tf);
    if (!t) return `${tf} is unreadable; if no Quarterback process is running, remove it by hand`;
    if (t.host === host && Number.isInteger(t.pid) && !pidAlive(t.pid)) return `${tf} was left by a crashed process (pid ${t.pid}); if no Quarterback process is running, remove it by hand`;
  }
  const o = readOwner(lf);
  if (!o) return fs.existsSync(lf) ? `${lf} is unreadable (not written by this version of Quarterback); if no Quarterback process is running, remove it by hand` : null;
  if (o.host !== host) return `held from host ${o.host} (pid ${o.pid}); cross-host sharing of a memory store is not supported and the lock is never taken over`;
  return `held by live process ${o.pid}`;
}

/**
 * Remove `lf` if it still names the dead owner's `token` — only while holding the takeover
 * claim. Returns 'removed' | 'not_mine' (the lock changed: re-check) | 'held' (someone
 * holds the takeover claim, or it cannot be verified: no progress).
 */
function takeOver(lf, token, host) {
  const tf = `${lf}.takeover`;
  const mine = { pid: process.pid, host, token: crypto.randomBytes(12).toString('hex') };
  if (!publish(tf, mine)) return 'held';                      // a crashed taker's claim is never cleared automatically
  try {
    const now = readOwner(lf);
    if (now && now.token === token) { fs.unlinkSync(lf); return 'removed'; }
    return 'not_mine';
  } catch { return 'not_mine'; } finally {
    try { if ((readOwner(tf) || {}).token === mine.token) fs.unlinkSync(tf); } catch { /* gone */ }
  }
}

/**
 * Run fn() while holding the repository's lock.
 * @param {string} dir  the repository's memory directory
 * @param {Function} fn
 * @param {{ waitMs?: number, pollMs?: number }} [o]
 */
function withLock(dir, fn, { waitMs = 10_000, pollMs = 5 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, '.lock');
  const host = os.hostname();
  const me = { pid: process.pid, host, token: crypto.randomBytes(12).toString('hex'), at: new Date().toISOString() };
  const deadline = Date.now() + waitMs;
  let backoff = pollMs;
  for (;;) {
    if (publish(lf, me)) {
      // enter only if the published claim is ours (it can only be, unless the lock was
      // removed by hand meanwhile — then we must not enter on a claim that is gone)
      if ((readOwner(lf) || {}).token === me.token) break;
    }
    let progressed = false;
    const owner = readOwner(lf);
    if (!owner && !fs.existsSync(lf)) progressed = true;                       // released meanwhile: retry at once
    else if (owner && owner.host === host && Number.isInteger(owner.pid) && !pidAlive(owner.pid)) {
      progressed = takeOver(lf, owner.token, host) !== 'held';                // provably dead owner on this host
    }
    if (Date.now() >= deadline) throw new MemoryLockTimeout(dir, waitMs, blocker(lf, host));
    if (progressed) { backoff = pollMs; continue; }
    sleepSync(Math.max(1, Math.min(backoff, deadline - Date.now())));
    backoff = Math.min(backoff * 2, Math.max(pollMs, MAX_BACKOFF_MS));
  }
  try { return fn(); } finally {
    try { if ((readOwner(lf) || {}).token === me.token) fs.unlinkSync(lf); } catch { /* gone */ }
  }
}

module.exports = { withLock, MemoryLockTimeout };
