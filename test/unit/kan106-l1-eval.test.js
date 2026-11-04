/**
 * KAN-106: scoring for the live L1 eval (bench/l1-eval). No live model: outcomes are scored from
 * real compileIntent handoffs driven by fixture replies, so the classification follows the
 * producer's actual shapes (finalized / repair / invalid / needs_clarification / thrown error).
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { compileIntent } = require('../../intent/session');
const score = require('../../bench/l1-eval/score');

const F104 = path.join(__dirname, '..', 'fixtures', 'kan104');
const read = (n) => fs.readFileSync(path.join(F104, n), 'utf8');
const REQUEST = read('request.txt').trim();
const FAITHFUL = read('faithful-draft.json');
const MALFORMED = read('malformed-draft.txt');
// a draft written for another request: its quotes are not in this one (validator rejects it)
const WRONG_REQUEST = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kan103', 'still-bad-draft.json'), 'utf8');
const TASKS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'l1-eval', 'tasks.json'), 'utf8')).tasks;
const GREETING = TASKS.find((t) => t.id === 'greeting');

async function run(replies) {
  let i = 0;
  const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try { return { s: await compileIntent(REQUEST), calls: m.calls.length }; } catch (e) { return { e, calls: m.calls.length }; } finally { m.restore(); }
}

describe('KAN-106: outcome classification through the real compileIntent', () => {
  test('finalized on the first call → first_draft', async () => {
    const { s, calls } = await run([FAITHFUL]);
    assert.equal(calls, 1);
    assert.equal(score.outcomeOf(s), 'first_draft');
  });
  test('finalized by the correction → after_correction', async () => {
    const { s } = await run([MALFORMED, FAITHFUL]);
    assert.equal(score.outcomeOf(s), 'after_correction');
  });
  test('blocked with a non-JSON last draft → invalid_syntax', async () => {
    const { s } = await run([MALFORMED, MALFORMED]);
    assert.equal(s.state, 'invalid');
    assert.equal(score.outcomeOf(s), 'invalid_syntax');
  });
  test('blocked with a rejected JSON last draft → invalid_validation, categorised', async () => {
    const { s, calls } = await run([WRONG_REQUEST, WRONG_REQUEST]);
    assert.equal(calls, 2);
    assert.equal(score.outcomeOf(s), 'invalid_validation');
    const cats = score.categorize(s.repair.rejected.flatMap((r) => r.errors));
    assert.ok(cats.quote_not_verbatim >= 2, JSON.stringify(cats));
  });
  test('a thrown deadline → timeout; any other throw → error', () => {
    assert.equal(score.outcomeOf(null, Object.assign(new Error('model call timed out after 1ms'), { code: 'DEADLINE' })), 'timeout');
    assert.equal(score.outcomeOf(null, new Error('ECONNREFUSED')), 'error');
  });
  test('a clarifying question → asked (not counted as finalized)', () => {
    assert.equal(score.outcomeOf({ state: 'needs_clarification', unresolved: [] }), 'asked');
    assert.equal(score.outcomeOf({ state: 'blocked', reason: 'clarification_rounds_exhausted' }), 'asked');
  });
});

describe('KAN-106: validator error categories', () => {
  const cases = [
    ['not valid JSON: Unexpected token / in JSON at position 120', 'syntax'],
    ['R-2 quote is not in the request verbatim: "returns Hello Arshad"', 'quote_not_verbatim'],
    ['request text not traced to any requirement: "Add node:test cases"', 'request_untraced'],
    ['requirement R-1 "x" is not covered by any acceptance criterion', 'requirement_uncovered'],
    ['proposed default D-1 "use cents" is not covered by any acceptance criterion', 'default_uncovered_or_new'],
    ['AC-3 duplicates AC-1', 'criterion_duplicate'],
    ['AC-4 traces to no requirement (unsupported addition)', 'criterion_untraced'],
    ['scope.allowed_changes entry "src/a.js" is entirely covered by scope.protected_paths "**": no change it allows could pass', 'scope_policy'],
    ['constraint 0 refers to unknown check "checks/CHK-1"', 'scope_policy'],
    ['duplicate check id CHK-1', 'check_invalid'],
    ['something new', 'other'],
  ];
  for (const [err, cat] of cases) test(`${cat}: ${err.slice(0, 40)}`, () => assert.equal(score.categoryOf(err), cat));
});

describe('KAN-106: faithfulness proxy', () => {
  test('the faithful greeting draft meets both greeting matchers', async () => {
    const { s } = await run([FAITHFUL]);
    assert.deepEqual(score.faithfulness(s, GREETING.expect_checks), { met: 2, total: 2, missing: [] });
  });
  test('call_returns with expect "Error" does not meet a call_throws matcher (the latest beta-run mistake)', () => {
    const contract = { checks: [{ id: 'C1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/config.js', export: 'parsePort', args: ['70000'], expect: 'Error' } }] };
    assert.equal(score.checkMatches(contract, { adapter: 'call_throws', export: 'parsePort', args: ['70000'] }), false);
    assert.equal(score.checkMatches({ checks: [{ adapter: 'call_throws', params: { export: 'parsePort', args: ['70000'] } }] }, { adapter: 'call_throws', export: 'parsePort', args: ['70000'] }), true);
  });
  test('values compare by JSON value: "8080" is not 8080', () => {
    const c = { checks: [{ adapter: 'call_returns', params: { export: 'parsePort', args: ['8080'], expect: '8080' } }] };
    assert.equal(score.checkMatches(c, { adapter: 'call_returns', args: ['8080'], expect: 8080 }), false);
  });
  test('no contract → null (not judged)', () => assert.equal(score.faithfulness({ state: 'invalid' }, GREETING.expect_checks), null));
});

describe('KAN-106: summary', () => {
  test('usable requires finalized AND every matcher met; rates per model', () => {
    const t = (outcome, met, total, extra = {}) => ({ model: 'm', task: 'x', outcome, calls: 1, ms: 1000, faithfulness: met === null ? null : { met, total }, ...extra });
    const [s] = score.summarize([
      t('first_draft', 2, 2), t('after_correction', 1, 2, { first_draft_failure: 'syntax' }),
      t('invalid_validation', null, null, { first_draft_failure: 'invalid', categories: { quote_not_verbatim: 3 } }), t('asked', null, null),
    ]);
    assert.equal(s.trials, 4);
    assert.equal(s.finalized, 2);
    assert.equal(s.usable, 1);
    assert.equal(s.proxy_failed, 1);
    assert.equal(s.rates.usable, 25);
    assert.deepEqual(s.first_draft_failure, { syntax: 1, invalid: 1 });
    assert.equal(s.categories.quote_not_verbatim, 3);
    assert.match(score.markdown([s]), /\| m \| 4 \| 1 \(25%\) \| 2 \|/);
  });
  test('every task has a request, files and at least one matcher', () => {
    assert.ok(TASKS.length >= 6);
    for (const k of TASKS) { assert.ok(k.request && Object.keys(k.files).length && k.expect_checks.length, k.id); }
  });
});
