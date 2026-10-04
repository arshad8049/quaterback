/**
 * intent/contract-state.js — is a contract final enough to act on? (QB-08)
 *
 *   finalized            goal, nonempty acceptance criteria with unique ids and
 *                        nonblank text, and no open clarifying question
 *   needs_clarification  the compiler asked a question; it must be answered first
 *   invalid              anything else (empty or missing ACs, missing goal,
 *                        duplicate ids, not an object)
 *
 * Every boundary that could act on a contract checks this: the agent runner,
 * the verifier, the CLI and the benchmark. Only `finalized` may execute an
 * agent or be verified.
 */

const crypto = require('crypto');
const { validateExamples } = require('./examples');
const { policyErrors } = require('../verify/policy');
const { testPolicyErrors } = require('../verify/tests');
const { preservationErrors } = require('../verify/preservation');
const { validateTraceability, validateDefaults } = require('./requirements');

function contractState(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { state: 'invalid', errors: ['contract is not an object'] };
  const q = typeof c.clarifying_question === 'string' ? c.clarifying_question.trim() : '';
  if (q) return { state: 'needs_clarification', question: q };

  const errors = [];
  // QB-17: the compiler records what its output lacked instead of filling it in.
  if (Array.isArray(c.incomplete) && c.incomplete.length) {
    const missing = c.incomplete.filter((x) => x.startsWith('missing ')).map((x) => x.slice(8));
    const other = c.incomplete.filter((x) => !x.startsWith('missing '));
    errors.push(`incomplete compiler output: ${[...other, ...(missing.length ? [`missing ${missing.join(', ')}`] : [])].join('; ')}`);
  }
  if (typeof c.goal !== 'string' || !c.goal.trim()) errors.push('missing goal');
  const acs = c.acceptance_criteria;
  if (!Array.isArray(acs) || acs.length === 0) errors.push('no acceptance criteria');
  else {
    const seen = new Set();
    for (const [i, ac] of acs.entries()) {
      const id = ac && typeof ac.id === 'string' ? ac.id.trim() : '';
      if (!id) errors.push(`criterion ${i + 1} has no id`);
      else if (seen.has(id)) errors.push(`duplicate criterion id ${id}`);
      else seen.add(id);
      if (!ac || typeof ac.criterion !== 'string' || !ac.criterion.trim()) errors.push(`criterion ${id || i + 1} has no text`);
    }
  }
  // QB-09: the scope and constraint policy must be well-formed (they are enforced, not advisory text).
  if (!errors.length) errors.push(...policyErrors(c), ...testPolicyErrors(c), ...preservationErrors(c));
  // QB-13: every computable example is recomputed with trusted arithmetic; a wrong
  // one makes the contract invalid (it is never corrected to fit).
  if (!errors.length) {
    for (const e of validateExamples(c).errors) errors.push(`${e.where} example is wrong: ${e.claim} (correct: ${e.correct})`);
  }
  // QB-14: every request clause traced; no uncovered requirement, unsupported addition or duplicate AC.
  if (!errors.length) errors.push(...validateDefaults(c).errors, ...validateTraceability(c).errors);
  return errors.length ? { state: 'invalid', errors } : { state: 'finalized' };
}

/**
 * QB-13: the contract's identity as a test oracle — what was approved. Covers
 * the goal, requirements, criteria (id, text, kind), verification plan and
 * checks; not trusted metadata or per-run results (met).
 */
function approvedContent(c) {
  return {
    goal: c?.goal ?? null, required_behavior: c?.required_behavior ?? [], constraints: c?.constraints ?? [],
    acceptance_criteria: (c?.acceptance_criteria || []).map((a) => ({ id: a.id, criterion: a.criterion, kind: a.kind || 'behavioral',
      requirement_ids: a.requirement_ids ?? [], ...(a.preserves !== undefined ? { preserves: a.preserves } : {}) })),   // QB-15
    requirements: c?.requirements ?? [],   // QB-14
    verification_plan: c?.verification_plan ?? [], checks: c?.checks ?? [],
    scope: { allowed_changes: c?.scope?.allowed_changes ?? [], protected_paths: c?.scope?.protected_paths ?? [] },   // QB-09
    constraint_policy: c?.constraint_policy ?? [],
    // QB-10: waiving pre-existing test failures is part of the approved oracle (absent → not hashed, so older approvals stay valid)
    ...(c?.test_policy !== undefined ? { test_policy: c.test_policy } : {}),
    // QB-17: QB's proposed defaults are approved with the oracle (absent → not hashed)
    ...(c?.proposed_defaults !== undefined ? { proposed_defaults: c.proposed_defaults } : {}),
  };
}
function contractHash(c) {
  return crypto.createHash('sha256').update(canonical(approvedContent(c))).digest('hex');
}
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));

/** Record a human's approval of this exact contract (freezes it: any later change voids it). */
function approve(c, { via, by = 'human', note = null } = {}) {
  return { ...c, approval: { by, via, note, at: new Date().toISOString(), contract_hash: contractHash(c) } };
}

/** { approved, reason } — approved only by a human, for this exact (unchanged) contract. */
function approvalState(c) {
  const a = c?.approval;
  if (!a) return { approved: false, reason: 'not_approved' };
  if (a.by !== 'human') return { approved: false, reason: 'not_approved_by_a_human' };
  if (a.contract_hash !== contractHash(c)) return { approved: false, reason: 'changed_after_approval' };
  return { approved: true, reason: `approved via ${a.via}` };
}

/** One-line reason for a non-finalized state, as recorded in runs and errors. */
function stateReason(s) {
  return s.state === 'invalid' ? `invalid_contract: ${s.errors.join('; ')}` : s.state;
}

module.exports = { contractState, stateReason, contractHash, approvedContent, approve, approvalState };
