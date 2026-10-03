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

function contractState(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { state: 'invalid', errors: ['contract is not an object'] };
  const q = typeof c.clarifying_question === 'string' ? c.clarifying_question.trim() : '';
  if (q) return { state: 'needs_clarification', question: q };

  const errors = [];
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
  return errors.length ? { state: 'invalid', errors } : { state: 'finalized' };
}

/** One-line reason for a non-finalized state, as recorded in runs and errors. */
function stateReason(s) {
  return s.state === 'invalid' ? `invalid_contract: ${s.errors.join('; ')}` : s.state;
}

module.exports = { contractState, stateReason };
