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
  test('proxy pass requires finalized AND every matcher met; rates per run group', () => {
    const t = (outcome, met, total, extra = {}) => ({ model: 'm', task: 'x', outcome, calls: 1, ms: 1000, faithfulness: met === null ? null : { met, total }, ...extra });
    const [s] = score.summarize([
      t('first_draft', 2, 2), t('after_correction', 1, 2, { first_draft_failure: 'syntax' }),
      t('invalid_validation', null, null, { first_draft_failure: 'invalid', categories: { quote_not_verbatim: 3 } }), t('asked', null, null),
    ]);
    assert.equal(s.trials, 4);
    assert.equal(s.finalized, 2);
    assert.equal(s.proxy_pass, 1);
    assert.equal(s.proxy_failed, 1);
    assert.equal(s.rates.proxy_pass, 25);
    assert.equal(s.usable, undefined, 'the measure is called proxy pass, not usable');
    assert.deepEqual(s.first_draft_failure, { syntax: 1, invalid: 1 });
    assert.equal(s.categories.quote_not_verbatim, 3);
    const md = score.markdown([s]);
    assert.match(md, /\| m \| 4 \| 1 \(25%\) \| 2 \|/);
    assert.match(md, /proxy pass/);
    assert.match(md, /does NOT establish that a contract is complete or correct/);
    assert.doesNotMatch(md, /usable/i);
  });
  test('every task has a request, files and at least one matcher; every matcher pins adapter and module', () => {
    assert.ok(TASKS.length >= 6);
    for (const k of TASKS) {
      assert.ok(k.request && Object.keys(k.files).length && k.expect_checks.length, k.id);
      for (const m of k.expect_checks) {
        assert.ok(m.adapter, `${k.id}: adapter`);
        assert.ok(m.module || m.module_matches, `${k.id}: module`);
        assert.ok(m.args !== undefined || m.where, `${k.id}: args or a relation`);
        if (m.where) assert.ok(score.RELATIONS[m.where], `${k.id}: relation ${m.where}`);
      }
    }
  });
});

describe('KAN-106 review 3: matchers check every field they name', () => {
  const task = (id) => TASKS.find((t) => t.id === id);
  const chk = (adapter, params) => ({ id: 'C', ac_id: 'AC-1', adapter, params });
  const meets = (id, checks) => score.faithfulness({ state: 'finalized', contract: { checks } }, task(id).expect_checks);
  const G = (module, args, expect) => chk('call_returns', { module, export: 'greeting', args, expect });

  test('greeting: the right values in the WRONG module fail', () => {
    assert.equal(meets('greeting', [G('src/greeting.js', ['Arshad'], 'Hello, Arshad!'), G('src/greeting.js', [], 'Hello from Node Project JS!')]).met, 2);
    assert.equal(meets('greeting', [G('src/other.js', ['Arshad'], 'Hello, Arshad!'), G('src/other.js', [], 'Hello from Node Project JS!')]).met, 0);
  });
  test('cart: an irrelevant call_throws (no negative quantity, or not a cart module) fails', () => {
    const T = (module, args) => chk('call_throws', { module, export: 'addItem', args });
    assert.equal(meets('cart', [T('src/cart.js', ['apple', -1, 199])]).met, 1);
    assert.equal(meets('cart', [T('src/lib/shopping-cart.mjs', [{ sku: 'a', qty: -2 }])]).met, 1);
    assert.equal(meets('cart', [T('src/cart.js', ['apple', 'x'])]).met, 0, 'no negative argument');
    assert.equal(meets('cart', [T('src/index.js', ['apple', -1])]).met, 0, 'not a cart module');
    assert.equal(meets('cart', [T('test/cart.test.js', ['apple', -1])]).met, 0, 'not under src/');
    assert.equal(meets('cart', [chk('call_returns', { module: 'src/cart.js', export: 'addItem', args: ['apple', -1], expect: 'Error' })]).met, 0, 'not a throws check');
  });
  test('clamp: each bound needs a check of that relation in src/utils.js', () => {
    const C = (args, expect, module = 'src/utils.js') => chk('call_returns', { module, export: 'clamp', args, expect });
    assert.equal(meets('clamp', [C([-5, 0, 10], 0), C([50, 0, 10], 10), C([7, 0, 10], 7)]).met, 3);
    assert.equal(meets('clamp', [C([7, 0, 10], 7)]).met, 1, 'in-range only');
    assert.equal(meets('clamp', [C([-5, 0, 10], -5), C([50, 0, 10], 50), C([7, 0, 10], 0)]).met, 0, 'wrong expected values');
    assert.equal(meets('clamp', [C([-5, 0, 10], 0, 'src/clamp.js'), C([50, 0, 10], 10, 'src/clamp.js'), C([7, 0, 10], 7, 'src/clamp.js')]).met, 0, 'wrong module');
    assert.equal(meets('clamp', [chk('module_exports', { module: 'src/utils.js', export: 'clamp', type: 'function' })]).met, 0, 'export check alone');
  });
  test('port: the right args with the wrong export or module fail', () => {
    assert.equal(meets('port', [chk('call_returns', { module: 'src/config.js', export: 'parsePort', args: ['8080'], expect: 8080 }), chk('call_throws', { module: 'src/config.js', export: 'parsePort', args: ['70000'] })]).met, 2);
    assert.equal(meets('port', [chk('call_returns', { module: 'src/config.js', export: 'parse', args: ['8080'], expect: 8080 }), chk('call_throws', { module: 'src/port.js', export: 'parsePort', args: ['70000'] })]).met, 0);
  });
  test('an unknown relation is an error, not a silent pass', () => {
    assert.throws(() => score.checkMatches({ checks: [] }, { adapter: 'call_returns', where: 'nope' }), /unknown matcher relation nope/);
  });
  test('rescore ignores the proxy stored in the row and uses the current matchers', () => {
    const row = { model: 'm', task: 'greeting', outcome: 'first_draft', faithfulness: { met: 2, total: 2 }, contract: { checks: [G('src/other.js', ['Arshad'], 'Hello, Arshad!')] }, rejected: [] };
    assert.equal(score.rescore(row, task('greeting')).faithfulness.met, 0);
  });
});

