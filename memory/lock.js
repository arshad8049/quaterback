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
  constructor(dir, waitMs, owner) {
    const who = owner && owner.host && owner.host !== os.hostname()
      ? ` held from host ${owner.host} (pid ${owner.pid}); cross-host sharing of a memory store is not supported and the lock is never taken over by age`
      : owner && owner.pid ? ` held by live process ${owner.pid}` : '';
    super(`memory store ${dir} is locked${who} (waited ${waitMs} ms)`);
    this.code = 'MEMORY_LOCK_TIMEOUT';
  }
}

const readOwner = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

/** Remove `lf` only if it still names `token` — under the takeover claim, so no fresh lock is ever removed. */
function takeOver(lf, token, host) {
  const tf = `${lf}.takeover`;
  const mine = crypto.randomBytes(12).toString('hex');
  try {
    const fd = fs.openSync(tf, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token: mine }));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const t = readOwner(tf);
    if (t && t.host === host && Number.isInteger(t.pid) && !pidAlive(t.pid)) { try { fs.unlinkSync(tf); } catch { /* cleared meanwhile */ } }
    return;   // someone else is taking over (or we just cleared a crashed taker); retry the claim
  }
  try {
    const now = readOwner(lf);
    if (now && now.token === token) fs.unlinkSync(lf);
  } catch { /* already gone */ } finally {
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
  for (;;) {
    try {
      const fd = fs.openSync(lf, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: new Date().toISOString() }));
      fs.closeSync(fd);
      break;
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const owner = readOwner(lf);
    lastOwner = owner || lastOwner;
    if (owner && owner.host === host && Number.isInteger(owner.pid) && !pidAlive(owner.pid)) {
      takeOver(lf, owner.token, host);          // dead owner on this host: race-safe removal
      continue;
    }
    if (!owner) {
      let st = null;
      try { st = fs.statSync(lf); } catch { continue; }   // released meanwhile
      if (Date.now() - st.mtimeMs > staleMs) {           // unreadable for a long time: no owner can be identified
        const raw = (() => { try { return fs.readFileSync(lf, 'utf8'); } catch { return null; } })();
        if (raw !== null && readOwner(lf) === null) {
          const moved = `${lf}.unreadable.${token}`;
          try { fs.renameSync(lf, moved); if (fs.readFileSync(moved, 'utf8') !== raw) { try { fs.linkSync(moved, lf); } catch { /* claimed */ } } fs.unlinkSync(moved); } catch { /* raced */ }
          continue;
        }
      }
    }
    if (Date.now() >= deadline) throw new MemoryLockTimeout(dir, waitMs, lastOwner);
    sleepSync(pollMs);
  }
  try { return fn(); } finally {
    try { if ((readOwner(lf) || {}).token === token) fs.unlinkSync(lf); } catch { /* gone */ }
  }
}

module.exports = { withLock, MemoryLockTimeout };
