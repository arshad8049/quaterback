/**
 * verify/judge-cache.js — one judgment per piece of evidence (QB-15).
 *
 * Identical low-temperature calls share blind spots, and re-asking can flip a vote
 * without any change to the code. So a judgment is cached under a key that covers
 * everything it depended on: the model, the judge prompt, the criterion, and the
 * content-addressed evidence it saw (QB-11 IDs, plus what was missing). Re-verifying
 * an unchanged patch returns the same judgment instead of resampling it; a changed
 * patch has new evidence IDs, hence a new key.
 *
 * Only real judgments are cached (status ok / invalid_judgment). A judge outage is
 * infrastructure, not a judgment, and is retried next time. A cache entry that does
 * not parse or does not match the judgment shape is ignored (and replaced).
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 1;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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

function openCache(dir) {
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = (key) => path.join(dir, `${key}.json`);
  return {
    get(key) {
      try {
        const j = JSON.parse(fs.readFileSync(file(key), 'utf8'));
        return validJudgment(j) ? j : null;
      } catch { return null; }
    },
    set(key, judgment) {
      if (!validJudgment(judgment)) return;
      const tmp = `${file(key)}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(judgment), { mode: 0o600 });
      fs.renameSync(tmp, file(key));
    },
  };
}

module.exports = { openCache, judgmentKey, defaultJudgeCacheDir };