describe('KAN-106 review 1: summary regeneration from published (compressed) results', () => {
  const os = require('os');
  const zlib = require('zlib');
  const { writeSummary } = require('../../bench/l1-eval');
  const PUBLISHED = path.join(__dirname, '..', '..', 'bench', 'results', 'l1-eval', '2026-11-04');
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kan106-'));

  test('--summarize reads the committed .jsonl.gz trials (pre-fix: an empty summary)', () => {
    const dir = tmp();
    try {
      for (const f of fs.readdirSync(PUBLISHED).filter((n) => n.endsWith('.jsonl.gz'))) fs.copyFileSync(path.join(PUBLISHED, f), path.join(dir, f));
      const s = writeSummary(dir);
      assert.equal(s.reduce((n, g) => n + g.trials, 0), 60);
      assert.deepEqual(s.map((g) => g.model).sort(), ['deepseek-r1:7b', 'qwen2.5-coder:14b']);
      assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /\| deepseek-r1:7b \| 30 \|/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('plain and compressed trial files in one directory are both read', () => {
    const dir = tmp();
    const row = (model) => JSON.stringify({ model, task: 'greeting', outcome: 'asked', rejected: [] }) + '\n';
    try {
      fs.writeFileSync(path.join(dir, 'trials-a.jsonl'), row('a'));
      fs.writeFileSync(path.join(dir, 'trials-b.jsonl.gz'), zlib.gzipSync(row('b')));
      assert.deepEqual(writeSummary(dir).map((g) => g.model).sort(), ['a', 'b']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('no trials: refuses and leaves an existing summary untouched', () => {
    const dir = tmp();
    try {
      fs.writeFileSync(path.join(dir, 'summary.md'), 'KEEP\n');
      assert.throws(() => writeSummary(dir), (e) => e.code === 'NO_TRIALS' && /summary not written/.test(e.message));
      assert.equal(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), 'KEEP\n');
      assert.equal(fs.existsSync(path.join(dir, 'summary.json')), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('KAN-106 review 2: run identity and pooling', () => {
  const { runIdentity } = require('../../bench/l1-eval');
  test('a run records the task set, code and settings it ran with', () => {
    const r = runIdentity();
    assert.match(r.task_set_sha256, /^[0-9a-f]{64}$/);
    assert.match(r.code_sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.settings.model_call_timeout_ms, Number(process.env.QB_MODEL_CALL_TIMEOUT_MS) > 0 ? Number(process.env.QB_MODEL_CALL_TIMEOUT_MS) : 180000);
    assert.ok('model_concurrency' in r.settings && 'ollama_host' in r.settings);
  });
  test('two runs under one model name with different code or settings are not pooled', () => {
    const run = (code, timeout) => ({ task_set_sha256: 't', code_sha256: code, settings: { model_call_timeout_ms: timeout } });
    const t = (r, outcome) => ({ model: 'm', digest: 'd', run: r, task: 'x', outcome, rejected: [] });
    const groups = score.summarize([t(run('c1', 180000), 'asked'), t(run('c1', 180000), 'asked'), t(run('c2', 180000), 'asked'), t(run('c1', 600000), 'asked')]);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups.map((g) => g.trials), [2, 1, 1]);
    assert.deepEqual(groups.map((g) => g.label), ['m #1', 'm #2', 'm #3']);
    assert.ok(groups.every((g) => /not pooled/.test(g.warning)));
    assert.match(score.markdown(groups), /\*\*Warning:\*\* 3 incompatible runs under m/);
  });
  test('a different model digest under the same name is a separate group', () => {
    const groups = score.summarize([{ model: 'm', digest: 'd1', task: 'x', outcome: 'asked' }, { model: 'm', digest: 'd2', task: 'x', outcome: 'asked' }]);
    assert.equal(groups.length, 2);
  });
  test('one run per model: no warning, plain label', () => {
    const groups = score.summarize([{ model: 'a', task: 'x', outcome: 'asked' }, { model: 'b', task: 'x', outcome: 'asked' }]);
    assert.deepEqual(groups.map((g) => [g.label, g.warning]), [['a', null], ['b', null]]);
  });
});
