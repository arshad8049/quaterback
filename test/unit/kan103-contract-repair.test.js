/**
 * KAN-103 (beta, run 911bbb8f-d420-4e5e-8228-e176f1b663cc): the tester's request was actionable, but
 * the local model's draft contract misquoted "as integer" as "asinteger", left the request untraced,
 * and proposed two defaults nobody asked for (16-bit integers, an exact "Invalid input" message). The
 * validator rightly rejected the draft, and QB then BLOCKED the run: the tester had to start over for
 * QB's own mistake.
 *
 * QB now gets ONE chance to correct a draft it generated: the request, the rejected draft and the
 * validation errors go back to the compiler, within the run's deadline, and the correction goes
 * through the SAME validator. The validator is unchanged, and so is the approval boundary:
 *   - a user-supplied --contract-file is never rewritten;
 *   - a repaired contract is never approved automatically;
 *   - a correction may not keep a default the validator flagged as uncovered by adding criteria
 *     that cite it (it must drop it).
 * This is separate from the coding agent's --max-retries. Fixtures: test/fixtures/kan103 (fixed
 * model replies; no live model).
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

const FIX = path.join(__dirname, '..', 'fixtures', 'kan103');
const REQUEST = fs.readFileSync(path.join(FIX, 'request.txt'), 'utf8').trim();
const draft = (name) => fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8');
const BAD = draft('bad-draft');
const GOOD = draft('corrected-draft');
const STILL_BAD = draft('still-bad-draft');
const JUSTIFIED = draft('justified-defaults-draft');

const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD_OLLAMA = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const PRELOAD_SPY = path.join(__dirname, '..', 'helpers', 'preload-sandbox-spy.js');
// A small node:test repository with config files, like the tester's starter-node-js.
const STARTER = {
  'package.json': JSON.stringify({ name: 'starter', version: '1.0.0', type: 'commonjs', scripts: { test: 'node --test' } }, null, 2),
  'eslint.config.js': 'module.exports = [{ rules: { semi: ["error", "always"] } }];\n',
  'src/greeting.js': 'module.exports = { greet: (n) => `Hello, ${n}` };\n',
  'test/greeting.test.js': "const { test } = require('node:test');\ntest('greets', () => {});\n",
};

/** compileIntent with the model replying `replies` in order; returns the result and what was sent. */
async function compileWith(replies) {
  let i = 0;
  const m = mockFetch(() => ollamaReply(replies[Math.min(i++, replies.length - 1)]));
  try {
    const s = await compileIntent(REQUEST);
    return { s, calls: m.calls.length, prompts: m.calls.map((c) => JSON.parse(c.init.body).messages) };
  } finally { m.restore(); }
}

