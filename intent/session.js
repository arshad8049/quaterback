/**
 * intent/session.js — grounded compilation with bounded clarification (QB-17).
 *
 * The one entry point root (qb.js) and standalone (intent/cli.js) compilation
 * share:
 *   1. survey the repository (intent/survey.js) BEFORE semantic compilation;
 *   2. compile with the survey and every answer so far (round by round);
 *   3. while the compiler (DSA rule or model) still has an open question, use the
 *      next answer — from `answers`, or `ask(handoff)` — for at most `maxRounds`
 *      rounds; an answer that does not resolve the choice keeps it open.
 *
 * Returns a machine-readable handoff state a caller or UI can store and resume:
 *   { state: 'finalized', contract, round, history, survey }
 *   { state: 'needs_clarification', round, max_rounds, unresolved: [{ id, question, choices, flag }], history, survey }
 *   { state: 'blocked', reason: 'clarification_rounds_exhausted', round, max_rounds, unresolved, history, survey }
 *   { state: 'invalid', errors, contract, history, survey }
 * Only 'finalized' carries an executable contract.
 *
 * KAN-103: a draft the compiler generated and the validator rejected gets ONE correction
 * (intent/compiler.js repair) before the state is 'invalid': the request, the rejected draft and
 * its errors go back to the compiler, and the correction goes through the same validator. A
 * correction may not keep a proposed default the rejected draft left uncovered (it must drop it,
 * not add criteria to cite it). When a correction was attempted, the result carries
 *   repair: { attempted: true, rejected: [{ contract, errors }, …] }   (every rejected draft, in order)
 * The contract is never approved here; approval stays with the caller (QB-13).
 */

const { compile, repair } = require('./compiler');
const { contractState } = require('./contract-state');
const { surveyRepository, surveySummary } = require('./survey');
const { parseSelection, answerText } = require('./dsa');
const { validateDefaults } = require('./requirements');

const MAX_ROUNDS = 3;
const FORMAT = 'qb-intent-handoff/1';

/**
 * @param {string} request
 * @param {object} [o]
 * @param {string|null} [o.repoPath]   repository to survey (null: no grounding)
 * @param {Array<string|{question, choice}>} [o.answers]  answers for rounds 1..n, in order: free text
 *                                     (bound to the question asked that round) or a structured selection
 *                                     "<question id>=<choice id>" / { question, choice } (bound to that question)
 * @param {Function} [o.ask]           async (handoff) => answer|null, when answers run out
 * @param {number} [o.maxRounds]
 */
async function compileIntent(request, { repoPath = null, answers = [], ask = null, maxRounds = MAX_ROUNDS } = {}) {
  const survey = repoPath ? surveyRepository(repoPath, request) : null;
  const grounding = surveySummary(survey);
  const history = [];
  for (let round = 1; ; round++) {
    const result = await compile(request, survey ? survey.text : null, history);
    const cs = contractState(result);
    if (cs.state === 'finalized') return { format: FORMAT, state: 'finalized', contract: result, round, history, survey: grounding };
    if (cs.state === 'invalid') {
      // KAN-103: one correction of QB's own draft, checked by the same validator.
      const rejected = [{ contract: result, errors: cs.errors }];
      const fixed = await repair(request, survey ? survey.text : null, history, result, cs.errors);
      const fixedState = contractState(fixed);
      const errors = [
        ...(fixedState.state === 'invalid' ? fixedState.errors : []),
        ...(fixedState.state === 'needs_clarification' ? [`the correction asked a question instead of correcting the draft: ${fixedState.question}`] : []),
        ...keptFlaggedDefaults(result, fixed),
      ];
      if (!errors.length) return { format: FORMAT, state: 'finalized', contract: fixed, round, history, survey: grounding, repair: { attempted: true, rejected } };
      rejected.push({ contract: fixed, errors });
      return { format: FORMAT, state: 'invalid', errors, contract: fixed, round, history, survey: grounding, repair: { attempted: true, rejected } };
    }

    const unresolved = Array.isArray(result.unresolved) && result.unresolved.length ? result.unresolved
      : [{ id: `Q-${round}`, question: cs.question, choices: [], flag: (result.ambiguity_flags || [])[0] || null }];
    const open = { format: FORMAT, round, max_rounds: maxRounds, unresolved, ambiguity_flags: result.ambiguity_flags || [], history: [...history], survey: grounding };
    if (round > maxRounds) return { ...open, state: 'blocked', reason: 'clarification_rounds_exhausted', round: maxRounds };
    let answer = answers[round - 1];
    const empty = (a) => a === undefined || a === null || !answerText(a).trim();
    if (empty(answer) && ask) answer = await ask({ ...open, state: 'needs_clarification' });
    if (empty(answer)) return { ...open, state: 'needs_clarification' };
    // Bind the answer to its question: a structured selection names it; free text
    // answers the question asked this round (the first open one).
    const sel = parseSelection(answer);
    // (a follow-up "<rule>.target" belongs to its rule: a selection naming the rule answers it)
    const asked = (sel && unresolved.find((u) => u.id === sel.question || u.parent === sel.question)) || unresolved[0];
    history.push({ round, question_id: asked.id, question: asked.question, answer: answerText(answer).trim() });
  }
}

/**
 * KAN-103: a proposed default the rejected draft left uncovered is one the request did not need.
 * A correction must drop it; keeping it (matched by text, whatever its id) is an error, even when
 * new criteria now cite it and the validator alone would accept the contract.
 */
function keptFlaggedDefaults(rejected, fixed) {
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const flagged = new Set(validateDefaults(rejected).defaults.filter((d) => !d.covered_by.length).map((d) => norm(d.text)));
  if (!flagged.size || !Array.isArray(fixed?.proposed_defaults)) return [];
  return fixed.proposed_defaults.filter((d) => d && flagged.has(norm(d.text)))
    .map((d) => `proposed default ${d.id} ${JSON.stringify(d.text)} was flagged as uncovered in the rejected draft; a correction must remove it, not add criteria to cite it`);
}

module.exports = { compileIntent, MAX_ROUNDS, FORMAT };
