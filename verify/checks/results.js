/**
 * verify/checks/results.js — validate the check runner's output (QB-16).
 *
 * Accepted only if complete and exactly one result per requested check, in
 * order, with a known status. Anything else is unusable: no result is filled
 * in, and the affected criteria stay without an executed check.
 */

const STATUSES = new Set(['pass', 'fail', 'error']);

/**
 * @param {string|null} text - /out/qb-checks.json from sandbox stage ⑥
 * @param {Array} requested  - the accepted checks that were sent to the runner
 * @param {string} [expectedHash] - checkSetHash of the contract's checks; the runner's must match
 * @returns {{ ok: true, results: Array } | { ok: false, reason: string }}
 */
function validateCheckResults(text, requested, expectedHash) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof text !== 'string') return bad('no_check_results');
  let doc;
  try { doc = JSON.parse(text); } catch { return bad('malformed_check_results'); }
  if (!doc || doc.format !== 'qb-check-results/1' || doc.complete !== true || !Array.isArray(doc.results)) return bad('incomplete_check_results');
  // Bound to the exact definitions: the runner's hash of what it received (QB-16 review).
  if (expectedHash !== undefined && doc.check_set_hash !== expectedHash) return bad('check_set_mismatch');
  if (doc.results.length !== requested.length) return bad('check_results_mismatch');
  for (const [i, r] of doc.results.entries()) {
    const c = requested[i];
    if (!r || r.id !== c.id || r.ac_id !== c.ac_id || r.adapter !== c.adapter || !STATUSES.has(r.status)) return bad('check_results_mismatch');
  }
  return { ok: true, results: doc.results.map((r) => ({
    id: r.id, ac_id: r.ac_id, adapter: r.adapter, status: r.status,
    detail: String(r.detail || ''), ...(r.observed !== undefined ? { observed: String(r.observed) } : {}),
    duration_ms: Number.isInteger(r.duration_ms) ? r.duration_ms : null,
  })) };
}

module.exports = { validateCheckResults };
