/**
 * intent/requirements.js — every request clause has a traceable disposition (QB-14).
 *
 * The contract lists `requirements`, each with a stable id (R-1, R-2, …) and a
 * `quote` that must appear VERBATIM in the user's request (checked here, not
 * trusted from the model), or `implied: true` with its own text and a reason
 * (shown to the human). Acceptance criteria name the requirements they cover in
 * `requirement_ids`.
 *
 * A contract is not executable when:
 *   - a quote is not in the request, or any substantive part of the request lies
 *     outside every quote's span (part of the request was silently dropped).
 *     Coverage is by source position: each quote claims one span (`occurrence`
 *     picks among repeats), so a repeated word never covers another clause, and
 *     negation, numbers and operators always count;
 *   - a requirement is covered by no criterion and is not marked
 *     `disposition: "context"` with a reason (e.g. a file location);
 *   - a criterion traces to no requirement (an unsupported addition) or to an
 *     unknown one;
 *   - two criteria say the same thing.
 * Applies to contracts that carry the user's request (`raw_request`), which every
 * real contract does (compiler, contract file, benchmark oracle).
 */

// Request text that needs no requirement of its own: articles and pure connectives.
// Deliberately tiny — negation ("not", "no", "never", "without"), numbers, units,
// comparison words and operators are NEVER in it, and there is no length cutoff.
const FILLER = new Set(['a', 'an', 'the', 'and', 'that', 'which', 'please']);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
// Tokens with their positions in the normalized request: words/numbers, and runs of
// symbols. Fail closed: EVERY symbol counts (!, !=, &&, ?., -, (), [], {}, %, …),
// except prose punctuation glued to the end of a word and followed by whitespace or
// the end of the text (the sentence-final "." in "Return !isAdmin.", the "," in
// "Do it, then"): that suffix is trimmed. "!isAdmin" keeps its "!", "%." its "%",
// and a free-standing " ?? " or " ! " always counts.
const TOKEN = /[\p{L}\p{N}_$]+(?:[.'][\p{L}\p{N}_$]+)*|[^\s\p{L}\p{N}_$]+/gu;
const PROSE_END = /[.,;:?!"'\u2019\u201d\u00bb\u2026]+$/u;   // brackets are never prose-exempt: "()" / "[0]" count
function tokens(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    let t = m[0];
    const end = m.index + t.length;
    const glued = m.index > 0 && !/\s/.test(text[m.index - 1]);           // attached to the end of a word: "isAdmin."
    if (!/^[\p{L}\p{N}_$]/u.test(t) && glued && (end === text.length || /\s/.test(text[end]))) t = t.replace(PROSE_END, '');
    if (t) out.push({ t, start: m.index, end: m.index + t.length });
  }
  return out;
}
const occurrences = (hay, needle) => { const at = []; for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) at.push(i); return at; };

/** @returns {{ errors: string[], trace: Array<{ id, quote, span, implied, disposition, reason, covered_by }> }} */
function validateTraceability(c) {
  const request = typeof c?.raw_request === 'string' ? c.raw_request : '';
  if (!request.trim()) return { errors: [], trace: [] };
  const errors = [];
  const reqs = Array.isArray(c.requirements) ? c.requirements : [];
  if (!reqs.length) return { errors: ['no requirements traced from the request (requirements[] is empty)'], trace: [] };

  // Each quote claims ONE source span of the request (QB-14 re-review): coverage is by
  // position, so a word repeated elsewhere never covers an unquoted clause. A quote
  // that occurs more than once must say which occurrence it means (`occurrence`, 1-based).
  const nreq = norm(request);
  const ids = new Set();
  const spans = new Map();   // id → [start, end) in the normalized request
  for (const r of reqs) {
    const id = r && typeof r.id === 'string' ? r.id : '';
    if (!/^R-\d{1,3}$/.test(id) || ids.has(id)) { errors.push(`requirement id ${JSON.stringify(r && r.id)} is missing, malformed or duplicated`); continue; }
    ids.add(id);
    if (r.implied === true) {
      if (typeof r.text !== 'string' || !r.text.trim() || typeof r.reason !== 'string' || !r.reason.trim()) errors.push(`${id} is implied but has no text or reason`);
      continue;
    }
    if (typeof r.quote !== 'string' || !r.quote.trim()) { errors.push(`${id} has no quote from the request`); continue; }
    const q = norm(r.quote);
    const at = occurrences(nreq, q);
    if (!at.length) { errors.push(`${id} quote is not in the request verbatim: ${JSON.stringify(r.quote)}`); continue; }
    if (r.occurrence !== undefined && (!Number.isInteger(r.occurrence) || r.occurrence < 1 || r.occurrence > at.length)) {
      errors.push(`${id} occurrence ${JSON.stringify(r.occurrence)} is not one of the ${at.length} occurrence(s) of its quote`); continue;
    }
    if (at.length > 1 && r.occurrence === undefined) { errors.push(`${id} quote ${JSON.stringify(r.quote)} occurs ${at.length} times in the request; say which (occurrence)`); continue; }
    const start = at[(r.occurrence || 1) - 1];
    spans.set(id, [start, start + q.length]);
  }

  // Every substantive token must lie inside some claimed span; report each uncovered
  // stretch of the request as the human would read it.
  const claimed = [...spans.values()];
  const inSpan = (tk) => claimed.some(([s, e]) => tk.start >= s && tk.end <= e);
  const runs = [];
  let cur = null;
  for (const tk of tokens(nreq)) {
    if (inSpan(tk)) { cur = null; continue; }
    if (FILLER.has(tk.t)) { if (cur) cur.end = tk.end; continue; }
    if (cur) { cur.end = tk.end; cur.substantive = true; } else { cur = { start: tk.start, end: tk.end, substantive: true }; runs.push(cur); }
  }
  for (const run of runs) errors.push(`request text not traced to any requirement: ${JSON.stringify(nreq.slice(run.start, run.end))}`);

  const acs = Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria : [];
  const coveredBy = new Map([...ids].map((id) => [id, []]));
  const seenText = new Map();
  for (const ac of acs) {
    const rid = Array.isArray(ac?.requirement_ids) ? ac.requirement_ids : [];
    if (!rid.length) errors.push(`${ac?.id} traces to no requirement (unsupported addition)`);
    for (const r of rid) {
      if (/^D-/.test(r)) continue;            // a proposed default (QB-17): checked by validateDefaults
      if (!coveredBy.has(r)) errors.push(`${ac?.id} names unknown requirement ${JSON.stringify(r)}`);
      else coveredBy.get(r).push(ac.id);
    }
    const t = norm(ac?.criterion).replace(/[^a-z0-9 ]/g, '');
    if (t && seenText.has(t)) errors.push(`${ac.id} duplicates ${seenText.get(t)}`);
    else if (t) seenText.set(t, ac.id);
  }
  const trace = [];
  for (const r of reqs) {
    if (!r || !ids.has(r.id)) continue;
    const by = coveredBy.get(r.id) || [];
    const context = r.disposition === 'context' && typeof r.reason === 'string' && r.reason.trim();
    if (!by.length && !context) errors.push(`requirement ${r.id} ${JSON.stringify(r.quote || r.text)} is not covered by any acceptance criterion`);
    trace.push({ id: r.id, quote: r.quote ?? null, span: spans.get(r.id) || null, implied: r.implied === true,
      disposition: by.length ? 'covered' : context ? 'context' : 'uncovered', reason: typeof r.reason === 'string' ? r.reason : null, covered_by: by });
  }
  return { errors, trace };
}

/**
 * QB-17: proposed defaults — what QB chose where the request is silent (e.g. the
 * error when min > max). Each has an id D-n, the choice, and why it was needed.
 * They are never applied silently: each must be covered by an acceptance criterion
 * (which names it in requirement_ids), is part of the approved oracle (hash), and
 * is shown to the human in its own section of the approval view.
 * @returns {{ errors: string[], defaults: Array<{ id, text, reason, covered_by }> }}
 */
function validateDefaults(c) {
  const list = c?.proposed_defaults;
  const acs = Array.isArray(c?.acceptance_criteria) ? c.acceptance_criteria : [];
  const errors = [];
  if (list !== undefined && !Array.isArray(list)) return { errors: ['proposed_defaults must be an array'], defaults: [] };
  const ids = new Map();
  for (const d of list || []) {
    const id = d && typeof d.id === 'string' ? d.id : '';
    if (!/^D-\d{1,3}$/.test(id) || ids.has(id)) { errors.push(`proposed default id ${JSON.stringify(d && d.id)} is missing, malformed or duplicated`); continue; }
    if (typeof d.text !== 'string' || !d.text.trim() || typeof d.reason !== 'string' || !d.reason.trim()) { errors.push(`${id} has no text or reason`); continue; }
    ids.set(id, { id, text: d.text, reason: d.reason, covered_by: [] });
  }
  for (const ac of acs) {
    for (const r of Array.isArray(ac?.requirement_ids) ? ac.requirement_ids : []) {
      if (!/^D-/.test(r)) continue;
      if (ids.has(r)) ids.get(r).covered_by.push(ac.id);
      else errors.push(`${ac?.id} names unknown requirement ${JSON.stringify(r)}`);
    }
  }
  for (const d of ids.values()) if (!d.covered_by.length) errors.push(`proposed default ${d.id} ${JSON.stringify(d.text)} is not covered by any acceptance criterion`);
  return { errors, defaults: [...ids.values()] };
}

module.exports = { validateTraceability, validateDefaults };
