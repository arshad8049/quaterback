/**
 * bench/adjudicate.js — blinded adjudication of the items the grader could not decide
 * (QB-27). Only checks a frozen spec lists in `suite.adjudicate_checks` ever reach here;
 * grader and infrastructure errors do not.
 *
 *   prepare(items, { seed })  → { packets, blindMap }
 *     packets: what an adjudicator sees — a random item id, the task prompt, the human
 *       requirement, the adjudication rules, the patch, and which checks are reserved.
 *       NO arm label, trial id, internal QB verdict, timing or other metadata. Order is
 *       shuffled from the seed (reproducible) so arms are not grouped.
 *     blindMap: item id → { trial_id, arm }, stored SEPARATELY (qb-blind-map/1) and not
 *       shown to adjudicators.
 *   record(dir, verdict)      one qb-adjudication/1 file per (item, adjudicator), created
 *       exclusively: a verdict is never overwritten or edited.
 *   summarize(dir)            every verdict per item; `agreed` only when all adjudicators
 *       agree on pass or fail — disagreements and 'unsure' stay visible, never resolved
 *       by majority.
 *
 * Blinding is imperfect: an adjudicator may still recognise an arm from the patch's
 * style (e.g. comments or structure typical of a pipeline). That limitation is reported.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const S = require('./schemas');

/** Deterministic PRNG (mulberry32) from a seed string — reproducible shuffles. */
function rng(seed) {
  let a = parseInt(S.sha256(Buffer.from(String(seed))).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, seed) {
  const r = rng(seed); const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/**
 * @param {Array<{ trial_id, arm, spec, patch, grade }>} items  graded needs_adjudication items
 * @param {{ seed: string }} o
 */
function prepare(items, { seed }) {
  if (!seed) throw new Error('prepare: a seed is required (recorded for reproducibility)');
  const packets = []; const map = {};
  for (const it of shuffle(items, seed)) {
    if (!it.grade || it.grade.outcome !== 'needs_adjudication') throw new Error(`item ${it.trial_id}/${it.arm} is not awaiting adjudication`);
    const item_id = `item-${S.sha256(Buffer.from(`${seed}\0${it.trial_id}\0${it.arm}`)).slice(0, 12)}`;
    map[item_id] = { trial_id: it.trial_id, arm: it.arm };
    packets.push({
      item_id,
      prompt: it.spec.prompt,
      requirement: it.spec.requirement,
      adjudication_rules: it.spec.adjudication_rules,
      reserved_checks: it.grade.checks.filter((c) => c.status === 'adjudicate').map((c) => c.name),
      other_checks: it.grade.checks.filter((c) => c.status !== 'adjudicate'),
      patch: it.patch,
    });
  }
  return { packets, blindMap: { schema: 'qb-blind-map/1', seed, items: map } };
}

/** Record one adjudicator's verdict — never overwrites (exclusive create). */
function record(dir, v) {
  const a = S.Adjudication.parse({ schema: 'qb-adjudication/1', ...v });
  fs.mkdirSync(dir, { recursive: true });
  const who = crypto.createHash('sha256').update(a.adjudicator).digest('hex').slice(0, 12);
  const file = path.join(dir, `${a.item_id}.${who}.json`);
  fs.writeFileSync(file, JSON.stringify(a, null, 2) + '\n', { flag: 'wx' });
  return file;
}

/** All verdicts per item, with agreement made explicit (no majority resolution). */
function summarize(dir) {
  const by = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort() : []) {
    const a = S.Adjudication.parse(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    (by[a.item_id] = by[a.item_id] || []).push({ adjudicator: a.adjudicator, verdict: a.verdict, rationale: a.rationale });
  }
  return Object.fromEntries(Object.entries(by).map(([id, vs]) => {
    const kinds = new Set(vs.map((v) => v.verdict));
    const agreed = kinds.size === 1 && !kinds.has('unsure') ? [...kinds][0] : null;
    return [id, { verdicts: vs, agreed, disagreement: kinds.size > 1 }];
  }));
}

module.exports = { prepare, record, summarize, shuffle };
