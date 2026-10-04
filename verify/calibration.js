/**
 * verify/calibration.js — measure the judge against independently labeled patches (QB-15).
 *
 * Each labeled item is { id, criterion, diff, files?, label: "met" | "not_met" }, the
 * label written by a person before the judge ever saw the patch. For every item the
 * judge is sampled N times on the same evidence (QB-11 bundle); strategies are then
 * scored on the SAME samples, at their real cost in calls:
 *   single       the first vote                                     1 call / item
 *   majority-3   strict majority of 3, else abstain (QB's judge)    3 calls / item
 *   unanimous-3  all 3 agree, else abstain                          3 calls / item
 *
 * Three outcomes are measured separately — never folded into one "accuracy":
 *   false_accept   judge says met, label is not_met   (rate over not_met items)
 *   false_reject   judge says not met, label is met   (rate over met items)
 *   abstain        judge says null                    (rate over all items)
 */

const { buildEvidence } = require('./evidence');

/** Count the three error kinds (and correct decisions) for rows of { label, vote }. */
function score(rows) {
  const met = rows.filter((r) => r.label === 'met');
  const notMet = rows.filter((r) => r.label === 'not_met');
  const s = {
    items: rows.length,
    false_accept: notMet.filter((r) => r.vote === true).length,
    false_reject: met.filter((r) => r.vote === false).length,
    abstain: rows.filter((r) => r.vote === null).length,
    correct: rows.filter((r) => (r.label === 'met' && r.vote === true) || (r.label === 'not_met' && r.vote === false)).length,
  };
  return { ...s,
    false_accept_rate: notMet.length ? s.false_accept / notMet.length : 0,
    false_reject_rate: met.length ? s.false_reject / met.length : 0,
    abstention_rate: rows.length ? s.abstain / rows.length : 0 };
}

const majority = (v) => {
  const t = v.filter((x) => x === true).length;
  const f = v.filter((x) => x === false).length;
  const need = Math.floor(v.length / 2) + 1;
  return t >= need ? true : f >= need ? false : null;
};
const unanimous = (v) => (v.every((x) => x === true) ? true : v.every((x) => x === false) ? false : null);

/**
 * @param {Array} items - labeled patches
 * @param {object} o
 * @param {number} [o.votes=3]
 * @param {Function} [o.sample]    (item, i) => true|false|null   one vote (tests, replay)
 * @param {Function} [o.sampleAll] (item, n) => Promise<votes[]>  n votes at once (live judge)
 */
async function calibrate(items, { votes = 3, sample, sampleAll } = {}) {
  const perItem = [];
  for (const item of items) {
    const v = sampleAll ? await sampleAll(item, votes) : await Promise.all(Array.from({ length: votes }, (_, i) => sample(item, i)));
    perItem.push({ id: item.id, label: item.label, votes: v });
  }
  const strategy = (name, calls, pick) => ({ name, calls_per_item: calls, ...score(perItem.map((r) => ({ label: r.label, vote: pick(r.votes) }))) });
  const strategies = [
    strategy('single', 1, (v) => v[0]),
    strategy(`majority-${votes}`, votes, majority),
    strategy(`unanimous-${votes}`, votes, unanimous),
  ];
  const [one, maj] = strategies;
  const d = (k) => `${one[k]}→${maj[k]}`;
  const equal_cost = `majority-${votes} spends ${votes}× the calls of a single judge on the same items; on these samples it changes `
    + `false accepts ${d('false_accept')}, false rejects ${d('false_reject')}, abstentions ${d('abstain')} `
    + `(correct ${d('correct')} of ${perItem.length}). Extra votes are worth their cost only if this reduces errors.`;
  return { items: perItem.length, votes, strategies, per_item: perItem, equal_cost };
}

/** Live sampling with QB's real judge on each item's evidence bundle. */
function liveSampler() {
  const { sampleVotes } = require('./judge');
  return async (item, n) => {
    const bundle = buildEvidence({ criterion: item.criterion, diff: item.diff, files: item.files || [], tree: null });
    return sampleVotes({ id: item.id, criterion: item.criterion }, bundle, n);
  };
}

module.exports = { score, calibrate, liveSampler, majority, unanimous };
