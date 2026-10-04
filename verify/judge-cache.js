/**
 * verify/judge-cache.js — one authoritative judgment per piece of evidence (QB-15).
 *
 * Identical low-temperature calls share blind spots, and re-asking can flip a vote
 * without any change to the code. So a judgment is cached under a key that covers
 * everything it depended on: the model, the judge prompt, the criterion, and the
 * content-addressed evidence it saw (QB-11 IDs, plus what was missing). Re-verifying
 * an unchanged patch returns the same judgment instead of resampling it; a changed
 * patch has new evidence IDs, hence a new key.
 *
 * Concurrency (re-review 1): reading the cache, judging, then writing is not enough —
 * two runs could both judge the same evidence and disagree. So the evidence is
 * CLAIMED before sampling, across processes:
 *   - claim: `<key>.lock` created exclusively (O_EXCL) with { pid, host, token };
 *     the owner refreshes its mtime (heartbeat) while judging;
 *   - everyone else waits (bounded, `waitMs`), re-reading the cache; a claim whose
 *     owner is dead (same host, pid gone) or silent (mtime older than `staleMs`) is
 *     taken over — by atomic rename, so only one waiter wins it;
 *   - after claiming, the cache is re-read before sampling;
 *   - publish is no-overwrite (hard link of a temp file): the FIRST published
 *     decision is authoritative and a competing writer gets it back, never its own;
 *   - a wait that runs out returns no decision (the caller reports it unresolved).
 * Only real judgments are cached (status ok / invalid_judgment); a judge outage is
 * infrastructure and is retried. A corrupt entry is ignored.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 1;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envMs = (name, dflt) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : dflt; };

function defaultJudgeCacheDir() {
  return process.env.QB_JUDGE_CACHE_DIR || path.join(os.homedir(), '.qb', 'judge-cache');
}

/** The cache key for one criterion's judgment. */
function judgmentKey({ model, prompt, criterion, kind, bundle, text }) {
  const evidence = bundle
    ? { shown: bundle.shown.map((it) => it.id), missing: bundle.missing.map((m) => `${m.what}|${m.reason}`) }
    : { text: sha256(String(text || '')) };
  return sha256(JSON.stringify({ v: VERSION, model, prompt: sha256(prompt), criterion, kind, evidence }));
}

const validJudgment = (j) => j && typeof j === 'object' && (j.met === true || j.met === false || j.met === null)
  && typeof j.evidence === 'string' && Array.isArray(j.votes) && ['ok', 'invalid_judgment'].includes(j.judgment_status);

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
};

/**
 * @param {string} dir
 * @param {object} [o]
 * @param {number} [o.waitMs]      how long to wait for another owner (default 15 min, QB_JUDGE_LOCK_WAIT_MS)
 * @param {number} [o.staleMs]     a claim whose heartbeat is older is abandoned (default 60 s)
 * @param {number} [o.heartbeatMs] owner heartbeat interval (default 5 s)
 * @param {number} [o.pollMs]      waiter poll interval (default 200 ms)
 */
function openCache(dir, o = {}) {
  if (!dir) return null;
  const waitMs = o.waitMs ?? envMs('QB_JUDGE_LOCK_WAIT_MS', 15 * 60_000);
  const staleMs = o.staleMs ?? 60_000;
  const heartbeatMs = o.heartbeatMs ?? 5_000;
  const pollMs = o.pollMs ?? 200;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key) => path.join(dir, `${key}.json`);
  const lockFile = (key) => path.join(dir, `${key}.lock`);
  const host = os.hostname();

  const get = (key) => {
    try { const j = JSON.parse(fs.readFileSync(file(key), 'utf8')); return validJudgment(j) ? j : null; } catch { return null; }
  };

  /** Publish without overwrite. Returns the authoritative judgment (ours, or the one already published). */
  const publish = (key, judgment) => {
    if (!validJudgment(judgment)) return judgment;
    const tmp = `${file(key)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(judgment), { mode: 0o600 });
    try { fs.linkSync(tmp, file(key)); return judgment; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const existing = get(key);
      if (existing) return existing;
      fs.renameSync(tmp, file(key));   // the existing entry was corrupt: replace it
      return judgment;
    } finally { try { fs.unlinkSync(tmp); } catch { /* already moved */ } }
  };

  /** Is the current claim abandoned? (dead owner on this host, or no heartbeat for staleMs) */
  const stale = (lf) => {
    let st, owner;
    try { st = fs.statSync(lf); owner = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch { return { stale: false }; }
    const dead = owner && owner.host === host && Number.isInteger(owner.pid) && !pidAlive(owner.pid);
    return { stale: dead || Date.now() - st.mtimeMs > staleMs, token: owner && owner.token };
  };

  /** Claim the key. Resolves { release } once owned, or { timedOut: true } after waitMs. */
  const acquire = async (key) => {
    const lf = lockFile(key);
    const token = crypto.randomBytes(12).toString('hex');
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const fd = fs.openSync(lf, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, host, token, at: new Date().toISOString() }));
        fs.closeSync(fd);
        const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(lf, t, t); } catch { /* lost */ } }, heartbeatMs);
        beat.unref();
        return {
          release() {
            clearInterval(beat);
            try { if (JSON.parse(fs.readFileSync(lf, 'utf8')).token === token) fs.unlinkSync(lf); } catch { /* gone */ }
          },
        };
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      if (get(key)) return { published: true };
      const s = stale(lf);
      if (s.stale) {
        // Take over by atomic rename; only one waiter's rename succeeds. Verify it was
        // the abandoned claim we judged (not a fresh one created meanwhile).
        const moved = `${lf}.stale.${token}`;
        try {
          fs.renameSync(lf, moved);
          const was = JSON.parse(fs.readFileSync(moved, 'utf8'));
          if (was.token !== s.token) { try { fs.linkSync(moved, lf); } catch { /* someone claimed meanwhile */ } }
          fs.unlinkSync(moved);
        } catch { /* another waiter took it over */ }
        continue;
      }
      if (Date.now() >= deadline) return { timedOut: true };
      await sleep(pollMs);
    }
  };

  return { get, publish, acquire, set: publish };
}

module.exports = { openCache, judgmentKey, defaultJudgeCacheDir };
