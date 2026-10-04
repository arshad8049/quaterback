/**
 * memory/repairs.js — repairs linked to the patch that resolved them (QB-23).
 *
 * Before: qb.js handed memory only the FINAL report. A successful report has no
 * failed-criterion repair hints, and remember() saved hints only from a non-failing
 * report — so a controlled fail-then-pass sequence saved zero repairs, and any hint
 * that was saved was labeled `resolved` without evidence.
 *
 * Now the run loop keeps an append-only attempt history (one entry per verified
 * attempt: patch hash, evidence hash, criteria results, repair hints, verdict), and
 * each repair hint from attempt N is linked to attempt N+1 — the patch that followed
 * it — and to the hinted criterion's re-evaluation there. Three things are kept apart:
 *   the suggestion       what the verifier/model proposed (source: model_suggestion)
 *   the observation      the hinted criterion went from not met to met on a CHANGED patch
 *   the confirmation     …and the run ended in an approved PASS with it still met
 * Outcomes:
 *   resolved                       observation + confirmation (the only proven repair)
 *   observed_resolved_unconfirmed  observation, but the run did not end in an approved PASS
 *   unresolved                     unchanged / missing patch, criterion not met next time,
 *                                  or the criterion was not failing when hinted
 *   not_attempted                  no later attempt (abandoned, blocked, out of retries)
 *   not_tracked                    the hint is not about an acceptance criterion (tests,
 *                                  policy, constraints): its resolution is not attributed
 */

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));

/**
 * One attempt-history entry from a verified attempt.
 * @param {number} attempt
 * @param {object} report       the attempt's VerificationReport
 * @param {string|null} patchSha256  the run record's patch hash for this attempt (null = no patch)
 */
function attemptEntry(attempt, report, patchSha256) {
  const criteria = (report?.criteria_results || []).map((r) => ({
    id: r.id, met: r.met ?? null, method: r.method || null, evidence_ids: Array.isArray(r.evidence_ids) ? r.evidence_ids : [],
  }));
  return {
    attempt,
    patch_sha256: patchSha256 || null,
    report_id: report?.id || null,
    verdict: report?.verdict || null,
    oracle_approved: report?.oracle?.approved === true,
    // what this attempt was judged on: criteria results + QB-11 evidence IDs + test outcome
    evidence_sha256: sha256(canonical({ criteria, evidence: (report?.evidence || []).map((e) => e.id), tests: report?.test_outcome?.outcome ?? null })),
    criteria,
    repair_hints: (report?.repair_hints || []).map((h) => ({ criterion_id: String(h.criterion_id || ''), diagnosis: String(h.diagnosis || ''), suggested_fix: String(h.suggested_fix || '') })),
  };
}

/** Link every repair hint in the history to what happened next. */
function linkRepairs(history) {
  const final = history.at(-1) || null;
  const finalPass = Boolean(final && final.verdict === 'pass' && final.oracle_approved);
  const links = [];
  for (const [i, a] of history.entries()) {
    const next = history[i + 1] || null;
    const seen = new Set();
    for (const h of a.repair_hints) {
      if (seen.has(h.criterion_id)) continue;           // one link per criterion per attempt
      seen.add(h.criterion_id);
      const before = a.criteria.find((c) => c.id === h.criterion_id) || null;
      const after = next ? next.criteria.find((c) => c.id === h.criterion_id) || null : null;
      const fin = final ? final.criteria.find((c) => c.id === h.criterion_id) || null : null;
      const link = {
        criterion_id: h.criterion_id, diagnosis: h.diagnosis, fix: h.suggested_fix, source: 'model_suggestion',
        from_attempt: a.attempt, to_attempt: next ? next.attempt : null,
        patch_before_sha256: a.patch_sha256, patch_after_sha256: next ? next.patch_sha256 : null,
        before: before ? { met: before.met, method: before.method, evidence_ids: before.evidence_ids } : null,
        after: after ? { met: after.met, method: after.method, evidence_ids: after.evidence_ids } : null,
        evidence_before_sha256: a.evidence_sha256, evidence_after_sha256: next ? next.evidence_sha256 : null,
        final: final ? { attempt: final.attempt, verdict: final.verdict, oracle_approved: final.oracle_approved } : null,
      };
      const set = (outcome, reason) => links.push({ ...link, outcome, reason, resolved: outcome === 'resolved' });
      if (!before) { set('not_tracked', 'not_an_acceptance_criterion'); continue; }
      if (before.met !== false) { set('unresolved', 'criterion_was_not_failing'); continue; }
      if (!next) { set('not_attempted', 'no_later_attempt'); continue; }
      if (!next.patch_sha256) { set('unresolved', 'no_patch'); continue; }
      if (next.patch_sha256 === a.patch_sha256) { set('unresolved', 'unchanged_patch'); continue; }
      if (!after || after.met !== true) { set('unresolved', 'criterion_not_met_after_repair'); continue; }
      if (finalPass && fin && fin.met === true) set('resolved', 'met_after_repair_and_run_passed');
      else set('observed_resolved_unconfirmed', finalPass ? 'criterion_not_met_at_end' : 'run_did_not_end_in_an_approved_pass');
    }
  }
  return links;
}

module.exports = { attemptEntry, linkRepairs };
