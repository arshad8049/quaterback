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
// Re-review 1: polarity is tracked PER CLAUSE, bound to the clause's target words — a
// request-wide parity let independent reversals cancel out ("enable caching and allow
// uploads" vs "disable caching and block uploads" had equal parity). A request is split
// into clauses (and / but / then / also / except / commas …); each clause has its target
// keywords (content words, action verbs excluded) and its own polarity (flipped once per
// negator and once per antonym inside that clause). Two requests compare clause by clause:
//   conflicting  some clause pair about the same target has opposite polarity
//   ambiguous    a negative clause (an exclusion / prohibition) has no counterpart on the
//                other side, or matched clauses differ in targets or restrictions
//                (except / unless / only …: scope not established) — never actionable
//   same         every clause on both sides has a same-polarity counterpart
//   partial      the rest agree, plus extra positive clauses on one side
//   unrelated    no shared content
// Only `same` and `partial` are actionable. Lexical overlap is a hint, never semantic proof.

const NEGATORS = new Set(['not', 'no', 'never', 'without', 'nor', 'cannot', 'neither', 'nothing', 'none']);
const ANTONYMS = {
  disable: 'enable', disabled: 'enable', disables: 'enable', disabling: 'enable',
  deny: 'allow', denies: 'allow', denied: 'allow', block: 'allow', blocks: 'allow', blocked: 'allow', blocking: 'allow',
  forbid: 'allow', forbids: 'allow', forbidden: 'allow', disallow: 'allow', disallowed: 'allow',
  hide: 'show', hides: 'show', hidden: 'show',
  stop: 'start', stops: 'start', stopped: 'start', exclude: 'include', excludes: 'include', excluded: 'include',
  remove: 'add', removes: 'add', removed: 'add', delete: 'create', deletes: 'create', deleted: 'create',
  deactivate: 'activate', deactivated: 'activate', uninstall: 'install', uninstalled: 'install', unset: 'set', off: 'on',
  decrease: 'increase', decreases: 'increase', decreased: 'increase', reduce: 'increase', reduced: 'increase',
  lower: 'raise', lowered: 'raise',
  reject: 'accept', rejects: 'accept', rejected: 'accept', unlock: 'lock', close: 'open', closes: 'open', closed: 'open',
};
const STEM = {
  uploading: 'upload', uploads: 'upload', uploaded: 'upload', runs: 'run', running: 'run',
  deploys: 'deploy', deploying: 'deploy', deployed: 'deploy',
  enables: 'enable', enabled: 'enable', enabling: 'enable', allows: 'allow', allowed: 'allow', allowing: 'allow',
  shows: 'show', shown: 'show', starts: 'start', started: 'start', includes: 'include', included: 'include',
  adds: 'add', added: 'add', creates: 'create', created: 'create', activates: 'activate', activated: 'activate',
  increases: 'increase', increased: 'increase', accepts: 'accept', accepted: 'accept', opens: 'open', opened: 'open',
  installs: 'install', installed: 'install', sets: 'set', raises: 'raise', raised: 'raise', locks: 'lock', locked: 'lock',
};
// The action verbs themselves (both sides of every antonym pair, canonical forms): a
// clause is matched to its counterpart by its TARGET, not by the verb.
const ACTIONS = new Set([...Object.values(ANTONYMS), ...Object.values(ANTONYMS).map((w) => STEM[w] || w)]);
const CONTRACTION_STEMS = new Set(['don', 'doesn', 'didn', 'won', 'isn', 'aren', 'wasn', 'weren', 'shouldn', 'wouldn', 'couldn', 'can']);
const CLAUSE_SPLIT = /\b(?:and|but|then|also|plus|while|however|although|whereas)\b|[,;:.!?\n]+/;
// Re-review 2: restriction / exclusion operators stay INSIDE their clause and keep their
// scope ("except for guests", "only for admins", "unless debug mode is on"). A clause's
// restrictions are part of its identity: two clauses are the same intent only with the
// same targets AND the same restrictions — otherwise scope compatibility is not established.
const RESTRICTORS = new Set(['except', 'unless', 'only', 'excluding', 'solely', 'exclusively', 'besides', 'otherthan', 'apartfrom', 'savefor']);
const MULTIWORD_RESTRICTORS = [[/\bother\s+than\b/g, ' otherthan '], [/\bapart\s+from\b/g, ' apartfrom '], [/\bsave\s+for\b/g, ' savefor ']];

