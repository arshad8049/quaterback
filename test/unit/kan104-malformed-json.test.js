/**
 * KAN-104 (beta, run d9bcf7fe-caad-467a-bd20-0676dd0ea7df): the local model's draft for the greeting
 * request was not JSON at all — `"args": [greeting, "test"]` — so parseJSON threw and the run ended
 * ERROR before the validator or Claude. parseJSON is NOT taught to guess what a bare value means.
 *
 * Instead the KAN-103 recovery path covers it: for a QB-generated draft, ONE corrective model call in
 * total (never one for parsing and another for validation), inside the run deadline. After a parse
 * failure the compiler gets the request and the syntax diagnostic (not the unreadable draft) and
 * writes a fresh draft, which is validated from scratch. A valid result goes to the usual human
 * review. --max-retries and user-supplied contracts are untouched.
 *
 * `malformed-draft.txt` is the model's captured reply from that run, unedited. The other fixtures are
 * fixed corrective replies (test/fixtures/kan104). "Parseable" is never treated as "correct": the two
 * wrong-but-parseable drafts are tested one at a time, showing where each is stopped today.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const { compileIntent } = require('../../intent/session');
const { contractFromObject } = require('../../intent/compiler');
const { contractState } = require('../../intent/contract-state');
const { formatOracle } = require('../../intent/oracle-view');
const { evaluatePolicy, matchesAny } = require('../../verify/policy');
const { validateCheckResults } = require('../../verify/checks/results');

const FIX = path.join(__dirname, '..', 'fixtures', 'kan104');
const read = (n) => fs.readFileSync(path.join(FIX, n), 'utf8');
const REQUEST = read('request.txt').trim();
const MALFORMED = read('malformed-draft.txt');
const STILL_MALFORMED = read('still-malformed-draft.txt');
const FAITHFUL = read('faithful-draft.json');
const CONTRADICTORY = read('contradictory-check-draft.json');
const PROTECTED_ALL = read('protected-everything-draft.json');
const KAN103_BAD = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kan103', 'bad-draft.json'), 'utf8');

const ROOT = path.join(__dirname, '..', '..');
const QB = path.join(ROOT, 'qb.js');
const RUNNER = path.join(ROOT, 'sandbox', 'agent', 'qb-check-runner.mjs');
const PRELOAD_OLLAMA = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const PRELOAD_SPY = path.join(__dirname, '..', 'helpers', 'preload-sandbox-spy.js');
// The tester's starter-node-js at e6fe8ee: an ESM greeting() and one node:test file.
const STARTER = {
  'package.json': JSON.stringify({ name: 'starter-node-js', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  'src/greeting.js': 'export function greeting() {\n  return "Hello from Node Project JS!";\n}\n',
  'test/greeting.test.js': 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { greeting } from "../src/greeting.js";\n\ntest("returns the greeting", () => {\n  assert.equal(greeting(), "Hello from Node Project JS!");\n});\n',
};
// What the request asks for, implemented correctly.
const FAITHFUL_IMPL = 'export function greeting(name) {\n  return name === undefined ? "Hello from Node Project JS!" : `Hello, ${name}!`;\n}\n';

/** compileIntent with the model replying `replies` in order; returns the result, call count and prompts. */
async function compileWith(replies) {
  let i = 0;
  const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try {
    const s = await compileIntent(REQUEST);
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages) };
  } finally { m.restore(); }
}

