/**
 * lib/sandbox/admission.js — beta admission (agent-sandbox.md §8.1).
 *
 * One run per QB installation: an exclusive lock file holding the owner's
 * identity (pid + start time), taken before any per-run resource exists and
 * released at removal. A lock whose owner is gone is reclaimed. At admission
 * the host must also have MemAvailable ≥ per-run peak + reserve (Linux; on
 * other hosts the check is recorded as not performed).
 *
 * Scope: per installation (its state directory) and point-in-time. It does not
 * coordinate with other installations or users, and unrelated applications can
 * still consume memory after admission (§8.1).
 */

const fs = require('fs');
const path = require('path');
const P = require('./protocol');

const GiB = 1024 ** 3;

const MiB = 1024 ** 2;
/**
 * Default volume caps (bytes). These are ceilings on what each tmpfs volume may
 * hold, not what it uses. Halved from the first §8.1 draft so a 16 GB host can
 * admit a run; configurable per installation.
 */
const DEFAULT_CAPS = Object.freeze({
  work: 1 * GiB, deps: 1.5 * GiB, scratch: 1 * GiB, git: 512 * MiB, verify: 1 * GiB,
  out: 65 * MiB, cred: 1 * MiB, sock: 1 * MiB,
});
/** Stage working sets (estimates until measured; §8.1). */
const WORKING_SET = Object.freeze({ seed: 0.5 * GiB, deps: 2 * GiB, agent: 2 * GiB, capture: 1 * GiB, verify: 2 * GiB });
/** Volumes each stage can write (§8.1 table). */
const WRITES = Object.freeze({
  seed: ['work', 'git'], deps: ['scratch', 'deps'], agent: ['work'], capture: ['git', 'verify', 'out'], verify: ['verify'],
});

/** §8.1 rule: (1.1 × writable caps + working set) × 1.25, rounded up to 256 MiB. */
function stageMemoryLimit(stage, caps = DEFAULT_CAPS) {
  const writable = WRITES[stage].reduce((n, v) => n + caps[v], 0);
  const bytes = (1.1 * writable + WORKING_SET[stage]) * 1.25;
  const step = 256 * 1024 ** 2;
  return Math.ceil(bytes / step) * step;
}

/**
 * Per-run peak: every volume at its cap ×1.1 (measured tmpfs overhead), plus the
 * largest stage's own working set ×1.25, plus Ⓟ, Ⓚ and three /tmp mounts.
 * A stage's writes are counted once, in the volumes: its memory limit covers the
 * same pages, so adding the limit as well would double-count them.
 */
function perRunPeak(caps = DEFAULT_CAPS) {
  const volumes = Object.values(caps).reduce((a, b) => a + b, 0) * 1.1;
  const working = Math.max(...Object.values(WORKING_SET)) * 1.25;
  const support = 256 * MiB + 64 * MiB + 3 * 256 * MiB;
  return Math.ceil(volumes + working + support);
}

function memAvailable(meminfo) {
  const text = meminfo !== undefined ? meminfo
    : (fs.existsSync('/proc/meminfo') ? fs.readFileSync('/proc/meminfo', 'utf8') : null);
  if (text == null) return null;
  const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text);
  return m ? Number(m[1]) * 1024 : null;
}

/**
 * Take the installation's run slot. Returns { ok, release } or { ok:false, reason, ... }.
 * @param {string} stateDir - the installation's sandbox state directory
 */
function admit(stateDir, { runId, reserveBytes = 2 * GiB, caps = DEFAULT_CAPS, meminfo } = {}) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = path.join(stateDir, 'admission.lock');
  const me = { ...P.identity(process.pid), run_id: runId, at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify(me)); fs.fsyncSync(fd); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const owner = P.readJson(lock);
      if (owner && P.alive(owner)) return { ok: false, reason: 'run_in_progress', owner_run: owner.run_id };
      fs.rmSync(lock, { force: true });           // stale: owner gone, reclaim once
      if (attempt === 1) return { ok: false, reason: 'run_in_progress', owner_run: owner && owner.run_id };
    }
  }
  const release = () => {
    const cur = P.readJson(lock);
    if (cur && cur.pid === me.pid && cur.start === me.start) fs.rmSync(lock, { force: true });
  };
  const peak = perRunPeak(caps);
  const avail = memAvailable(meminfo);
  if (avail == null) return { ok: true, release, memory_checked: false, peak };
  if (avail < peak + reserveBytes) {
    release();
    return { ok: false, reason: 'insufficient_host_resources', mem_available: avail, needed: peak + reserveBytes };
  }
  return { ok: true, release, memory_checked: true, peak, mem_available: avail };
}

module.exports = { admit, perRunPeak, stageMemoryLimit, memAvailable, DEFAULT_CAPS };
