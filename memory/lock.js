/**
 * memory/lock.js — a per-repository, cross-process lock for the memory store (QB-25).
 *
 * Synchronous (every memory critical section is a short file update):
 *   - claim: `<dir>/.lock` created exclusively (O_EXCL) with { pid, host, token };
 *   - a held claim is waited for, bounded by waitMs (polling every pollMs), then
 *     MemoryLockTimeout;
 *   - re-review 1: a claim is NEVER taken from a live owner because of its age.
 *     Takeover happens only when the owner is provably dead: same host, pid gone.
 *     A paused owner keeps its lock, so its later writes cannot overlap another
 *     writer's;
 *   - a claim from ANOTHER host cannot be verified, so it is never taken. Sharing one
 *     store across hosts (e.g. a network home directory) is unsupported, and the
 *     timeout error says so;
 *   - a lock whose content is unreadable (its owner crashed between creating and
 *     writing it — a window of microseconds) is the only case recovered by age
 *     (staleMs), because no owner can be identified;
 *   - dead-owner takeover is serialized by a second exclusive file, `.lock.takeover`.
 *     Only its holder may remove a dead owner's lock, after re-reading it under the
 *     takeover claim and checking it still names the dead owner's token. So a fresh
 *     claim made meanwhile can never be removed. A takeover claim left by a crashed
 *     waiter is cleared the same way (dead pid on this host);
 *   - release removes the lock only if it still holds our token;
 *   - re-review 2: EVERY wait iteration ends at the deadline check, whatever a recovery
 *     attempt did, so no path can spin past waitMs. A takeover claim held by a live
 *     taker (or one from another host) means no progress: the waiter backs off
 *     (doubling up to 50 ms) and times out. An incomplete (unreadable) takeover file is
 *     recovered only once it is older than 2 s (a takeover takes microseconds); before
 *     that it counts as held.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => Atomics.wait(SLEEPER, 0, 0, ms);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

class MemoryLockTimeout extends Error {
  constructor(dir, waitMs, owner) {
    const who = owner && owner.host && owner.host !== os.hostname()
      ? ` held from host ${owner.host} (pid ${owner.pid}); cross-host sharing of a memory store is not supported and the lock is never taken over by age`
      : owner && owner.pid ? ` held by live process ${owner.pid}` : '';
    super(`memory store ${dir} is locked${who} (waited ${waitMs} ms)`);
    this.code = 'MEMORY_LOCK_TIMEOUT';
  }
}

const readOwner = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// A takeover critical section is two file operations (microseconds). A takeover file that
// cannot be read (its writer crashed between creating and writing it) and is older than
// this cannot belong to a taker still at work, so it is recovered (re-review 2).
const TAKEOVER_STALE_MS = 2_000;
const MAX_BACKOFF_MS = 50;

/**
 * Move `file` aside and delete it, but only if its bytes are still `raw` — so a file
 * rewritten meanwhile is put back, never removed. Returns true if it was removed.
 */
function removeIfUnchanged(file, raw, tag) {
  const moved = `${file}.recover.${tag}`;
  try {
    fs.renameSync(file, moved);
    if (fs.readFileSync(moved, 'utf8') !== raw) { try { fs.linkSync(moved, file); } catch { /* claimed meanwhile */ } fs.unlinkSync(moved); return false; }
    fs.unlinkSync(moved);
    return true;
  } catch { return false; }   // raced: someone else moved or removed it
}

/**
 * Remove `lf` only if it still names `token` — under the takeover claim, so no fresh lock
 * is ever removed. Returns what happened, so the caller always checks its deadline and
 * backs off when it made no progress (re-review 2):
 *   'removed'   the dead owner's lock was removed (progress)
 *   'cleared'   a crashed or abandoned taker's claim was cleared (progress)
 *   'held'      another live taker holds the claim, or it cannot be verified (no progress)
 *   'not_mine'  the lock changed meanwhile, nothing removed (progress: re-check the lock)
 */
