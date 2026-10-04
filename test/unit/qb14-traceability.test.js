/**
 * QB-14: the AC checklist must cover the essential requested behaviour.
 * - every explicit request clause has a stable requirement id with a VERBATIM quote,
 *   and a traceable disposition (covered by ACs, or context with a reason);
 * - uncovered requirements, unsupported additions and duplicate ACs block execution;
 * - behaviour over time is checkable (call_sequence): a constant-zero VAD fails after
 *   simulated events; duration accumulates, resets per instance, and stays
 *   independent across instances.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateTraceability } = require('../../intent/requirements');
const { contractState, approve } = require('../../intent/contract-state');
const { validateChecks, checkSetHash } = require('../../verify/checks/registry');
const { validateCheckResults } = require('../../verify/checks/results');
const { verify } = require('../../verify/verifier');
const { formatOracle } = require('../../intent/oracle-view');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const T005 = require('../../bench/results/T-005_1790656354435.json').qb.contract;      // the saved artifact from the review
const REQUEST = T005.raw_request;
const REQS = [
  { id: 'R-1', quote: 'Add a getVADStats() function to src/vad.js' },
  { id: 'R-2', quote: 'returns an object with speechCount (number of speech events detected)' },
  { id: 'R-3', quote: 'and totalSpeechMs (cumulative ms of detected speech)' },
  { id: 'R-4', quote: 'tracked since the AdaptiveVAD was created' },
];
const ACS = [
  { id: 'AC-1', criterion: 'getVADStats() is a method of AdaptiveVAD in src/vad.js', requirement_ids: ['R-1'] },
  { id: 'AC-2', criterion: 'speechCount counts every detected speech event', requirement_ids: ['R-2'] },
  { id: 'AC-3', criterion: 'totalSpeechMs accumulates the duration of every speech event', requirement_ids: ['R-3'] },
  { id: 'AC-4', criterion: 'stats start at zero for each new AdaptiveVAD and are independent between instances', requirement_ids: ['R-4'] },
];
const traced = (extra = {}) => ({ id: 'c', raw_request: REQUEST, goal: T005.goal, clarifying_question: null, requirements: REQS, acceptance_criteria: ACS, ...extra });

describe('every request clause has a traceable disposition', () => {
  test('the saved T-005 contract traces nothing to the request → not executable (pre-fix: finalized)', () => {
    const s = contractState(T005);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join(' '), /no requirements traced from the request/);
  });
  test('a traced contract: every clause quoted verbatim, every requirement covered', () => {
    const r = validateTraceability(traced());
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.trace.map((t) => [t.id, t.disposition, t.covered_by]), [['R-1', 'covered', ['AC-1']], ['R-2', 'covered', ['AC-2']], ['R-3', 'covered', ['AC-3']], ['R-4', 'covered', ['AC-4']]]);
    assert.equal(contractState(traced()).state, 'finalized');
  });
  const BAD = {
    'a dropped clause (the "tracked since" part)':   [traced({ requirements: REQS.slice(0, 3), acceptance_criteria: ACS.slice(0, 3) }), /request text not traced to any requirement: "tracked since the adaptivevad was created"/],
    'a quote not in the request':                     [traced({ requirements: [...REQS.slice(0, 3), { id: 'R-4', quote: 'tracked per session' }] }), /R-4 quote is not in the request verbatim/],
    'an uncovered requirement':                       [traced({ acceptance_criteria: ACS.slice(0, 3) }), /requirement R-4 .* is not covered by any acceptance criterion/],
    'an unsupported addition':                        [traced({ acceptance_criteria: [...ACS, { id: 'AC-5', criterion: 'logs every frame to the console', requirement_ids: [] }] }), /AC-5 traces to no requirement \(unsupported addition\)/],
    'an unknown requirement':                         [traced({ acceptance_criteria: [...ACS.slice(0, 3), { ...ACS[3], requirement_ids: ['R-9'] }] }), /AC-4 names unknown requirement "R-9"/],
    'a duplicate AC':                                 [traced({ acceptance_criteria: [...ACS, { id: 'AC-5', criterion: 'speechCount counts every detected speech event.', requirement_ids: ['R-2'] }] }), /AC-5 duplicates AC-2/],
    'an implied requirement without a reason':        [traced({ requirements: [...REQS, { id: 'R-5', implied: true, text: 'existing tests keep passing' }] }), /R-5 is implied but has no text or reason/],
  };
  for (const [name, [c, re]] of Object.entries(BAD)) {
    test(`${name} → not executable`, () => {
      assert.equal(contractState(c).state, 'invalid');
      assert.match(contractState(c).errors.join(' | '), re);
    });
  }
  test('a location clause may be marked context with a reason; an implied requirement with a reason is allowed (and shown)', () => {
    const c = traced({ requirements: [...REQS.slice(0, 3), { id: 'R-4', quote: 'tracked since the AdaptiveVAD was created', disposition: 'context', reason: 'covered by AC-4 wording' },
      { id: 'R-5', implied: true, text: 'existing VAD tests keep passing', reason: 'the request must not break detection' }],
      acceptance_criteria: [...ACS.slice(0, 3), { id: 'AC-4', criterion: 'existing detection tests keep passing', requirement_ids: ['R-5'] }] });
    const r = validateTraceability(c);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.trace.map((t) => t.disposition), ['covered', 'covered', 'covered', 'context', 'covered']);
    const view = formatOracle(c);
    assert.match(view, /Requirements from your request/);
    assert.match(view, /R-4 "tracked since the AdaptiveVAD was created" → CONTEXT  \(reason: covered by AC-4 wording\)/);
    assert.match(view, /R-5 \(implied\) "existing VAD tests keep passing" → AC-4/);
  });
});

describe('QB-14 re-review: coverage is by source span — negation, repeats, numbers and operators count', () => {
  const { execute } = require('../../agent/runner');
  const C = (raw_request, requirements, acs) => ({ id: 'c', raw_request, goal: 'g', clarifying_question: null, requirements,
    acceptance_criteria: acs.map(([id, criterion, rids]) => ({ id, criterion, kind: 'behavioral', requirement_ids: rids })) });
  const untraced = (c) => validateTraceability(c).errors.filter((e) => /not traced/.test(e)).map((e) => JSON.parse(e.slice(e.indexOf('"'))));

  // The senior's reproduction: the prohibitive clause has no traced occurrence.
  const CACHING = C('Enable caching for admins. Do not enable caching for guests.',
    [{ id: 'R-1', quote: 'Enable caching for admins.' }, { id: 'R-2', quote: 'guests', disposition: 'context', reason: 'user category' }],
    [['AC-1', 'Enable caching for admins', ['R-1']]]);

  test('senior repro: "Do not enable caching for" is untraced → invalid (pre-fix: finalized)', () => {
    assert.deepEqual(untraced(CACHING), ['do not enable caching for', '.']);   // re-review 3: the final "." outside "guests" counts too
    assert.equal(contractState(CACHING).state, 'invalid');
  });
  test('senior repro through the execution entry point: an approved contract is blocked, the agent never runs', async () => {
    const out = await execute('briefing', approve(CACHING, { via: 'test' }), null, { agent: 'claude-code', repoPath: '/nonexistent-qb14' });
    assert.equal(out.status, 'blocked');
    assert.match(out.error, /do not enable caching for/);
  });
  test('the fixed contract: the prohibition is its own requirement, covered by its own criterion', () => {
    const ok = C('Enable caching for admins. Do not enable caching for guests.',
      [{ id: 'R-1', quote: 'Enable caching for admins.' }, { id: 'R-2', quote: 'Do not enable caching for guests.' }],
      [['AC-1', 'admins get cached responses', ['R-1']], ['AC-2', 'guests never get cached responses', ['R-2']]]);
    assert.deepEqual(validateTraceability(ok).errors, []);
    assert.equal(contractState(ok).state, 'finalized');
  });
  test('negation is never a stop word', () => {
    for (const [req, quote, missing] of [['Do not log passwords', 'log passwords', 'do not'], ['Never retry uploads', 'retry uploads', 'never'],
      ['Export without headers', 'Export', 'without headers'], ['Return no results for guests', 'Return', 'no results for guests']]) {
      assert.deepEqual(untraced(C(req, [{ id: 'R-1', quote }], [['AC-1', 'x', ['R-1']]])), [missing], req);
    }
  });
  test('numeric thresholds, units, short tokens and operators are never dropped', () => {
    for (const [req, quote, missing] of [['Reject uploads larger than 10 MB', 'Reject uploads larger than', '10 mb'],
      ['Set ttl to 5', 'Set ttl', 'to 5'], ['Alert when cpu >= 90%', 'Alert when cpu', '>= 90%'], ['Retry at most 3 times', 'Retry', 'at most 3 times']]) {
      assert.deepEqual(untraced(C(req, [{ id: 'R-1', quote }], [['AC-1', 'x', ['R-1']]])), [missing], req);
    }
  });
  test('a repeated clause: one quote covers one occurrence only; repeats must say which occurrence', () => {
    const req = 'Cache results and cache results for 5 minutes';
    // ambiguous quote → error; quoting occurrence 1 leaves the second clause untraced
    assert.match(validateTraceability(C(req, [{ id: 'R-1', quote: 'Cache results' }], [['AC-1', 'x', ['R-1']]])).errors.join(' | '), /occurs 2 times in the request; say which/);
    assert.deepEqual(untraced(C(req, [{ id: 'R-1', quote: 'Cache results', occurrence: 1 }], [['AC-1', 'x', ['R-1']]])), ['cache results for 5 minutes']);
    const both = C(req, [{ id: 'R-1', quote: 'Cache results', occurrence: 1 }, { id: 'R-2', quote: 'Cache results for 5 minutes' }], [['AC-1', 'x', ['R-1']], ['AC-2', 'y', ['R-2']]]);
    assert.deepEqual(validateTraceability(both).errors, []);
    assert.match(validateTraceability(C(req, [{ id: 'R-1', quote: 'Cache results', occurrence: 3 }], [['AC-1', 'x', ['R-1']]])).errors.join(' | '), /occurrence 3 is not one of the 2/);
  });
  test('senior repro 2: an omitted symbolic negation "!" is untraced → invalid, and the approved contract is blocked before the agent runs', async () => {
    const c = { id: 'c', goal: 'Implement isGuest', raw_request: 'Return !isAdmin.', clarifying_question: null,
      requirements: [{ id: 'R-1', quote: 'Return' }, { id: 'R-2', quote: 'isAdmin.' }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'Return isAdmin', kind: 'behavioral', requirement_ids: ['R-1', 'R-2'] }] };
    assert.deepEqual(untraced(c), ['!']);
    assert.equal(contractState(c).state, 'invalid');
    const out = await execute('briefing', approve(c, { via: 'test' }), null, { agent: 'claude-code', repoPath: '/nonexistent-qb14' });
    assert.equal(out.status, 'blocked');
    assert.match(out.error, /not traced to any requirement: "!"/);
  });
  test('positive guard: the complete "!isAdmin" span traces cleanly', () => {
    const c = { id: 'c', goal: 'Implement isGuest', raw_request: 'Return !isAdmin.', clarifying_question: null,
      requirements: [{ id: 'R-1', quote: 'Return !isAdmin.' }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'Return the negation of isAdmin', kind: 'behavioral', requirement_ids: ['R-1'] }] };
    assert.deepEqual(validateTraceability(c).errors, []);
    assert.equal(contractState(c).state, 'finalized');
  });
  test('symbolic operators and code punctuation are never exempt (fail closed)', () => {
    for (const [req, quotes, missing] of [
      ['Return a != b.', ['Return a', 'b.'], ['!=']],
      ['Return a !== b.', ['Return a', 'b.'], ['!==']],
      ['Return !!value.', ['Return', 'value.'], ['!!']],
      ['Return -x.', ['Return', 'x.'], ['-']],
      ['Return a && b.', ['Return a', 'b.'], ['&&']],
      ['Return a || b.', ['Return a', 'b.'], ['||']],
      ['Return a ?? b.', ['Return a', 'b.'], ['??']],
      ['Return a?.b.', ['Return a', 'b.'], ['?.']],
      ['Return {} for guests.', ['Return', 'for guests.'], ['{}']],
      ['Use items[0].', ['Use items', '0].'], ['[']],
      ['Call reset() first.', ['Call reset', 'first.'], ['()']],
      ['Match /^ab+/.', ['Match', 'ab'], ['/^', '+/.']],
    ]) {
      const reqs = quotes.map((quote, i) => ({ id: `R-${i + 1}`, quote }));
      assert.deepEqual(untraced(C(req, reqs, [['AC-1', 'x', reqs.map((r) => r.id)]])), missing, req);
    }
  });
  test('senior repro 3: "value?? fallback." — an operator glued to a word is never trimmed; blocked before the agent runs', async () => {
    const c = { id: 'c', goal: 'Return fallback when nullish', raw_request: 'Return value?? fallback.', clarifying_question: null,
      requirements: [{ id: 'R-1', quote: 'Return value' }, { id: 'R-2', quote: 'fallback.' }],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'Return value', kind: 'behavioral', requirement_ids: ['R-1', 'R-2'] }] };
    assert.deepEqual(untraced(c), ['??']);
    assert.equal(contractState(c).state, 'invalid');
    const out = await execute('briefing', approve(c, { via: 'test' }), null, { agent: 'claude-code', repoPath: '/nonexistent-qb14' });
    assert.equal(out.status, 'blocked');
    assert.match(out.error, /not traced to any requirement: "\?\?"/);
  });
  test('whitespace matrix: every operator, spaces before / after / neither / both — omitted blocks, quoted-complete is valid', () => {
    for (const op of ['??', '?.', '!', '!=', '!==', '&&', '||']) {
      for (const [sb, sa] of [[true, false], [false, true], [false, false], [true, true]]) {
        const req = `Return a${sb ? ' ' : ''}${op}${sa ? ' ' : ''}b.`;
        const omitted = C(req, [{ id: 'R-1', quote: 'Return a' }, { id: 'R-2', quote: 'b.' }], [['AC-1', 'x', ['R-1', 'R-2']]]);
        assert.deepEqual(untraced(omitted), [op], JSON.stringify(req));
        assert.equal(contractState(omitted).state, 'invalid', JSON.stringify(req));
        const complete = C(req, [{ id: 'R-1', quote: req }], [['AC-1', 'x', ['R-1']]]);
        assert.deepEqual(validateTraceability(complete).errors, [], JSON.stringify(req));
      }
    }
  });
  test('no punctuation exemption at all: sentence punctuation outside quotes is reported too (quote whole clauses)', () => {
    const c = C('Do it, then stop.', [{ id: 'R-1', quote: 'Do it' }, { id: 'R-2', quote: 'then stop' }], [['AC-1', 'x', ['R-1', 'R-2']]]);
    assert.deepEqual(untraced(c), [',', '.']);
    const whole = C('Do it, then stop.', [{ id: 'R-1', quote: 'Do it, then stop.' }], [['AC-1', 'x', ['R-1']]]);
    assert.deepEqual(validateTraceability(whole).errors, []);
  });
  test('context exclusions refer to the full excluded span and show their reason to the human', () => {
    const c = C('Add clamp() to src/math.js. Ignore the legacy folder.',
      [{ id: 'R-1', quote: 'Add clamp() to src/math.js.' }, { id: 'R-2', quote: 'Ignore the legacy folder.', disposition: 'context', reason: 'handled by scope.protected_paths' }],
      [['AC-1', 'clamp is exported', ['R-1']]]);
    assert.deepEqual(validateTraceability(c).errors, []);
    assert.deepEqual(validateTraceability(c).trace[1].span, [28, 53]);
    assert.match(formatOracle(c), /R-2 "Ignore the legacy folder\." → CONTEXT  \(reason: handled by scope\.protected_paths\)/);
  });
});

// ── behaviour over time: call_sequence on a VAD fixture, with QB's real runner ──
const VAD = (impl) => `class AdaptiveVAD {\n  constructor() { ${impl.ctor || ''} }\n  onSpeech(ms) { ${impl.onSpeech} }\n  getVADStats() { ${impl.stats} }\n}\n${impl.top || ''}module.exports = { AdaptiveVAD };\n`;
const IMPLS = {
  correct:      { ctor: 'this.n = 0; this.ms = 0;', onSpeech: 'this.n += 1; this.ms += ms;', stats: 'return { speechCount: this.n, totalSpeechMs: this.ms };' },
  constantZero: { onSpeech: '', stats: 'return { speechCount: 0, totalSpeechMs: 0 };' },
  sharedGlobal: { top: 'let N = 0, MS = 0;\n', onSpeech: 'N += 1; MS += ms;', stats: 'return { speechCount: N, totalSpeechMs: MS };' },
  lastOnly:     { ctor: 'this.n = 0; this.ms = 0;', onSpeech: 'this.n += 1; this.ms = ms;', stats: 'return { speechCount: this.n, totalSpeechMs: this.ms };' },
};
const seq = (id, ac, instances, steps) => ({ id, ac_id: ac, adapter: 'call_sequence', params: { module: 'src/vad.js', export: 'AdaptiveVAD', instances, steps } });
const NEW = { construct: 'new', args: [] };
const CHECKS = [
  seq('ACCUMULATES', 'AC-3', { a: NEW }, [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'a', method: 'onSpeech', args: [200] },
    { on: 'a', method: 'getVADStats', args: [], expect: { speechCount: 2, totalSpeechMs: 500 } }]),
  seq('RESETS', 'AC-4', { a: NEW, b: NEW }, [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'b', method: 'getVADStats', args: [], expect: { speechCount: 0, totalSpeechMs: 0 } }]),
  seq('INDEPENDENT', 'AC-4', { a: NEW, b: NEW }, [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'b', method: 'onSpeech', args: [100] },
    { on: 'a', method: 'getVADStats', args: [], expect: { speechCount: 1, totalSpeechMs: 300 } }, { on: 'b', method: 'getVADStats', args: [], expect: { speechCount: 1, totalSpeechMs: 100 } }]),
];

function runReal(impl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb14-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'vad.js'), VAD(impl));
    const out = path.join(dir, 'out.json');
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs')],
      { input: JSON.stringify({ root: dir, checks: CHECKS }), encoding: 'utf8', env: { ...process.env, QB_CHECK_RESULTS: out } });
    assert.equal(r.status, 0, r.stderr);
    return fs.readFileSync(out, 'utf8');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('call_sequence: behaviour over time (qb-checks/2)', () => {
  test('the registry accepts the sequences and rejects malformed ones', () => {
    assert.equal(validateChecks(CHECKS, ACS).accepted.length, 3);
    const bad = [seq('X', 'AC-3', { a: NEW }, [{ on: 'z', method: 'onSpeech', args: [] }]),
      seq('Y', 'AC-3', { a: NEW }, [{ on: 'a', method: 'onSpeech', args: [1] }]),
      seq('Z', 'AC-3', { a: NEW }, [{ on: 'a', method: 'process.exit', args: [], expect: 1 }])];
    assert.equal(validateChecks(bad, ACS).rejected.length, 3);
  });
  const EXPECT = {
    correct:      ['pass', 'pass', 'pass'],
    constantZero: ['fail', 'pass', 'fail'],     // a constant-zero VAD fails after simulated events
    sharedGlobal: ['pass', 'fail', 'fail'],     // does not reset per instance; instances not independent
    lastOnly:     ['fail', 'pass', 'pass'],     // does not accumulate duration over multiple events
  };
  for (const [name, statuses] of Object.entries(EXPECT)) {
    test(`${name} VAD → ${statuses.join('/')}`, () => {
      const v = validateCheckResults(runReal(IMPLS[name]), CHECKS, checkSetHash(CHECKS));
      assert.equal(v.ok, true);
      assert.deepEqual(v.results.map((x) => x.status), statuses);
    });
  }
  test('through verify(): constant-zero FAILS, the correct VAD passes', async () => {
    const contract = approve({ ...traced(), scope: { allowed_changes: ['src/**'] }, checks: CHECKS,
      acceptance_criteria: ACS.map((a) => ({ ...a, kind: ['AC-3', 'AC-4'].includes(a.id) ? 'behavioral' : 'non_behavioral' })) }, { via: 'test' });
    const report = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
    const T = 'c'.repeat(40);
    const ex = (impl) => ({ id: 'e', status: 'completed', diff: 'diff --git a/src/vad.js b/src/vad.js\n+x', changes: [{ file: 'src/vad.js', status: 'M' }], candidate_tree: T,
      sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report, tree: T },
        checks: { tree: T, requested: CHECKS, check_set_hash: checkSetHash(CHECKS), results_text: runReal(IMPLS[impl]) } } });
    const m = mockFetch(ollamaReply({ met: true, evidence: 'looks complete' }));
    try {
      assert.equal((await verify(contract, null, ex('constantZero'), {})).verdict, 'fail');
      assert.equal((await verify(contract, null, ex('correct'), {})).verdict, 'pass');
    } finally { m.restore(); }
  });
});
