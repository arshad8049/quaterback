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
 * KAN-103 / KAN-104: a draft the compiler generated gets ONE correction in total (intent/compiler.js
 * repair) before the state is 'invalid', whether the validator rejected it or the reply was not JSON
 * at all. The correction is parsed and validated from scratch by the same code, and is never
 * corrected again. A correction may not bring in a proposed default the rejected draft had not
 * already justified (same id and text, covered there). When a correction was attempted, the result carries
 *   repair: { attempted: true, rejected: [{ kind: 'invalid', contract, errors }
 *                                         | { kind: 'syntax', contract: null, diagnostic, errors, raw, raw_bytes, raw_truncated }, …] }
 * (every rejected draft, in order; `raw` is at most 16 KiB of UTF-8 of an unreadable reply).
 * If the corrective call itself fails (empty reply, network error, cancellation), the error is
 * rethrown with `error.recovery = { attempted: true, rejected, failed: { kind, message } }`.
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
    const context = survey ? survey.text : null;
    const first = await draft(() => compile(request, context, history));
    const result = first.contract;
    const cs = first.syntax ? { state: 'invalid' } : contractState(result);
    if (cs.state === 'finalized') return { format: FORMAT, state: 'finalized', contract: result, round, history, survey: grounding };
    if (cs.state === 'invalid') {
      // KAN-103 / KAN-104: ONE corrective call in total for QB's own draft, whether it was
      // unreadable or invalid; the correction is parsed and validated from scratch.
      const rejected = [first.syntax ? syntaxEntry(first.syntax) : { kind: 'invalid', contract: result, errors: cs.errors }];
      const failure = first.syntax ? { kind: 'syntax', diagnostic: first.syntax.diagnostic } : { kind: 'invalid', contract: result, errors: cs.errors };
      let second;
      try { second = await draft(() => repair(request, context, history, failure)); }
      catch (e) {
        // Re-review 1: the correction itself failed (empty reply, network, cancellation). The first
        // draft and its errors travel with the error so the caller can keep them in the run record.
        if (e && typeof e === 'object') e.recovery = { attempted: true, rejected, failed: { kind: e.code === 'DEADLINE' ? 'cancelled' : 'error', message: String(e.message || e) } };
        throw e;
      }
      if (second.syntax) {
        const errors = [`the corrected draft was not valid JSON either: ${second.syntax.diagnostic}`];
        rejected.push(syntaxEntry(second.syntax));
        return { format: FORMAT, state: 'invalid', errors, contract: null, round, history, survey: grounding, repair: { attempted: true, rejected } };
      }
      const fixed = second.contract;
      const fixedState = contractState(fixed);
      const errors = [
        ...(fixedState.state === 'invalid' ? fixedState.errors : []),
        ...(fixedState.state === 'needs_clarification' ? [`the correction asked a question instead of correcting the draft: ${fixedState.question}`] : []),
        ...(first.syntax ? [] : correctionDefaultErrors(result, fixed)),
      ];
      if (!errors.length) return { format: FORMAT, state: 'finalized', contract: fixed, round, history, survey: grounding, repair: { attempted: true, rejected } };
      rejected.push({ kind: 'invalid', contract: fixed, errors });
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

const RAW_LIMIT = 16 * 1024;   // bytes of UTF-8

/** A model call for a draft: { contract } or, when the reply was not JSON, { syntax } (KAN-104). */
async function draft(call) {
  try { return { contract: await call() }; } catch (e) { if (e && e.code === 'DRAFT_SYNTAX') return { syntax: e }; throw e; }
}

/** An unreadable draft as run evidence: the diagnostic and at most 16 KiB of the reply. */
function syntaxEntry(e) {
  const buf = Buffer.from(String(e.raw ?? ''), 'utf8');
  // Re-review 3: the limit is in UTF-8 bytes, and a cut never splits a character (back off to
  // the start of the character the limit falls in: continuation bytes are 0b10xxxxxx).
  let end = Math.min(buf.length, RAW_LIMIT);
  if (end < buf.length) while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return { kind: 'syntax', contract: null, diagnostic: e.diagnostic, errors: [`not valid JSON: ${e.diagnostic}`],
    raw: buf.subarray(0, end).toString('utf8'), raw_bytes: buf.length, raw_truncated: end < buf.length };
}

/**
 * KAN-103 (re-review 2): a correction fixes the listed errors; it does not make new choices. Its
 * proposed defaults must each be one the rejected draft had already justified — same id, same text,
 * covered by a criterion there. Anything else is refused, however it is worded: a default the
 * rejected draft left uncovered (the request did not need it) must be dropped, not cited by new
 * criteria, and a reworded or new default is a new choice.
 */
function correctionDefaultErrors(rejected, fixed) {
  if (!Array.isArray(fixed?.proposed_defaults) || !fixed.proposed_defaults.length) return [];
  const norm = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const before = validateDefaults(rejected).defaults;
  const justified = new Set(before.filter((d) => d.covered_by.length).map((d) => `${d.id}\u0000${norm(d.text)}`));
  const flagged = new Set(before.filter((d) => !d.covered_by.length).map((d) => norm(d.text)));
  return fixed.proposed_defaults.filter((d) => !(d && justified.has(`${d.id}\u0000${norm(d.text)}`))).map((d) => (flagged.has(norm(d?.text))
    ? `proposed default ${d.id} ${JSON.stringify(d.text)} was flagged as uncovered in the rejected draft; a correction must remove it, not add criteria to cite it`
    : `proposed default ${d?.id} ${JSON.stringify(d?.text)} is new in the correction; a correction may not add a choice the rejected draft had not already justified (remove it)`));
}

module.exports = { compileIntent, MAX_ROUNDS, FORMAT };