function takeOver(lf, token, host, tag) {
  const tf = `${lf}.takeover`;
  const mine = crypto.randomBytes(12).toString('hex');
  try {
    const fd = fs.openSync(tf, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token: mine }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let raw;
    let st;
    try { raw = fs.readFileSync(tf, 'utf8'); st = fs.statSync(tf); } catch { return 'cleared'; }   // gone meanwhile: retry
    let t = null;
    try { t = JSON.parse(raw); } catch { /* incomplete */ }
    if (t && typeof t === 'object') {
      // a dead taker on this host is cleared; a live one, or one from another host, holds it
      const dead = t.host === host && Number.isInteger(t.pid) && !pidAlive(t.pid);
      return dead && removeIfUnchanged(tf, raw, tag) ? 'cleared' : 'held';
    }
    // incomplete (unreadable) takeover file: recovered only once it is clearly abandoned
    return Date.now() - st.mtimeMs > TAKEOVER_STALE_MS && removeIfUnchanged(tf, raw, tag) ? 'cleared' : 'held';
  }
  try {
    const now = readOwner(lf);
    if (now && now.token === token) { fs.unlinkSync(lf); return 'removed'; }
    return 'not_mine';
  } catch { return 'not_mine'; /* already gone */ } finally {
    try { if ((readOwner(tf) || {}).token === mine) fs.unlinkSync(tf); } catch { /* gone */ }
  }
}

/**
 * Run fn() while holding the repository's lock.
 * @param {string} dir  the repository's memory directory
 * @param {Function} fn
 * @param {{ waitMs?: number, staleMs?: number, pollMs?: number }} [o]
 *   staleMs applies ONLY to an unreadable lock (no identifiable owner).
 */
function withLock(dir, fn, { waitMs = 10_000, staleMs = 30_000, pollMs = 5 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const lf = path.join(dir, '.lock');
  const token = crypto.randomBytes(12).toString('hex');
  const host = os.hostname();
  const deadline = Date.now() + waitMs;
  let lastOwner = null;
  let backoff = pollMs;
  // Re-review 2: every iteration ends at the same deadline check, whatever the recovery
  // attempt did. An attempt that made progress (lock released, dead owner removed, a
  // crashed taker cleared) retries at once; one that made none (a live owner, a live or
  // unverifiable taker, a fresh unreadable file) backs off, doubling up to MAX_BACKOFF_MS.
  for (;;) {
    try {
      const fd = fs.openSync(lf, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let progressed = false;
    const owner = readOwner(lf);
    lastOwner = owner || lastOwner;
    if (owner && owner.host === host && Number.isInteger(owner.pid) && !pidAlive(owner.pid)) {
      progressed = takeOver(lf, owner.token, host, token) !== 'held';   // dead owner on this host: race-safe removal
    } else if (!owner) {
      let st = null;
      let raw = null;
      try { st = fs.statSync(lf); raw = fs.readFileSync(lf, 'utf8'); } catch { progressed = true; }   // released meanwhile
      if (st && raw !== null && Date.now() - st.mtimeMs > staleMs && readOwner(lf) === null) {
        progressed = removeIfUnchanged(lf, raw, token);   // unreadable for a long time: no owner can be identified
      }
    }
    if (Date.now() >= deadline) throw new MemoryLockTimeout(dir, waitMs, lastOwner);
    if (progressed) { backoff = pollMs; continue; }
    sleepSync(Math.max(1, Math.min(backoff, deadline - Date.now())));
    backoff = Math.min(backoff * 2, Math.max(pollMs, MAX_BACKOFF_MS));
  }
  try { return fn(); } finally {
    try { if ((readOwner(lf) || {}).token === token) fs.unlinkSync(lf); } catch { /* gone */ }
  }
}

module.exports = { withLock, MemoryLockTimeout };