function clauseOf(text) {
  let t = text;
  for (const [re, marker] of MULTIWORD_RESTRICTORS) t = t.replace(re, marker);
  const words = t.split(/[^a-z0-9]+/).filter(Boolean);
  let polarity = 1;
  const kept = [];
  const restrictions = [];   // [{ op, scope: [] }] — words after an operator are its scope
  for (let w of words) {
    if (RESTRICTORS.has(w)) { restrictions.push({ op: w, scope: [] }); continue; }
    if (restrictions.length) restrictions[restrictions.length - 1].scope.push(STEM[w] || ANTONYMS[w] || w);
    if (NEGATORS.has(w)) { polarity = -polarity; continue; }
    if (CONTRACTION_STEMS.has(w)) continue;
    if (ANTONYMS[w]) { polarity = -polarity; w = ANTONYMS[w]; }
    kept.push(STEM[w] || w);
  }
  const keywords = [...new Set(tokenize(kept.join(' ')))];
  const targets = keywords.filter((k) => !ACTIONS.has(k));
  const restrictionSig = restrictions.map((r) => `${r.op}:${[...new Set(tokenize(r.scope.join(' ')))].sort().join(',')}`).sort();
  return { keywords, targets: targets.length ? targets : keywords, polarity, restrictions: restrictionSig };
}
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** @returns {{ keywords: string[], polarity: 1|-1, clauses: Array<{keywords, targets, polarity}> }} */
function intentOf(text) {
  const norm = String(text || '').toLowerCase().replace(/(\w+)n['’]t\b/g, '$1 not');   // don't → do not
  const clauses = norm.split(CLAUSE_SPLIT).map((c) => (c || '').trim()).filter(Boolean).map(clauseOf).filter((c) => c.keywords.length);
  const keywords = [...new Set(clauses.flatMap((c) => c.keywords))];
  const polarity = clauses.reduce((p, c) => p * c.polarity, 1);   // legacy summary only — decisions use clauses
  return { keywords, polarity, clauses };
}

const overlaps = (a, b) => a.targets.some((t) => b.targets.includes(t));

/**
 * Compare two intents clause by clause (see above). `score` is the lexical overlap,
 * halved when conflicting or ambiguous; `actionable` is true only for same / partial.
 */
function compareIntent(a, b) {
  const lexical = jaccard(a.keywords, b.keywords);
  const A = a.clauses || [{ keywords: a.keywords, targets: a.keywords, polarity: a.polarity }];
  const B = b.clauses || [{ keywords: b.keywords, targets: b.keywords, polarity: b.polarity }];
  let conflicting = false;
  let scopeMismatch = false;
  const matchedB = new Set();
  const unmatched = [];
  for (const ca of A) {
    let matched = false;
    B.forEach((cb, j) => {
      if (!overlaps(ca, cb)) return;
      matched = true;
      matchedB.add(j);
      if (ca.polarity !== cb.polarity) conflicting = true;
      // same intent needs the same targets AND the same restrictions (re-review 2): a shared
      // word alone does not establish that the two clauses have a compatible scope
      if (!sameSet(ca.targets, cb.targets) || !sameSet(ca.restrictions || [], cb.restrictions || [])) scopeMismatch = true;
    });
    if (!matched) unmatched.push(ca);
  }
  B.forEach((cb, j) => { if (!matchedB.has(j)) unmatched.push(cb); });
  let relation;
  if (lexical === 0 && !conflicting) relation = 'unrelated';
  else if (conflicting) relation = 'conflicting';
  else if (scopeMismatch || unmatched.some((c) => c.polarity < 0 || (c.restrictions || []).length)) relation = 'ambiguous';
  else relation = unmatched.length ? 'partial' : 'same';
  const actionable = relation === 'same' || relation === 'partial';
  return { lexical, score: actionable ? lexical : lexical * 0.5, conflicting, relation, actionable };
}

module.exports = { tokenize, jaccard, scoreOutcome, scoreRepair, intentOf, compareIntent };
