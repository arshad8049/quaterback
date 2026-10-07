/**
 * QB-28 behaviour preservation: the qb.js attempt loop is extracted into a shared module
 * (used by qb.js and by the benchmark's QB arms). These scenarios pin what ordinary QB
 * does — run record, events, attempts, routing, console outcome lines, and the memory
 * hand-off — and were recorded on the code BEFORE the extraction. They must pass
 * unchanged after it.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const store = require('../../run/store');
const mstore = require('../../memory/store');
const { makeRepo } = require('../helpers/tmprepo');

const ROOT = path.join(__dirname, '..', '..');
const HELPERS = (v) => `function parseDuration(s) {\n  return ${v};\n}\nmodule.exports = { parseDuration };\n`;
const NO = JSON.stringify({ met: false, evidence: 'parseDuration ignores minutes', repair: 'Handle the m unit in parseDuration' });

let tmp, n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb28-golden-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** One qb.js run (fake sandbox + stub judge that always says "not met, with a repair"). */
function qbRun(repoDir, patches, { maxRetries = 3, mem } = {}) {
  const dir = path.join(tmp, `run${n++}`); fs.mkdirSync(dir);
  const file = path.join(dir, 'contract.json');
  fs.writeFileSync(file, JSON.stringify({ goal: 'Fix parseDuration', required_behavior: ['parseDuration handles minutes'],
    acceptance_criteria: [{ id: 'AC-1', criterion: 'parseDuration handles minutes', kind: 'non_behavioral', requirement_ids: ['R-1'] }],
    verification_plan: ['read helpers'], requirements: [{ id: 'R-1', quote: 'Fix parseDuration' }], scope: { allowed_changes: ['**'] } }));
  const script = path.join(dir, 'agent.json');
  fs.writeFileSync(script, JSON.stringify({ attempts: patches.map((v) => ({ steps: [{ write: 'src/utils/helpers.js', content: HELPERS(v) }] })) }));
  const runs = path.join(dir, 'runs');
  const res = spawnSync(process.execPath, ['--require', path.join(ROOT, 'test/helpers/preload-ollama.js'), '--require', path.join(ROOT, 'test/helpers/preload-fake-sandbox.js'),
    path.join(ROOT, 'qb.js'), 'Fix parseDuration', '--repo', repoDir, '--agent', 'claude-code', '--no-llm-context', '--max-retries', String(maxRetries), '--contract-file', file],
  { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_TEST_CONTEXT: '', QB_FAKE_AGENT_SCRIPT: script, QB_FAKE_AGENT_COUNTER: path.join(dir, 'counter'),
    QB_FAKE_AGENT_BRIEFING_LOG: path.join(dir, 'briefings.jsonl'), QB_RUNS_DIR: runs, QB_MEMORY_DIR: mem, QB_JUDGE_CACHE_DIR: path.join(dir, 'jc'),
    QB_TEST_OLLAMA_SEQUENCE: JSON.stringify(Array(30).fill(NO)) } });
  const run = store.loadRun(fs.readdirSync(runs)[0], runs);
  const ev = store.readEvents(run);
  return {
    res, run, ev,
    briefings: fs.readFileSync(path.join(dir, 'briefings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    keys: res.stdout.split('\n').filter((l) => /RESULT|Attempts:|Stopping|retrying|Reached max|Memory:/.test(l)).map((l) => l.trim()),
  };
}
const withMem = (mem, fn) => { const prev = process.env.QB_MEMORY_DIR; process.env.QB_MEMORY_DIR = mem; try { return fn(); } finally { if (prev === undefined) delete process.env.QB_MEMORY_DIR; else process.env.QB_MEMORY_DIR = prev; } };

const ATTEMPT_EVENTS = ['attempt.started', 'artifact.stored', 'artifact.stored', 'artifact.stored', 'artifact.stored', 'attempt.finished', 'attempt.routed'];

describe('QB-28 golden: ordinary qb.js behaviour is unchanged by the orchestration extraction', () => {
  test('three failing attempts with progress: repair routing, context refresh, max retries, run record and memory', () => {
    const r = makeRepo({ 'src/utils/helpers.js': HELPERS('NaN'), 'README.md': '# demo\n' });
    const mem = path.join(tmp, 'memA');
    try {
      const { res, run, ev, keys } = qbRun(r.dir, [1, 2, 3], { mem });
      assert.equal(res.status, 1, res.stdout + res.stderr);
      assert.deepEqual([run.manifest.outcome, run.manifest.legacy_verdict], ['FAILED', 'fail']);
      assert.deepEqual(run.manifest.attempts.map((a) => [a.attempt, a.parent_attempt, a.repair_reason, a.verdict || a.legacy_verdict || null]),
        [[1, null, [], 'fail'], [2, 1, ['AC-1'], 'fail'], [3, 2, ['AC-1'], 'fail']]);
      assert.deepEqual(ev.map((e) => e.type), ['run.started', 'artifact.stored', 'contract.accepted',
        ...ATTEMPT_EVENTS, 'context.refreshed', ...ATTEMPT_EVENTS, 'context.refreshed', ...ATTEMPT_EVENTS, 'run.usage', 'run.finished']);
      assert.deepEqual(ev.filter((e) => e.type === 'attempt.routed').map((e) => [e.data.attempt, e.data.action, e.data.reason]),
        [[1, 'repair', '1 repair action(s)'], [2, 'repair', '1 repair action(s)'], [3, 'repair', '1 repair action(s)']]);
      assert.deepEqual(keys, ['1 repair action(s) — retrying with repair hints...', '1 repair action(s) — retrying with repair hints...',
        'Reached max retries (3). Needs human review.', 'RESULT: ✗ FAIL', 'Attempts: 3 / 3']);
      withMem(mem, () => {
        assert.deepEqual(mstore.readOutcomes(r.dir).map((o) => [o.verdict, o.attempts, o.attempt_history.map((a) => [a.attempt, a.verdict])]),
          [['fail', 3, [[1, 'fail'], [2, 'fail'], [3, 'fail']]]]);
        assert.deepEqual(mstore.readRepairs(r.dir).map((x) => [x.failed_criterion, x.outcome, x.from_attempt, x.to_attempt]),
          [['AC-1', 'unresolved', 1, 2], ['AC-1', 'unresolved', 2, 3], ['AC-1', 'not_attempted', 3, null]]);
      });
    } finally { r.cleanup(); }
  });

  test('an unchanged patch stops the loop (no progress) after the second attempt', () => {
    const r = makeRepo({ 'src/utils/helpers.js': HELPERS('NaN'), 'README.md': '# demo\n' });
    try {
      const { run, ev, keys } = qbRun(r.dir, [1, 1, 1], { mem: path.join(tmp, 'memB') });
      assert.equal(run.manifest.attempts.length, 2);
      assert.deepEqual(ev.filter((e) => e.type === 'attempt.routed').map((e) => [e.data.attempt, e.data.action]), [[1, 'repair'], [2, 'stop']]);
      assert.ok(keys.some((k) => /^~ Stopping: /.test(k)), keys.join('\n'));
      assert.deepEqual(keys.slice(-2), ['RESULT: ✗ FAIL', 'Attempts: 2 / 3']);
    } finally { r.cleanup(); }
  });

  test('memory hand-off: a second run recalls the first run (similar run + file hint); an unresolved repair is not offered as a hint', () => {
    const r = makeRepo({ 'src/utils/helpers.js': HELPERS('NaN'), 'README.md': '# demo\n' });
    const mem = path.join(tmp, 'memC');
    try {
      qbRun(r.dir, [1, 2], { maxRetries: 2, mem });
      const second = qbRun(r.dir, [5], { maxRetries: 1, mem });
      assert.deepEqual(second.keys, ['[L5]   Memory: 1 similar past run(s) on this repo', '[L5]   Memory: 1 file hint(s) for L2',
        'Reached max retries (1). Needs human review.', 'RESULT: ✗ FAIL', 'Attempts: 1 / 1']);
      assert.doesNotMatch(second.briefings[0], /past suggestion|proven fix/);   // QB-23: only observed/proven repairs are recalled
      withMem(mem, () => assert.equal(mstore.readOutcomes(r.dir).length, 2));
    } finally { r.cleanup(); }
  });
});
