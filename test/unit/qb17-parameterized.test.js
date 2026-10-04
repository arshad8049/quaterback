/**
 * QB-17 re-review 2: a parameterized choice needs its value.
 * Selecting "numeric_target" says a measurable target is wanted; it does not supply
 * one. The rule stays open (with a follow-up question) until a valid target —
 * metric, comparator, number — is given; the target is carried, bound to its
 * question, into the compiler input and the approved contract.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const store = require('../../run/store');
const { detectAmbiguity, parameterizedChoices } = require('../../intent/dsa');
const { contractState, approve, approvalState } = require('../../intent/contract-state');
const { formatOracle } = require('../../intent/oracle-view');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const REQ = 'Improve performance';
const FINAL = {
  goal: 'Improve performance', required_behavior: ['the hot path is faster'], constraints: [],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'the measured target is met', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: REQ }], verification_plan: ['run the benchmark'], relevant_context: [], ambiguity_flags: [], clarifying_question: null,
};
const userContent = (body) => JSON.parse(body).messages.find((m) => m.role === 'user').content;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let tmp, repo;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb17p-'));
  repo = makeRepo({ 'src/app.js': 'module.exports = {};\n' });
});
afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

function spawnWithLog(script, args, { reply = FINAL } = {}) {
  const log = path.join(tmp, `prompts-${Math.random().toString(36).slice(2)}.ndjson`);
  const r = spawnSync(process.execPath, ['--require', PRELOAD, script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'),
      QB_TEST_OLLAMA_REPLY: JSON.stringify(reply), QB_TEST_PROMPT_LOG: log },
  });
  const prompts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { r, prompts };
}

describe('QB-17 re-review 2: a parameterized choice needs its value', () => {
  test('senior repro: selecting numeric_target without a target stays open with a follow-up question (pre-fix: resolved → finalized)', async () => {
    for (const sel of ['improve_unmeasured=numeric_target', { question: 'improve_unmeasured', choice: 'numeric_target' }]) {
      const d = detectAmbiguity(REQ, [sel]);
      assert.notEqual(d, null, JSON.stringify(sel));
      assert.equal(d.unresolved[0].id, 'improve_unmeasured.target');
      assert.match(d.unresolved[0].question, /metric/i);
    }
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(FINAL));
    try {
      for (const sel of ['improve_unmeasured=numeric_target', { question: 'improve_unmeasured', choice: 'numeric_target' }]) {
        const s = await compileIntent(REQ, { repoPath: repo.dir, answers: [sel] });
        assert.equal(s.state, 'needs_clarification', JSON.stringify(s));
        assert.equal(s.unresolved[0].id, 'improve_unmeasured.target');
      }
      assert.equal(m.calls.length, 0, 'never compiled without a target');
    } finally { m.restore(); }
  });

  test('senior repro through the CLI handoffs: no target → qb.js BLOCKED (agent never runs); intent/cli.js exit 2, model never called', () => {
    const { r } = spawnWithLog(path.join(ROOT, 'qb.js'), [REQ, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--clarify', 'improve_unmeasured=numeric_target']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const run = store.loadRun(fs.readdirSync(path.join(tmp, 'runs'))[0], path.join(tmp, 'runs'));
    assert.deepEqual([run.manifest.outcome, run.manifest.outcome_reason], ['BLOCKED', 'needs_clarification']);
    assert.deepEqual(run.manifest.attempts, [], 'no attempt started: the agent was never invoked');
    const cli = spawnWithLog(path.join(ROOT, 'intent', 'cli.js'), [REQ, '--repo', repo.dir, '--clarify', 'improve_unmeasured=numeric_target']);
    assert.equal(cli.r.status, 2, cli.r.stdout + cli.r.stderr);
    const h = JSON.parse(cli.r.stdout.slice(cli.r.stdout.indexOf('{'), cli.r.stdout.lastIndexOf('}') + 1));
    assert.deepEqual([h.state, h.unresolved[0].id], ['needs_clarification', 'improve_unmeasured.target']);
    assert.equal(cli.prompts.length, 0);
  });

  test('invalid or uncertain targets stay open (string, object, free text, follow-up round)', () => {
    for (const a of ['improve_unmeasured=numeric_target:fast', 'improve_unmeasured=numeric_target:200', 'improve_unmeasured=numeric_target:latency 200ms',
      'improve_unmeasured=numeric_target:< 200ms', { question: 'improve_unmeasured', choice: 'numeric_target', value: 'soon' },
      'make it faster', 'maybe under 200ms?', 'probably p95 latency under 200ms']) {
      assert.notEqual(detectAmbiguity(REQ, [a]), null, JSON.stringify(a));
    }
    const twoRounds = detectAmbiguity(REQ, ['improve_unmeasured=numeric_target', { question_id: 'improve_unmeasured.target', answer: 'not sure yet' }]);
    assert.equal(twoRounds.unresolved[0].id, 'improve_unmeasured.target');
  });

  test('positive guards: a concrete target (string, object, follow-up answer, free text) finalizes, carried into compiler input and the approved contract', async () => {
    const { compileIntent } = require('../../intent/session');
    const cases = [
      [['improve_unmeasured=numeric_target:p95 latency < 200ms'], 'p95 latency < 200ms'],
      [[{ question: 'improve_unmeasured', choice: 'numeric_target', value: 'bundle size at most 150 KB' }], 'bundle size at most 150 KB'],
      [['improve_unmeasured=numeric_target', 'reduce runtime by 30%'], 'reduce runtime by 30%'],
      [['p95 latency under 200ms'], 'p95 latency under 200ms'],
    ];
    for (const [answers, value] of cases) {
      const m = mockFetch(ollamaReply(FINAL));
      try {
        const s = await compileIntent(REQ, { repoPath: repo.dir, answers });
        assert.equal(s.state, 'finalized', JSON.stringify(s));
        assert.match(userContent(m.calls[0].init.body), new RegExp(`Q\\(improve_unmeasured\\): [^\\n]+\\nA: numeric_target = ${esc(value)}`));
        assert.deepEqual(s.contract.clarifications, [{ question_id: 'improve_unmeasured', choice: 'numeric_target', value }]);
        assert.match(formatOracle(s.contract), new RegExp(`improve_unmeasured: numeric_target = ${esc(value)}`));
        const approved = approve(s.contract, { via: 'test' });
        assert.equal(approvalState(approved).approved, true);
        assert.deepEqual(approvalState({ ...approved, clarifications: [{ question_id: 'improve_unmeasured', choice: 'numeric_target', value: 'p95 latency < 900ms' }] }),
          { approved: false, reason: 'changed_after_approval' }, 'the target is part of the approved oracle');
      } finally { m.restore(); }
    }
    const ok = spawnWithLog(path.join(ROOT, 'qb.js'), [REQ, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--clarify', 'improve_unmeasured=numeric_target:p95 latency < 200ms']);
    assert.ok(ok.prompts.length >= 1, ok.r.stdout + ok.r.stderr);
    assert.match(userContent(ok.prompts[0]), /A: numeric_target = p95 latency < 200ms/);
  });

  test('contractState rejects a clarification whose parameterized choice lacks a valid value', () => {
    const base = { ...FINAL, raw_request: REQ, id: 'c' };
    for (const cl of [[{ question_id: 'improve_unmeasured', choice: 'numeric_target', value: null }], [{ question_id: 'improve_unmeasured', choice: 'numeric_target', value: 'soon' }],
      [{ question_id: 'nope', choice: 'x', value: null }], 'improve_unmeasured=numeric_target']) {
      assert.equal(contractState({ ...base, clarifications: cl }).state, 'invalid', JSON.stringify(cl));
    }
    assert.equal(contractState({ ...base, clarifications: [{ question_id: 'improve_unmeasured', choice: 'numeric_target', value: 'p95 latency < 200ms' }] }).state, 'finalized');
  });

  test('audit: numeric_target is the only parameterized choice (the others name a complete aspect)', () => {
    assert.deepEqual(parameterizedChoices(), ['improve_unmeasured.numeric_target']);
  });
});