/** Run checks against an implementation of src/greeting.js with the real check runner. */
function runChecks(impl, checks) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kan104-checks-'));
  try {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), STARTER['package.json']);
    fs.writeFileSync(path.join(dir, 'src', 'greeting.js'), impl);
    const out = path.join(dir, 'out.json');
    const r = proc.run(process.execPath, [RUNNER], { input: JSON.stringify({ root: dir, checks }), encoding: 'utf8', env: { ...process.env, QB_CHECK_RESULTS: out }, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    const v = validateCheckResults(fs.readFileSync(out, 'utf8'), checks);
    assert.equal(v.ok, true, JSON.stringify(v));
    return Object.fromEntries(v.results.map((x) => [x.id, x.status]));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('KAN-104: malformed model JSON gets the one shared correction', () => {
  test('the captured reply really is malformed, and parseJSON still does not guess bare values', async () => {
    assert.throws(() => JSON.parse(MALFORMED), /Unexpected token 'g'/);
    assert.match(MALFORMED, /"args": \[greeting, "test"\]/);
    // compile() on its own still refuses it (no quoting of `greeting`), with a typed syntax error.
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply(MALFORMED));
    try {
      await assert.rejects(compile(REQUEST), (e) => e.code === 'DRAFT_SYNTAX' && /not valid JSON|Unexpected token/.test(e.diagnostic));
    } finally { m.restore(); }
  });

  test('malformed → faithful: one corrective call from the request and the syntax diagnostic; both outputs, the node:test cases, and edits to src and tests allowed (pre-fix: throws)', async () => {
    const { s, calls, prompts } = await compileWith([MALFORMED, FAITHFUL]);
    assert.equal(calls, 2, 'exactly one corrective call');
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    const c = s.contract;
    const calls_ = c.checks.filter((k) => k.adapter === 'call_returns').map((k) => [JSON.stringify(k.params.args), k.params.expect]);
    assert.deepEqual(calls_, [['["Arshad"]', 'Hello, Arshad!'], ['[]', 'Hello from Node Project JS!']]);
    assert.match(c.requirements.map((r) => r.quote).join(' | '), /Add node:test cases for both\./);
    assert.ok(c.acceptance_criteria.some((a) => /node:test/.test(a.criterion) && a.requirement_ids.includes('R-3')));
    for (const f of ['src/greeting.js', 'test/greeting.test.js']) {
      assert.ok(matchesAny(f, c.scope.allowed_changes), `${f} allowed`);
      assert.ok(!matchesAny(f, c.scope.protected_paths), `${f} not protected`);
    }
    assert.equal(c.approval, undefined, 'never approved automatically');
    // The corrective prompt: the request and the syntax diagnostic, asking for a fresh draft.
    const sent = prompts[1].map((m) => m.content).join('\n');
    assert.ok(sent.includes(REQUEST));
    assert.match(sent, /NOT VALID JSON/);
    assert.match(sent, /Unexpected token 'g'/, 'the syntax diagnostic');
    assert.doesNotMatch(sent, /"module\/src\/greeting\.js"/, 'the unreadable draft itself is not sent back');
    assert.equal(s.repair.rejected.length, 1);
    assert.equal(s.repair.rejected[0].kind, 'syntax');
    assert.match(s.repair.rejected[0].diagnostic, /Unexpected token 'g'/);
  });

  describe('malformed → parseable but wrong: each defect alone, and where it is stopped today', () => {
    test('contradictory check greeting("test") → "Hello, Arshad!": NOT stopped at L1 (validator gap); visible in the approval view; fails a correct implementation at L4', async () => {
      const { s, calls } = await compileWith([MALFORMED, CONTRADICTORY]);
      assert.equal(calls, 2);
      // GAP: the existing L1 validator accepts it. Nothing compares a check's call with the request.
      assert.equal(s.state, 'finalized');
      // Stopped (1): it is shown to the human before approval, verbatim.
      assert.match(formatOracle(s.contract), /call_returns \{"module":"src\/greeting\.js","export":"greeting","args":\["test"\],"expect":"Hello, Arshad!"\}/);
      // Stopped (2), only after the agent ran: the faithful implementation fails it.
      assert.deepEqual(runChecks(FAITHFUL_IMPL, s.contract.checks), { 'CHK-1': 'fail', 'CHK-2': 'pass' });
    });
    test('KNOWN GAP: L1 should reject a call_returns check that contradicts the request\'s own example', { todo: 'KAN-104 gap: no L1 validator cross-checks check calls against the request' }, async () => {
      const { s } = await compileWith([MALFORMED, CONTRADICTORY]);
      assert.equal(s.state, 'invalid');
    });

    test('protected_paths ["**"]: NOT stopped at L1 (validator gap); fails the policy at L4 on the requested edits', async () => {
      const { s, calls } = await compileWith([MALFORMED, PROTECTED_ALL]);
      assert.equal(calls, 2);
      // GAP: the existing L1 validator accepts a scope where every allowed change is also protected.
      assert.equal(s.state, 'finalized');
      assert.match(formatOracle(s.contract), /\*\*/);
      // Stopped, only after the agent ran: the requested edits are protected changes, so the task fails.
      const p = evaluatePolicy(s.contract, { changes: [{ file: 'src/greeting.js' }, { file: 'test/greeting.test.js' }], diff: '' }, []);
      assert.equal(p.effect, 'fail');
      assert.deepEqual(p.protected_touched, ['src/greeting.js', 'test/greeting.test.js']);
    });
    test('KNOWN GAP: L1 should reject a scope whose allowed changes are all protected', { todo: 'KAN-104 gap: policyErrors does not check allowed_changes against protected_paths' }, async () => {
      const { s } = await compileWith([MALFORMED, PROTECTED_ALL]);
      assert.equal(s.state, 'invalid');
    });
  });

  test('malformed → malformed: two drafts total, then invalid; the diagnostics are recorded', async () => {
    const { s, calls } = await compileWith([MALFORMED, STILL_MALFORMED, FAITHFUL]);
    assert.equal(calls, 2, 'no third draft');
    assert.equal(s.state, 'invalid');
    assert.deepEqual(s.repair.rejected.map((r) => r.kind), ['syntax', 'syntax']);
    assert.match(s.repair.rejected[1].diagnostic, /Unexpected token 'A'/);
    assert.match(s.errors.join('\n'), /corrected draft was not valid JSON either/);
  });

  test('the two L1 fixes never stack: malformed → invalid contract stops after 2 calls (no validation repair after the syntax one)', async () => {
    const { s, calls } = await compileWith([MALFORMED, KAN103_BAD, FAITHFUL]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.deepEqual(s.repair.rejected.map((r) => r.kind), ['syntax', 'invalid']);
  });
  test('…and invalid contract → malformed stops after 2 calls too', async () => {
    const { s, calls } = await compileWith([KAN103_BAD, MALFORMED, FAITHFUL]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    assert.deepEqual(s.repair.rejected.map((r) => r.kind), ['invalid', 'syntax']);
  });

  test('valid first draft: exactly one model call', async () => {
    const { s, calls } = await compileWith([FAITHFUL, MALFORMED]);
    assert.equal(s.state, 'finalized');
    assert.equal(calls, 1);
    assert.equal(s.repair, undefined);
  });

  /** qb.js end to end with the exact repro flags; model replies scripted, sandbox spied. */
  function runCli({ replies, extra = [] }) {
    const repo = makeRepo(STARTER);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan104-'));
    try {
      const fetchLog = path.join(tmp, 'fetch.log'); const sandboxLog = path.join(tmp, 'sandbox.log'); const runs = path.join(tmp, 'runs');
      const args = typeof extra === 'function' ? extra(tmp) : extra;
      const r = proc.run(process.execPath, ['--require', PRELOAD_OLLAMA, '--require', PRELOAD_SPY, QB, REQUEST, '--repo', repo.dir,
        '--agent', 'claude-code', '--max-retries', '3', '--deadline', '15', '--no-llm-context', '--no-llm-verify', ...args], {
        env: { ...process.env, QB_TEST_FETCH_LOG: fetchLog, QB_TEST_SANDBOX_LOG: sandboxLog, QB_RUNS_DIR: runs,
          QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(replies) },
        encoding: 'utf8', timeout: 60_000,
      });
      const rd = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      const ids = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
      const dir = ids.length === 1 ? path.join(runs, ids[0]) : null;
      const manifest = dir ? JSON.parse(rd(path.join(dir, 'manifest.json'))) : null;
      const events = dir ? rd(path.join(dir, 'events.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const stored = Object.fromEntries(Object.entries(manifest?.artifacts || {}).filter(([, ref]) => ref.path.endsWith('.json'))
        .map(([name, ref]) => [name, JSON.parse(rd(path.join(dir, ref.path)))]));
      return { status: r.status, out: r.stdout + r.stderr, modelCalls: rd(fetchLog).split('\n').filter(Boolean).length,
        launches: rd(sandboxLog).split('\n').filter(Boolean).length, manifest, events, artifact: (n) => stored[n] ?? null };
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  test('qb.js malformed → faithful (exact repro flags): goes to human review, not execution (pre-fix: ERROR, raw reply printed)', () => {
    const r = runCli({ replies: [MALFORMED, FAITHFUL] });
    assert.equal(r.modelCalls, 2, r.out);
    assert.equal(r.launches, 0);
    assert.equal(r.manifest.outcome, 'BLOCKED', r.out);
    assert.match(r.manifest.outcome_reason, /needs_contract_approval/);
    assert.doesNotMatch(r.out, /FATAL|\[greeting, "test"\]/);
  });

  test('qb.js malformed → malformed: BLOCKED after two drafts; no approval, no Claude; customer message; size-limited redacted evidence only in the run record', () => {
    const SECRET = 'sk-ant-api03-' + 'x'.repeat(40);
    const big = MALFORMED.replace('"ambiguity_flags": []', `"ambiguity_flags": ["${SECRET}"], "padding": "${'p'.repeat(40_000)}"`);
    const r = runCli({ replies: [big, STILL_MALFORMED, FAITHFUL] });
    assert.equal(r.modelCalls, 2, r.out);
    assert.equal(r.launches, 0);
    assert.equal(r.status, 2);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    assert.match(r.manifest.outcome_reason, /^invalid_contract_after_repair: /);
    assert.equal(r.manifest.attempts.length, 0);
    assert.ok(!r.events.some((e) => e.type === 'contract.needs_approval'), 'no approval step');
    assert.match(r.out, /QB couldn't build a reliable checklist\. No code was changed\./);
    // Not in normal terminal output: the drafts or the parse diagnostics.
    assert.doesNotMatch(r.out, /Unexpected token|\[greeting, "test"\]|"args": \[Arshad\]|Raw:/);
    // In local run evidence: both drafts, size-limited and redacted, with their diagnostics.
    const ev = r.artifact('contract-repair');
    assert.deepEqual(ev.rejected.map((d) => d.kind), ['syntax', 'syntax']);
    assert.match(ev.rejected[0].diagnostic, /Unexpected token 'g'/);
    assert.equal(ev.rejected[0].raw_truncated, true);
    assert.ok(ev.rejected[0].raw.length <= 16 * 1024, `raw kept to 16 KiB, got ${ev.rejected[0].raw.length}`);
    assert.ok(ev.rejected[0].raw_bytes > 40_000);
    assert.doesNotMatch(JSON.stringify(ev), new RegExp(SECRET), 'redacted');
    assert.match(ev.rejected[1].raw, /"args": \[Arshad\]/);
  });

  test('qb.js valid first draft: one model call, then the usual review', () => {
    const r = runCli({ replies: [FAITHFUL, MALFORMED] });
    assert.equal(r.modelCalls, 1, r.out);
    assert.match(r.manifest.outcome_reason, /needs_contract_approval/);
    assert.equal(r.artifact('contract-repair'), null);
  });

  test('qb.js user-supplied malformed --contract-file: refused as supplied, never regenerated, zero model calls', () => {
    const r = runCli({ replies: [FAITHFUL], extra: (tmp) => { const f = path.join(tmp, 'c.json'); fs.writeFileSync(f, MALFORMED); return ['--contract-file', f]; } });
    assert.equal(r.modelCalls, 0, r.out);
    assert.equal(r.launches, 0);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    assert.match(r.out, /Contract file rejected/);
    assert.equal(r.artifact('contract-repair'), null);
  });
});
