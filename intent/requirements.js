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
 *   - a quote is not in the request, or request words are covered by no quote
 *     (part of the request was silently dropped);
 *   - a requirement is covered by no criterion and is not marked
 *     `disposition: "context"` with a reason (e.g. a file location);
 *   - a criterion traces to no requirement (an unsupported addition) or to an
 *     unknown one;
 *   - two criteria say the same thing.
 * Applies to contracts that carry the user's request (`raw_request`), which every
 * real contract does (compiler, contract file, benchmark oracle).
 */

const STOP = new Set(['the', 'and', 'that', 'with', 'for', 'from', 'this', 'these', 'those', 'its', 'are', 'was', 'were',
  'has', 'have', 'into', 'onto', 'which', 'when', 'then', 'than', 'also', 'should', 'would', 'could', 'can', 'will', 'all',
  'any', 'each', 'some', 'such', 'so', 'but', 'not', 'our', 'your', 'their', 'there', 'here', 'like', 'just', 'add', 'make']);
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const words = (s) => (norm(s).match(/[a-z0-9_$]+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));

/** @returns {{ errors: string[], trace: Array<{ id, quote, implied, disposition, covered_by }> }} */
function validateTraceability(c) {
  const request = typeof c?.raw_request === 'string' ? c.raw_request : '';
  if (!request.trim()) return { errors: [], trace: [] };
  const errors = [];
  const reqs = Array.isArray(c.requirements) ? c.requirements : [];
  if (!reqs.length) return { errors: ['no requirements traced from the request (requirements[] is empty)'], trace: [] };

  const nreq = norm(request);
  const ids = new Set();
  const quoted = new Set();
  for (const r of reqs) {
    const id = r && typeof r.id === 'string' ? r.id : '';
    if (!/^R-\d{1,3}$/.test(id) || ids.has(id)) { errors.push(`requirement id ${JSON.stringify(r && r.id)} is missing, malformed or duplicated`); continue; }
    ids.add(id);
    if (r.implied === true) {
      if (typeof r.text !== 'string' || !r.text.trim() || typeof r.reason !== 'string' || !r.reason.trim()) errors.push(`${id} is implied but has no text or reason`);
      continue;
    }
    if (typeof r.quote !== 'string' || !r.quote.trim()) { errors.push(`${id} has no quote from the request`); continue; }
    if (!nreq.includes(norm(r.quote))) { errors.push(`${id} quote is not in the request verbatim: ${JSON.stringify(r.quote)}`); continue; }
    for (const w of words(r.quote)) quoted.add(w);
  }
  const untraced = [...new Set(words(request).filter((w) => !quoted.has(w)))];
  if (untraced.length) errors.push(`request text not traced to any requirement: ${untraced.join(', ')}`);

  const acs = Array.isArray(c.acceptance_criteria) ? c.acceptance_criteria : [];
  const coveredBy = new Map([...ids].map((id) => [id, []]));
  const seenText = new Map();
  for (const ac of acs) {
    const rid = Array.isArray(ac?.requirement_ids) ? ac.requirement_ids : [];
    if (!rid.length) errors.push(`${ac?.id} traces to no requirement (unsupported addition)`);
    for (const r of rid) {
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
    trace.push({ id: r.id, quote: r.quote ?? null, implied: r.implied === true, disposition: by.length ? 'covered' : context ? 'context' : 'uncovered', covered_by: by });
  }
  return { errors, trace };
}

module.exports = { validateTraceability };
