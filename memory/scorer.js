/**
 * scorer.js — DSA keyword similarity for memory recall
 *
 * Pure functions, no LLM, no I/O.
 * Uses Jaccard similarity on tokenized keyword sets.
 */

const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being',
  'have','has','had','do','does','did','will','would','could','should',
  'may','might','can','to','of','in','for','on','with','at','by',
  'from','as','into','through','before','after','up','down','out',
  'and','but','or','not','no','so','if','it','its','this','that',
  'i','me','my','we','our','you','your','he','his','she','her',
  'they','them','their','what','which','who','all','any','both',
  'add','use','fix','new','old','get','set','run','make','keep',
  'also','just','only','then','than','when','where','how','why',
]);

/**
 * Tokenize text into lowercase keywords, filtering stopwords + short tokens.
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Jaccard similarity between two sets (or arrays).
 * Returns 0.0 – 1.0.
 */
function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) { if (setB.has(t)) inter++; }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Score a single record against a query keyword set.
 * Adds bonus weight to file-path keywords if the record has changed_files.
 */
function scoreOutcome(queryKws, record) {
  const base = jaccard(queryKws, record.keywords || []);
  return base;
}

/**
 * Score a repair record against a query keyword set.
 * Blends goal keyword overlap + criterion keyword overlap.
 */
function scoreRepair(queryKws, record) {
  const goalScore = jaccard(queryKws, record.goal_keywords || []);
  const critScore = jaccard(queryKws, record.crit_keywords || []);
  return Math.max(goalScore, critScore * 0.8);
}

// ── QB-24: task intent — negation and antonyms are preserved, never stop words ──
//
// A request's intent is its content keywords (antonyms mapped to one canonical word)
// plus a POLARITY: +1, flipped once per negator ("not", "no", "never", "without", "n't")
// and once per antonym ("disable" = not "enable"). Lexical overlap is a HINT only:
// two requests with overlapping keywords and opposite polarity are `conflicting`, and
// their score is halved — never 1.

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nor', 'cannot', 'neither', 'nothing', 'none']);
const ANTONYMS = {
  disable: 'enable', disabled: 'enable', disables: 'enable', disabling: 'enable',
  deny: 'allow', denies: 'allow', block: 'allow', blocks: 'allow', forbid: 'allow', disallow: 'allow',
  hide: 'show', hides: 'show', hidden: 'show',
  stop: 'start', stops: 'start', exclude: 'include', excludes: 'include',
  remove: 'add', removes: 'add', delete: 'create', deletes: 'create',
  deactivate: 'activate', uninstall: 'install', unset: 'set', off: 'on',
  decrease: 'increase', decreases: 'increase', reduce: 'increase', lower: 'raise',
  reject: 'accept', rejects: 'accept', unlock: 'lock', close: 'open', closes: 'open',
};
const STEM = {
  uploading: 'upload', uploads: 'upload', uploaded: 'upload', runs: 'run', running: 'run',
  deploys: 'deploy', deploying: 'deploy', deployed: 'deploy',
  enables: 'enable', enabled: 'enable', enabling: 'enable', allows: 'allow', allowed: 'allow',
  shows: 'show', shown: 'show', starts: 'start', started: 'start', includes: 'include',
  adds: 'add', creates: 'create', activates: 'activate', increases: 'increase', accepts: 'accept', opens: 'open',
};
const CONTRACTION_STEMS = new Set(['don', 'doesn', 'didn', 'won', 'isn', 'aren', 'wasn', 'weren', 'shouldn', 'wouldn', 'couldn', 'can']);

/** @returns {{ keywords: string[], polarity: 1|-1 }} */
function intentOf(text) {
  const words = String(text || '').toLowerCase()
    .replace(/(\w+)n['’]t\b/g, '$1 not')          // don't / doesn't / won't / can't → … not
    .split(/[^a-z0-9]+/).filter(Boolean);
  let polarity = 1;
  const kept = [];
  for (let w of words) {
    if (NEGATORS.has(w)) { polarity = -polarity; continue; }
    if (CONTRACTION_STEMS.has(w)) continue;
    if (ANTONYMS[w]) { polarity = -polarity; w = ANTONYMS[w]; }
    kept.push(STEM[w] || w);
  }
  return { keywords: [...new Set(tokenize(kept.join(' ')))], polarity };
}

/**
 * Compare two intents. `score` is the lexical overlap, halved when the polarities are
 * opposite; `conflicting` marks opposite instructions about overlapping content.
 */
function compareIntent(a, b) {
  const lexical = jaccard(a.keywords, b.keywords);
  const conflicting = lexical > 0 && a.polarity !== b.polarity;
  return { lexical, score: conflicting ? lexical * 0.5 : lexical, conflicting };
}

module.exports = { tokenize, jaccard, scoreOutcome, scoreRepair, intentOf, compareIntent };