const SIX_PARTS = [
  ['repo conventions', /config files and treat them as my developer conventions/],
  ['src/', /add a cart module in src\//],
  ['integer cents', /stores money as integer cents/],
  ['negative quantities', /rejects negative quantities/],
  ['node:test', /node:test cases/],
  ['rounding case', /0\.1 \+ 0\.2 style rounding trap/],
];

describe('KAN-103: QB repairs its own invalid draft contract once before blocking the user', () => {
  test('bad → good: one correction, through the same validator; all six parts kept, invented defaults gone (pre-fix: state invalid after 1 call)', async () => {
    const { s, calls, prompts } = await compileWith([BAD, GOOD]);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.equal(calls, 2, 'exactly one correction call');
    const quotes = s.contract.requirements.map((r) => r.quote).join(' | ');
    for (const [label, re] of SIX_PARTS) assert.match(quotes, re, label);
    assert.deepEqual(s.contract.proposed_defaults, []);
    assert.doesNotMatch(JSON.stringify(s.contract), /16-bit|Invalid input|asinteger/);
    assert.equal(s.contract.approval, undefined, 'a repaired contract is never approved automatically');
    // The rejected draft and its errors are kept for engineering.
    assert.equal(s.repair.attempted, true);
    assert.equal(s.repair.rejected.length, 1);
    assert.match(s.repair.rejected[0].errors.join('\n'), /asinteger/);
    assert.match(JSON.stringify(s.repair.rejected[0].contract), /16-bit integers/);
    // The correction request carries the original request, the rejected draft and the errors.
    const sent = prompts[1].map((m) => m.content).join('\n');
    assert.ok(sent.includes(REQUEST), 'original request sent');
    assert.match(sent, /stores money asinteger cents/, 'rejected draft sent');
    assert.match(sent, /R-1 quote is not in the request verbatim/, 'validation errors sent');
    assert.match(sent, /proposed default D-1 .* is not covered/);
  });

  test('bad → bad: one correction only, then invalid with both drafts and their errors', async () => {
    const { s, calls } = await compileWith([BAD, STILL_BAD, GOOD]);
    assert.equal(calls, 2, 'no second correction');
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join('\n'), /R-1 quote is not in the request verbatim/);
    assert.equal(s.repair.attempted, true);
    assert.equal(s.repair.rejected.length, 2);
    assert.match(s.repair.rejected[0].errors.join('\n'), /D-1/);
    assert.doesNotMatch(s.repair.rejected[1].errors.join('\n'), /D-1/);
  });

  test('a correction that keeps a flagged default by adding criteria that cite it is refused (the validator alone would accept it)', async () => {
    const { s, calls } = await compileWith([BAD, JUSTIFIED]);
    assert.equal(calls, 2);
    assert.equal(s.state, 'invalid');
    const errors = s.errors.join('\n');
    assert.match(errors, /D-1 .*16-bit integers.* was flagged as uncovered in the rejected draft/);
    assert.match(errors, /D-2 .*Invalid input.* was flagged as uncovered in the rejected draft/);
  });

  test('the correction runs within the existing run deadline: a deadline during the correction cancels the run in L1', async () => {
    const budget = require('../../lib/budget');
    let i = 0;
    // First call: the bad draft. Second call (the correction): never answers.
    const m = mockFetch(() => (i++ === 0 ? ollamaReply(BAD) : new Promise(() => {})));
    try {
      const run = budget.startRun({ deadlineMs: 300 });
      run.stage('L1 intent');
      const started = Date.now();
      await assert.rejects(compileIntent(REQUEST), (e) => e.code === 'DEADLINE' && e.kind !== 'call');
      assert.ok(Date.now() - started < 3000, 'cancelled at the run deadline, not a per-call timeout');
      assert.equal(m.calls.length, 2, 'the correction was the call in flight');
      assert.deepEqual(run.interrupted(), { stage: 'L1 intent', deadline_ms: 300 });
    } finally { budget.endRun(); m.restore(); }
  });

  test('good first draft: no extra model call, no repair recorded', async () => {
    const { s, calls } = await compileWith([GOOD, BAD]);
    assert.equal(s.state, 'finalized');
    assert.equal(calls, 1);
    assert.equal(s.repair, undefined);
  });

  /** qb.js end to end: model replies scripted, sandbox spied; returns what happened. */
  function runCli({ replies, agent = 'dry-run', extra = [] }) {
    const repo = makeRepo(STARTER);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan103-'));
    try {
      const fetchLog = path.join(tmp, 'fetch.log'); const sandboxLog = path.join(tmp, 'sandbox.log'); const runs = path.join(tmp, 'runs');
      const args = typeof extra === 'function' ? extra(tmp) : extra;
      const r = proc.run(process.execPath, ['--require', PRELOAD_OLLAMA, '--require', PRELOAD_SPY, QB, REQUEST, '--repo', repo.dir,
        '--agent', agent, '--no-llm-context', '--no-llm-verify', ...args], {
        env: { ...process.env, QB_TEST_FETCH_LOG: fetchLog, QB_TEST_SANDBOX_LOG: sandboxLog, QB_RUNS_DIR: runs,
          QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(replies) },
        encoding: 'utf8', timeout: 60_000,
      });
      const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
      const runIds = fs.existsSync(runs) ? fs.readdirSync(runs) : [];
      const dir = runIds.length === 1 ? path.join(runs, runIds[0]) : null;
      const manifest = dir ? JSON.parse(read(path.join(dir, 'manifest.json'))) : null;
      const events = dir ? read(path.join(dir, 'events.jsonl')).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      // Read every stored JSON artifact now: the temporary directory is removed below.
      const stored = Object.fromEntries(Object.entries(manifest?.artifacts || {}).filter(([, ref]) => ref.path.endsWith('.json'))
        .map(([name, ref]) => [name, JSON.parse(read(path.join(dir, ref.path)))]));
      const artifact = (name) => stored[name] ?? null;
      return { status: r.status, out: r.stdout + r.stderr, modelCalls: read(fetchLog).split('\n').filter(Boolean).length,
        launches: read(sandboxLog).split('\n').filter(Boolean).length, manifest, events, artifact };
    } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  test('qb.js dry run, bad → good: reaches the agent stage (briefing) after one correction; the rejected draft is in the run record', () => {
    const r = runCli({ replies: [BAD, GOOD] });
    assert.equal(r.modelCalls, 2, r.out);
    assert.match(r.out, /corrected/i);
    assert.match(r.out, /\[L3\]\s+Execution done .*status=dry_run/, r.out);
    assert.equal(r.manifest.outcome, 'DRY_RUN', r.out);
    const drafts = r.artifact('contract-repair');
    assert.ok(drafts, 'repair artifact stored');
    assert.equal(drafts.rejected.length, 1);
    assert.match(JSON.stringify(drafts.rejected[0]), /asinteger/);
    assert.ok(r.events.some((e) => e.type === 'contract.repaired'), 'contract.repaired event');
  });

  test('qb.js real run, bad → good: still needs the human\'s approval; nothing runs without it', () => {
    const r = runCli({ replies: [BAD, GOOD], agent: 'claude-code' });
    assert.equal(r.modelCalls, 2, r.out);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    assert.match(r.manifest.outcome_reason, /needs_contract_approval/);
    assert.equal(r.launches, 0, 'no agent launched');
    assert.match(r.out, /needs a human's approval/);
  });

  test('qb.js bad → bad: BLOCKED after one correction, no agent or tests, a plain explanation, drafts and errors in the run record', () => {
    const r = runCli({ replies: [BAD, STILL_BAD, GOOD], agent: 'claude-code' });
    assert.equal(r.modelCalls, 2, r.out);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.launches, 0);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    assert.match(r.manifest.outcome_reason, /^invalid_contract_after_repair: /);
    assert.equal(r.manifest.attempts.length, 0, 'no attempt: nothing executed or tested');
    assert.match(r.out, /QB could not write a valid contract for this request/);
    assert.match(r.out, /not a problem with your request/i);
    assert.match(r.out, /Nothing was run/);
    const drafts = r.artifact('contract-repair');
    assert.equal(drafts.rejected.length, 2);
    assert.match(drafts.rejected[1].errors.join('\n'), /asinteger/);
    assert.ok(r.events.some((e) => e.type === 'contract.repair_failed'));
  });

  test('qb.js invalid --contract-file: rejected as supplied, never rewritten, zero model calls', () => {
    const r = runCli({ replies: [GOOD], agent: 'claude-code', extra: (tmp) => {
      const f = path.join(tmp, 'contract.json'); fs.writeFileSync(f, BAD); return ['--contract-file', f];
    } });
    assert.equal(r.modelCalls, 0, r.out);
    assert.equal(r.status, 2);
    assert.equal(r.launches, 0);
    assert.equal(r.manifest.outcome, 'BLOCKED');
    assert.match(r.out, /contract file/i);
    assert.match(r.out, /asinteger/);
    assert.equal(r.artifact('contract-repair'), null);
    assert.ok(!r.events.some((e) => /repair/.test(e.type)));
  });
});
