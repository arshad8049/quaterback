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

module.exports = { tokenize, jaccard, scoreOutcome, scoreRepair };
