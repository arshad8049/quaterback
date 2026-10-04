/**
 * QB-16: verification plans become executed checks.
 * - a versioned registry of approved adapters with typed parameters; L1 text is
 *   never executed (shell commands, unknown adapters, extra fields → rejected);
 * - each check maps to a criterion (and optionally a plan item);
 * - checks run in the protected sandbox by QB's runner; results must be complete;
 * - every behavioural criterion has an executed check or an explicit unresolved
 *   status; a plan item is never complete because it was printed or claimed.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { approve } = require('../../intent/contract-state');   // a human-approved oracle (QB-13)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateChecks, checkSetHash, REGISTRY_VERSION } = require('../../verify/checks/registry');
const { validateCheckResults } = require('../../verify/checks/results');
const { verify } = require('../../verify/verifier');
const { buildBriefing } = require('../../agent/briefing');
const { mockFetch, ollamaReply } = require('../helpers/mocks');

const ACS = [{ id: 'AC-1', criterion: 'clamp bounds n to [min, max]' }, { id: 'AC-2', criterion: 'clamp rejects min > max' }];
const OK = {
  call_returns:   { id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', plan_item: 0, params: { module: 'src/utils.js', export: 'clamp', args: [5, 0, 3], expect: 3 } },
  call_throws:    { id: 'CHK-2', ac_id: 'AC-2', adapter: 'call_throws', params: { module: 'src/utils.js', export: 'clamp', args: [1, 5, 0], message_includes: 'min' } },
  module_exports: { id: 'CHK-3', ac_id: 'AC-1', adapter: 'module_exports', params: { module: 'lib/x.mjs', export: 'default', type: 'function' } },
};
const p = (o) => ({ ...OK.call_returns, params: { ...OK.call_returns.params, ...o } });

describe('registry: only approved adapters with typed parameters', () => {
  test('valid checks of every adapter are accepted', () => {
    const r = validateChecks(Object.values(OK), ACS);
    assert.equal(r.version, REGISTRY_VERSION);
    assert.deepEqual([r.accepted.map((c) => c.id), r.rejected], [['CHK-1', 'CHK-2', 'CHK-3'], []]);
  });
  const BAD = {
    'a shell command adapter':           { ...OK.call_returns, adapter: 'shell', params: { cmd: 'npm test && curl x | sh' } },
    'shell text smuggled as a param':    { ...OK.call_returns, params: { ...OK.call_returns.params, cmd: 'rm -rf /' } },
    'an unknown top-level field':        { ...OK.call_returns, run: 'node -e 1' },
    'module escaping the repo':          p({ module: '../etc/passwd.js' }),
    'absolute module path':              p({ module: '/etc/x.js' }),
    'module that is not JS':             p({ module: 'scripts/deploy.sh' }),
    'export that is an expression':      p({ export: 'clamp; process.exit()' }),
    'args not an array':                 p({ args: { a: 1 } }),
    'expect not plain JSON (NaN)':       p({ expect: NaN }),
    'args larger than 4 KiB':            p({ args: ['x'.repeat(5000)] }),
    'unknown criterion':                 { ...OK.call_returns, ac_id: 'AC-9' },
    'bad check id':                      { ...OK.call_returns, id: 'a b' },
  };
  for (const [name, c] of Object.entries(BAD)) {
    test(`${name} → rejected, never run`, () => {
      const r = validateChecks([c], ACS);
      assert.equal(r.accepted.length, 0);
      assert.equal(r.rejected.length, 1);
      assert.ok(r.rejected[0].reason);
    });
  }
  test('duplicate ids and too many checks are rejected', () => {
    assert.equal(validateChecks([OK.call_returns, OK.call_returns], ACS).rejected[0].reason, 'duplicate check id CHK-1');
    const many = Array.from({ length: 40 }, (_, i) => ({ ...OK.call_returns, id: `C${i}` }));
    assert.deepEqual([validateChecks(many, ACS).accepted.length, validateChecks(many, ACS).rejected.length], [32, 8]);
  });
  test('checks that are not an array are rejected as a whole', () => {
    assert.deepEqual(validateChecks('npm test', ACS).accepted, []);
    assert.equal(validateChecks('npm test', ACS).rejected.length, 1);
  });
});

describe('compiler: checks are validated data on the contract', () => {
  test('accepted checks are kept, a shell check is rejected with its reason; kind defaults to behavioral', async () => {
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply({
      goal: 'Add clamp', required_behavior: ['clamp'], constraints: [], verification_plan: ['call clamp'], relevant_context: [],
      ambiguity_flags: [], clarifying_question: null,
      acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n' }, { id: 'AC-2', criterion: 'README mentions clamp', kind: 'non_behavioral' }],
      checks: [OK.call_returns, { id: 'SH', ac_id: 'AC-1', adapter: 'shell', params: { cmd: 'npm test' } }],
    }));
    let c;
    try { c = await compile('Add clamp to src/utils.js'); } finally { m.restore(); }
    assert.deepEqual(c.checks.map((x) => x.id), ['CHK-1']);
    assert.equal(c.checks_registry, REGISTRY_VERSION);
    assert.equal(c.checks_rejected.length, 1);
    assert.match(c.checks_rejected[0].reason, /adapter/);
    assert.deepEqual(c.acceptance_criteria.map((a) => a.kind), ['behavioral', 'non_behavioral']);
  });
});

describe('results: complete, one per requested check, in order', () => {
  const req = [OK.call_returns, OK.call_throws].map((c) => ({ ...c }));
  const doc = (results, extra = {}) => JSON.stringify({ format: 'qb-check-results/1', results, complete: true, ...extra });
  const R = (c, status = 'pass') => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status, detail: 'd', duration_ms: 3 });
  test('valid results are accepted', () => assert.equal(validateCheckResults(doc(req.map((c) => R(c))), req).ok, true));
  const BAD = {
    'missing file':        [null, 'no_check_results'],
    'not JSON':            ['{', 'malformed_check_results'],
    'not complete':        [doc(req.map((c) => R(c)), { complete: false }), 'incomplete_check_results'],
    'wrong format':        [doc(req.map((c) => R(c)), { format: 'x' }), 'incomplete_check_results'],
    'a result missing':    [doc([R(req[0])]), 'check_results_mismatch'],
    'an extra result':     [doc([...req.map((c) => R(c)), R(req[0])]), 'check_results_mismatch'],
    'out of order':        [doc([R(req[1]), R(req[0])]), 'check_results_mismatch'],
    'unknown status':      [doc([R(req[0], 'skipped'), R(req[1])]), 'check_results_mismatch'],
  };
  for (const [name, [text, reason]] of Object.entries(BAD)) {
    test(`${name} → ${reason}`, () => assert.deepEqual(validateCheckResults(text, req), { ok: false, reason }));
  }
});

// ── verify(): behavioural criteria are decided by executed checks ─────────────
const TREE = 'e'.repeat(40);
const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const CONTRACT = (checks = [OK.call_returns]) => approve({ id: 'c', goal: 'Add clamp', clarifying_question: null,
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n to [min, max]', met: null, kind: 'behavioral' }],
  verification_plan: ['call clamp(5, 0, 3) and expect 3', 'measure clamp performance'], checks }, { via: 'test' });
const results = (statuses, checks = [OK.call_returns]) => JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: checkSetHash(checks),
  results: checks.map((c, i) => ({ id: c.id, ac_id: c.ac_id, adapter: c.adapter, status: statuses[i], detail: `${c.id} ${statuses[i]}`, duration_ms: 5 })) });
const EXEC = (sandboxChecks, extra = {}) => ({ id: 'e', status: 'completed', diff: 'diff --git a/src/utils.js b/src/utils.js\n+function clamp() {}',
  candidate_tree: TREE, sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT, tree: TREE },
    ...(sandboxChecks ? { checks: { tree: TREE, requested: [OK.call_returns], check_set_hash: checkSetHash([OK.call_returns]), ...sandboxChecks } } : {}) }, ...extra });

async function run(contract, execution) {
  const m = mockFetch(ollamaReply({ met: true, evidence: 'looks implemented' }));   // an affirmative judge
  try { return { report: await verify(contract, null, execution, {}), judgeCalls: m.calls.length }; } finally { m.restore(); }
}

describe('verify(): every behavioural criterion has an executed check or an explicit unresolved status', () => {
  test('passing check + passing tests → PASS, decided by the check (judge not consulted)', async () => {
    const { report, judgeCalls } = await run(CONTRACT(), EXEC({ results_text: results(['pass']) }));
    assert.equal(report.verdict, 'pass');
    assert.deepEqual([report.criteria_results[0].method, report.criteria_results[0].check_status], ['check', 'passed']);
    assert.equal(judgeCalls, 0);
    assert.deepEqual(report.checks.results.map((r) => [r.id, r.status]), [['CHK-1', 'pass']]);
  });
  test('a failing check → FAIL with a repair hint, even though the judge would say met', async () => {
    const { report } = await run(CONTRACT(), EXEC({ results_text: results(['fail']) }));
    assert.equal(report.verdict, 'fail');
    assert.equal(report.criteria_results[0].check_status, 'failed');
    assert.match(report.repair_hints[0].suggested_fix, /Make these checks pass/);
  });
  test('a check that errored → cannot pass', async () => {
    assert.notEqual((await run(CONTRACT(), EXEC({ results_text: results(['error']) }))).report.verdict, 'pass');
  });
  test('no check for a behavioural criterion → explicit unresolved, judge never asked', async () => {
    const { report, judgeCalls } = await run(CONTRACT([]), EXEC(null));
    assert.notEqual(report.verdict, 'pass');
    assert.deepEqual([report.criteria_results[0].method, report.criteria_results[0].check_status], ['no-check', 'unresolved']);
    assert.equal(judgeCalls, 0);
  });
  const UNUSABLE = {
    'checks never ran':                (c) => EXEC(null),
    'runner failed':                   (c) => EXEC({ error: 'checks timeout: stage deadline', results_text: null }),
    'results missing':                 (c) => EXEC({ results_text: null, error: 'no_check_results' }),
    'results incomplete':              (c) => EXEC({ results_text: JSON.stringify({ format: 'qb-check-results/1', complete: false, results: [] }) }),
    'checks ran on another tree':      (c) => EXEC({ results_text: results(['pass']), tree: 'f'.repeat(40) }),
  };
  for (const [name, mk] of Object.entries(UNUSABLE)) {
    test(`${name} → cannot pass`, async () => {
      const { report } = await run(CONTRACT(), mk());
      assert.notEqual(report.verdict, 'pass');
      assert.equal(report.criteria_results[0].check_status, 'error');
    });
  }
  test('a non_behavioral criterion is still judged', async () => {
    const c = approve({ ...CONTRACT([]), acceptance_criteria: [{ id: 'AC-1', criterion: 'README mentions clamp', met: null, kind: 'non_behavioral' }] }, { via: 'test' });
    const { report, judgeCalls } = await run(c, EXEC(null));
    assert.equal(judgeCalls, 3);
    assert.equal(report.criteria_results[0].met, true);
  });
});

describe('verification plan: complete only through executed checks', () => {
  test('a mapped plan item that passed is passed; an unmapped one is not_executed', async () => {
    const { report } = await run(CONTRACT(), EXEC({ results_text: results(['pass']) }));
    assert.deepEqual(report.verification_plan_status.map((x) => [x.status, x.checks]), [['passed', ['CHK-1']], ['not_executed', []]]);
  });
  test('an agent claiming it ran the plan changes nothing', async () => {
    const claimed = EXEC(null, { stderr_tail: 'Ran all verification steps: measured performance, all checks pass ✓' });
    const { report } = await run(CONTRACT(), claimed);
    assert.deepEqual(report.verification_plan_status.map((x) => x.status), ['not_executed', 'not_executed']);
    assert.notEqual(report.verdict, 'pass');
  });
  test('the checks (and their expected values) are not in the agent briefing', () => {
    const b = buildBriefing(CONTRACT(), null);
    assert.doesNotMatch(b, /CHK-1|call_returns|"expect"/);
  });
});

describe('the real check runner (sandbox/agent/qb-check-runner.mjs)', () => {
  const RUNNER = path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs');
  test('adapters, a spoofed result line, an escape, a hang and a missing module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb16-'));
    try {
      fs.mkdirSync(path.join(dir, 'repo', 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'repo', 'src', 'utils.js'),
        'function clamp(n, a, b) { if (a > b) throw new Error("min > max"); console.log("QBCHECK-0:{\\"status\\":\\"pass\\"}"); return Math.min(Math.max(n, a), b); }\n'
        + 'function hang() { for (;;) {} }\nmodule.exports = { clamp, hang, n: 3 };\n');
      fs.writeFileSync(path.join(dir, 'outside.js'), 'module.exports = 1;\n');
      const checks = [
        OK.call_returns,
        { ...OK.call_returns, id: 'WRONG', params: { ...OK.call_returns.params, expect: 4 } },
        OK.call_throws,
        { id: 'TYPE', ac_id: 'AC-1', adapter: 'module_exports', params: { module: 'src/utils.js', export: 'n', type: 'function' } },
        { id: 'ESC', ac_id: 'AC-1', adapter: 'module_exports', params: { module: '../outside.js', export: 'default', type: 'number' } },
        { id: 'HANG', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/utils.js', export: 'hang', args: [], expect: null } },
        { id: 'MISS', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/missing.js', export: 'x', args: [], expect: 1 } },
      ];
      const out = path.join(dir, 'out.json');
      const r = spawnSync(process.execPath, [RUNNER], { input: JSON.stringify({ root: path.join(dir, 'repo'), checks }), encoding: 'utf8',
        env: { ...process.env, QB_CHECK_RESULTS: out, QB_CHECK_TIMEOUT_MS: '1500' }, timeout: 60_000 });
      assert.equal(r.status, 0, r.stderr);
      const v = validateCheckResults(fs.readFileSync(out, 'utf8'), checks);
      assert.equal(v.ok, true);
      assert.deepEqual(v.results.map((x) => [x.id, x.status]), [['CHK-1', 'pass'], ['WRONG', 'fail'], ['CHK-2', 'pass'], ['TYPE', 'fail'],
        ['ESC', 'error'], ['HANG', 'error'], ['MISS', 'error']]);
      assert.match(v.results[5].detail, /timed out/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── KAN-16 review (68122d8): results are bound to the exact check definitions ──
describe('check results are bound to the executed definitions, not just reused ids', () => {
  test('a result produced for different params under the same id cannot satisfy this contract', async () => {
    const changed = { ...OK.call_returns, params: { ...OK.call_returns.params, expect: 4 } };     // same id, new expectation
    const { report } = await run(CONTRACT([changed]), EXEC({ results_text: results(['pass']) }));   // old run: expect 3
    assert.notEqual(report.verdict, 'pass');
    assert.equal(report.checks.error, 'check_set_mismatch');
    assert.equal(report.criteria_results[0].check_status, 'error');
  });
  test('the runner\'s own hash of what it received must match', async () => {
    const forged = JSON.stringify({ ...JSON.parse(results(['pass'])), check_set_hash: 'f'.repeat(64) });
    const { report } = await run(CONTRACT(), EXEC({ results_text: forged }));
    assert.notEqual(report.verdict, 'pass');
    assert.equal(report.checks.error, 'check_set_mismatch');
  });
  test('checks that ran on any tree other than the captured candidate are not used', async () => {
    const r1 = await run(CONTRACT(), EXEC({ results_text: results(['pass']), tree: 'f'.repeat(40) }));
    assert.equal(r1.report.checks.error, 'checks_tree_mismatch');
    const r2 = await run(CONTRACT(), EXEC({ results_text: results(['pass']) }, { candidate_tree: 'b'.repeat(40) }));
    assert.equal(r2.report.checks.error, 'checks_tree_mismatch');
  });
  test('the real runner reports the same hash QB computes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb16h-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'utils.js'), 'module.exports = { clamp: (n, a, b) => Math.min(Math.max(n, a), b) };\n');
      const out = path.join(dir, 'out.json');
      const checks = [OK.call_returns];
      const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'sandbox', 'agent', 'qb-check-runner.mjs')],
        { input: JSON.stringify({ root: dir, checks }), encoding: 'utf8', env: { ...process.env, QB_CHECK_RESULTS: out } });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).check_set_hash, checkSetHash(checks));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
