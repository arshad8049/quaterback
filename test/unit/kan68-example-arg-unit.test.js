/**
 * KAN-68: validateExamples() took a call_returns argument's unit from the FIRST unit word left in
 * the criterion + goal after removing "<number> <unit>" pairs. In real compiler output (local
 * deepseek-r1:7b, 2026-10-14) that word was the OUTPUT unit ("converts … to seconds") or a
 * spelled-out bound ("under one minute"), so a correct example quoted verbatim from the request,
 * 30000 ms → "30s", was rejected as "30000 seconds → '30s'" / "30000 minute → '30s'" and the
 * contract was never run (3 of 6 real attempts).
 *
 * The argument's unit now comes only from statements bound to it: a unit attached to that same
 * number ("30000 ms", "30,000 ms", "30000ms") and a unit named as the CHECKED export's parameter
 * ("formatDuration(ms)"). All such statements are collected; conflicting units or none → "not
 * checked", never correct and never a guess from other unit words (re-review 10301 removed the
 * leftover-word fallback and the first-match early returns).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { validateExamples } = require('../../intent/examples');
const { contractState } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const REQUEST = 'formatDuration should show durations under one minute as seconds only, for example 30000 ms as "30s" instead of "0m 30s". Durations of one minute or more keep the current format.';
const check = (id, ac, arg, expect) => ({ id, ac_id: ac, adapter: 'call_returns', plan_item: 0,
  params: { module: 'src/duration.js', export: 'formatDuration', args: [arg], expect } });
// Criterion and goal text as the model wrote them in the rejected attempt.
const CAPTURED = {
  goal: 'formatDuration should display durations under one minute as seconds only, e.g., 30000 ms as "30s" instead of "0m 30s". Durations of one minute or more should remain in the current format.',
  acceptance_criteria: [
    { id: 'AC-1', criterion: 'The function correctly converts durations under 60,000 ms to seconds', kind: 'behavioral' },
    { id: 'AC-2', criterion: 'The function leaves durations of 60,000 ms or more unchanged', kind: 'behavioral' }],
  checks: [check('CHK-1', 'AC-1', 30000, '30s'), check('CHK-2', 'AC-2', 60000, '1m')],
};
const where = (r) => r.map((e) => [e.where, e.claim]);

describe('KAN-68: a check argument\'s unit is the unit of that argument', () => {
  test('the captured contract: correct examples are checked as milliseconds (pre-fix: "30000 seconds", "60000 minute" → wrong)', () => {
    const { errors, checked } = validateExamples(CAPTURED);
    assert.deepEqual(where(errors), []);
    assert.deepEqual(where(checked), [['CHK-1', "30000 ms → '30s'"], ['CHK-2', "60000 ms → '1m'"]]);
  });

  test('an output unit ("to seconds") or a spelled-out bound ("one minute") is never the argument\'s unit', () => {
    for (const [goal, criterion] of [
      ['Show short durations in seconds', 'converts the duration to seconds'],
      ['Durations under one minute are shown as seconds only', 'formats durations under one minute'],
    ]) {
      const c = { goal, acceptance_criteria: [{ id: 'AC-1', criterion, kind: 'behavioral' }], checks: [check('CHK-1', 'AC-1', 30000, '30s')] };
      const { errors, checked } = validateExamples(c);
      assert.deepEqual([where(errors), where(checked)], [[], []], `${goal} / ${criterion}: not checked, not wrong`);
    }
  });

  test('wrong examples are still caught: unit attached to the number, comma-grouped, or named as the parameter', () => {
    for (const [goal, criterion, arg] of [
      ['Add formatDuration', 'formats 30000 ms as a short string', 30000],
      ['Add formatDuration', 'formats 30,000 milliseconds as a short string', 30000],
      ['Add formatDuration(ms) to src/duration.js', 'formats durations', 30000],
      ['Show durations in seconds', 'formatDuration(30000ms) under one minute shows seconds', 30000],
    ]) {
      const c = { goal, acceptance_criteria: [{ id: 'AC-1', criterion, kind: 'behavioral' }], checks: [check('CHK-1', 'AC-1', arg, '5m')] };
      const { errors } = validateExamples(c);
      assert.deepEqual(errors.map((e) => e.where), ['CHK-1'], `${goal} / ${criterion}`);
      assert.match(errors[0].claim, /^30000 (ms|milliseconds) → '5m'$/);
      assert.equal(errors[0].correct, '30s');
      assert.equal(contractState(c).state, 'invalid');
    }
  });

  test('a unit stated for a different number does not transfer; two candidate units are ambiguous → not checked', () => {
    const c = (goal, criterion) => ({ goal, acceptance_criteria: [{ id: 'AC-1', criterion, kind: 'behavioral' }], checks: [check('CHK-1', 'AC-1', 30000, '5m')] });
    assert.deepEqual(where(validateExamples(c('Add formatDuration', 'returns minutes for 90000 ms')).errors), [], 'unit attached to 90000, not 30000; "minutes" is an output unit');
    assert.deepEqual(where(validateExamples(c('Accepts seconds or minutes', 'formats a duration')).errors), [], 'seconds vs minutes: ambiguous');
  });

  test('re-review 10301: conflicting bound units, another function’s signature and unrelated unit words are not checked', () => {
    const c = (goal, criterion, expect = '5m') => ({ goal, acceptance_criteria: [{ id: 'AC-1', criterion, kind: 'behavioral' }],
      checks: [check('CHK-1', 'AC-1', 30000, expect)] });
    for (const [goal, criterion, label] of [
      ['Add formatDuration', 'Accept either 30000 ms or 30000 seconds', 'same number, two units (pre-rework: ms, first match)'],
      ['Keep sleep(seconds) unchanged. Add formatDuration for short durations.', 'formats durations', 'another function’s parameter (pre-rework: seconds)'],
      ['Add formatDuration', 'Preserve the seconds label', 'unrelated unit word (pre-rework: seconds)'],
      ['Add formatDuration(ms)', 'formatDuration(30000) handles 30000 seconds', 'signature and attached unit disagree'],
      ['Add formatDuration(seconds) and parseDuration(ms)', 'formats 30000 ms', 'attached ms vs the checked export’s seconds'],
    ]) {
      const r = validateExamples(c(goal, criterion));
      assert.deepEqual([where(r.errors), where(r.checked)], [[], []], label);
    }
    // controls: the same texts with the conflict removed are checked and the wrong example caught
    assert.deepEqual(where(validateExamples(c('Add formatDuration', 'Accept 30000 ms')).errors), [['CHK-1', "30000 ms → '5m'"]]);
    assert.deepEqual(where(validateExamples(c('Keep sleep(seconds) unchanged. Add formatDuration(ms).', 'formats durations')).errors), [['CHK-1', "30000 ms → '5m'"]]);
  });

  test('through the real compiler: the captured criteria no longer make the contract invalid', async () => {
    const { compile } = require('../../intent/compiler');
    const reply = { ...CAPTURED, required_behavior: ['durations under one minute show seconds only'], constraints: [],
      requirements: [{ id: 'R-1', quote: REQUEST }], verification_plan: ['call formatDuration(30000)', 'call formatDuration(60000)'],
      relevant_context: [], ambiguity_flags: [], clarifying_question: null };
    for (const ac of reply.acceptance_criteria) ac.requirement_ids = ['R-1'];
    const m = mockFetch(ollamaReply(reply));
    try {
      const s = contractState(await compile(REQUEST));
      assert.doesNotMatch((s.errors || []).join(' | '), /example is wrong/);
      assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    } finally { m.restore(); }
  });
});
