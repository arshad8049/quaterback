/**
 * QB-08: only a finalized contract (goal, nonempty unique acceptance criteria,
 * no open clarifying question) may reach the agent or verification. Empty ACs,
 * a missing goal, duplicate IDs, a first and a second clarification never
 * execute the agent or return PASS — at the library boundaries, in the CLI
 * (interactive answer flag and noninteractive mode) and in the benchmark.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { contractState } = require('../../intent/contract-state');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const store = require('../../run/store');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const PRELOAD_AGENT = path.join(__dirname, '..', 'helpers', 'preload-fake-sandbox.js');

const GOOD = { id: 'c', goal: 'Add clamp', acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported', met: null }], clarifying_question: null };
const BAD = {
  'empty ACs':            { ...GOOD, acceptance_criteria: [] },
  'missing ACs':          { id: 'c', goal: 'Add clamp' },
  'missing goal':         { ...GOOD, goal: '' },
  'duplicate IDs':        { ...GOOD, acceptance_criteria: [{ id: 'AC-1', criterion: 'a' }, { id: 'AC-1', criterion: 'b' }] },
  'blank criterion':      { ...GOOD, acceptance_criteria: [{ id: 'AC-1', criterion: '  ' }] },
  'clarification only':   { id: 'probe', clarifying_question: 'Which behavior?' },
  'clarification + ACs':  { ...GOOD, clarifying_question: 'Which file?' },
  'not an object':        null,
};
const DIFF = 'diff --git a/x b/x\n+x';

describe('contractState', () => {
  test('a complete contract is finalized', () => assert.equal(contractState(GOOD).state, 'finalized'));
  for (const [name, c] of Object.entries(BAD)) {
    test(`${name} is not finalized`, () => {
      const s = contractState(c);
      assert.notEqual(s.state, 'finalized');
      assert.equal(s.state, name.startsWith('clarification') ? 'needs_clarification' : 'invalid');
    });
  }
});

describe('library boundaries', () => {
  for (const [name, c] of Object.entries(BAD)) {
    test(`verify(): ${name} → unresolved, judge never called`, async () => {
      const { verify } = require('../../verify/verifier');
      const m = mockFetch(ollamaReply({ met: true, evidence: 'x' }));
      try {
        const r = await verify(c, null, { id: 'e', status: 'completed', diff: DIFF }, { repoPath: null });
        assert.equal(r.verdict, 'unresolved');
        assert.equal(m.calls.length, 0);
      } finally { m.restore(); }
    });
    test(`execute(): ${name} → blocked, the agent never starts`, async () => {
      const { execute } = require('../../agent/runner');
      let started = false;
      const e = await execute('brief', c || {}, null, { agent: 'claude-code', repoPath: '/r', runSandboxed: async () => { started = true; return {}; } });
      assert.equal(started, false);
      assert.equal(e.status, 'blocked');
      assert.match(e.error, /^contract (needs_clarification|invalid)/);
    });
  }
  test('aggregate: an empty criteria list can never pass', () => {
    const { aggregate } = require('../../verify/verdict');
    assert.equal(aggregate({ hasDiff: true, criteriaResults: [], testResults: null }).verdict, 'unresolved');
  });
});

describe('entry points', () => {
  let tmp, repo, marker, script;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb08-'));
    repo = makeRepo({ 'src/utils.js': 'module.exports = {};\n' });
    marker = path.join(tmp, 'AGENT-RAN');
    script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [{ touch: marker }, { write: 'src/utils.js', content: 'x\n' }] }));
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  const env = (reply) => ({ ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'),
    QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: JSON.stringify(reply) });
  const qb = (reply, extra = []) => spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT,
    path.join(ROOT, 'qb.js'), 'Add clamp', '--repo', repo.dir, '--agent', 'claude-code', '--no-llm-context', ...extra],
  { env: env(reply), encoding: 'utf8', timeout: 30_000 });
  const onlyRun = () => {
    const ids = fs.readdirSync(path.join(tmp, 'runs'));
    assert.equal(ids.length, 1);
    return store.loadRun(ids[0], path.join(tmp, 'runs')).manifest;
  };
  const CLARIFY = { ambiguity_flags: ['which file'], clarifying_question: 'Which file should change?' };
  const contract = (acs) => ({ goal: 'Add clamp', required_behavior: ['clamp'], constraints: [], acceptance_criteria: acs,
    verification_plan: ['tests'], relevant_context: [], ambiguity_flags: [], clarifying_question: null });

  test('CLI, noninteractive: a first clarification ends BLOCKED needs_clarification without prompting or running the agent', () => {
    const r = qb(CLARIFY);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /Which file should change\?/);
    assert.match(r.stdout, /--clarify/);
    const m = onlyRun();
    assert.deepEqual([m.outcome, m.outcome_reason, m.attempts.length], ['BLOCKED', 'needs_clarification', 0]);
    assert.equal(fs.existsSync(marker), false, 'the agent ran');
  });

  test('CLI: a second clarification after --clarify ends BLOCKED, agent never runs', () => {
    const r = qb(CLARIFY, ['--clarify', 'src/utils.js']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const m = onlyRun();
    assert.deepEqual([m.outcome, m.outcome_reason, m.attempts.length], ['BLOCKED', 'needs_clarification', 0]);
    assert.equal(fs.existsSync(marker), false);
  });

  test('CLI: duplicate AC IDs end BLOCKED invalid_contract, agent never runs', () => {
    const r = qb(contract([{ id: 'AC-1', criterion: 'a' }, { id: 'AC-1', criterion: 'b' }]));
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const m = onlyRun();
    assert.deepEqual([m.outcome, m.attempts.length], ['BLOCKED', 0]);
    assert.match(m.outcome_reason, /^invalid_contract/);
    assert.equal(fs.existsSync(marker), false);
  });

  test('CLI: empty ACs never run the agent or verify', () => {
    qb(contract([]));
    const m = onlyRun();
    assert.notEqual(m.outcome, 'VERIFIED');
    assert.equal(m.attempts.length, 0);
    assert.equal(fs.existsSync(marker), false);
  });

  test('benchmark: a clarification blocks the task in both arms; no agent runs', () => {
    const tasks = path.join(tmp, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify({ meta: { repo: repo.dir, base_rev: 'HEAD' },
      tasks: [{ id: 'X-1', difficulty: 'easy', tags: [], description: 'Add clamp' }] }));
    const r = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'bench', 'run.js'),
      '--tasks', tasks, '--results', path.join(tmp, 'results'), '--no-llm-context', '--max-retries', '1'],
    { env: env(CLARIFY), encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(marker), false, 'an agent ran on a clarification-only contract');
    const [f] = fs.readdirSync(path.join(tmp, 'results')).filter((x) => x.startsWith('X-1'));
    const result = JSON.parse(fs.readFileSync(path.join(tmp, 'results', f), 'utf8'));
    assert.equal(result.qb.final_verdict, 'needs_clarification');
    assert.equal(result.baseline, undefined);
    const runs = fs.readdirSync(path.join(tmp, 'runs')).map((id) => store.loadRun(id, path.join(tmp, 'runs')).manifest);
    assert.deepEqual(runs.map((m) => [m.kind, m.outcome, m.outcome_reason, m.attempts.length]),
      [['bench-qb', 'BLOCKED', 'needs_clarification', 0]]);
  });
});

// ── Senior review (KAN-8 sent back at 0377296): compiler normalization bypassed the gate ──
const BASE = { goal: 'Add explicit feature', required_behavior: ['feature'], constraints: [], verification_plan: ['tests'],
  relevant_context: [], ambiguity_flags: [], clarifying_question: null };
const BYPASS = {
  'criterion {} (was serialized to "{}")':          { ...BASE, acceptance_criteria: [{}] },
  'criterion with only an id (was "AC-1")':         { ...BASE, acceptance_criteria: [{ id: 'AC-1' }] },
  'criterion text under another key':               { ...BASE, acceptance_criteria: [{ id: 'AC-1', description: 'feature works' }] },
  'criterion as a non-string':                      { ...BASE, acceptance_criteria: [{ id: 'AC-1', criterion: { text: 'x' } }] },
  'criterion as a bare string':                     { ...BASE, acceptance_criteria: ['feature works'] },
};
const QUESTIONS = {
  'short real question (was dropped: <=10 chars)':  'Which OS?',
  'question starting "No" (was dropped by prefix)': 'No tests exist yet; which framework should be used?',
  'question starting "None"':                       'None of the files match; which directory?',
  'question starting "N/A"':                        'N/A for web; which mobile platform?',
};

describe('compiler → gate: malformed criteria and real questions are never finalized', () => {
  const { compile } = require('../../intent/compiler');
  const compiled = async (reply) => {
    const m = mockFetch(ollamaReply(reply));
    try { return await compile('Add explicit feature to the app'); } finally { m.restore(); }
  };
  for (const [name, reply] of Object.entries(BYPASS)) {
    test(`${name} → invalid, cannot verify`, async () => {
      const c = await compiled(reply);
      assert.equal(contractState(c).state, 'invalid');
      const { verify } = require('../../verify/verifier');
      const m = mockFetch(ollamaReply({ met: true, evidence: 'x' }));
      try { assert.equal((await verify(c, null, { id: 'e', status: 'completed', diff: DIFF }, {})).verdict, 'unresolved'); }
      finally { m.restore(); }
    });
  }
  for (const [name, q] of Object.entries(QUESTIONS)) {
    test(`${name} → needs_clarification, question preserved`, async () => {
      for (const reply of [{ ambiguity_flags: [], clarifying_question: q },
        { ...BASE, acceptance_criteria: [{ id: 'AC-1', criterion: 'feature works' }], clarifying_question: q }]) {
        const s = contractState(await compiled(reply));
        assert.deepEqual([s.state, s.question], ['needs_clarification', q]);
      }
    });
  }
  test('only exact documented sentinels mean "no question"', async () => {
    const { NO_QUESTION_SENTINELS } = require('../../intent/compiler');
    for (const q of [null, '', '   ', 'None', 'none.', 'N/A', 'No clarification needed']) {
      const c = await compiled({ ...BASE, acceptance_criteria: [{ id: 'AC-1', criterion: 'feature works' }], clarifying_question: q });
      assert.equal(contractState(c).state, 'finalized', JSON.stringify(q));
    }
    assert.ok(NO_QUESTION_SENTINELS.has('none'));
  });
});

describe('compiler bypasses at the entry points: the agent never runs', () => {
  let tmp, repo, marker, script;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb08b-'));
    repo = makeRepo({ 'src/utils.js': 'module.exports = {};\n' });
    marker = path.join(tmp, 'AGENT-RAN');
    script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [{ touch: marker }, { write: 'src/utils.js', content: 'x\n' }] }));
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const env = (reply) => ({ ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'),
    QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: JSON.stringify(reply) });
  const runs = () => fs.readdirSync(path.join(tmp, 'runs')).map((id) => store.loadRun(id, path.join(tmp, 'runs')).manifest);

  const CLI_CASES = { ...BYPASS,
    'short real question': { ...BASE, acceptance_criteria: [{ id: 'AC-1', criterion: 'feature works' }], clarifying_question: 'Which OS?' } };
  for (const [name, reply] of Object.entries(CLI_CASES)) {
    test(`CLI: ${name} → BLOCKED, no attempt, agent never runs`, () => {
      const r = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'qb.js'),
        'Add explicit feature', '--repo', repo.dir, '--agent', 'claude-code', '--no-llm-context'],
      { env: env(reply), encoding: 'utf8', timeout: 30_000 });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      const [m] = runs();
      assert.deepEqual([m.outcome, m.attempts.length], ['BLOCKED', 0]);
      assert.equal(fs.existsSync(marker), false, 'the agent ran');
    });
  }
  test('benchmark: criterion {} and a short question block the task; no agent runs', () => {
    for (const reply of [BYPASS['criterion {} (was serialized to "{}")'],
      { ...BASE, acceptance_criteria: [{ id: 'AC-1', criterion: 'feature works' }], clarifying_question: 'Which OS?' }]) {
      fs.rmSync(path.join(tmp, 'runs'), { recursive: true, force: true });
      const tasks = path.join(tmp, 'tasks.json');
      fs.writeFileSync(tasks, JSON.stringify({ meta: { repo: repo.dir, base_rev: 'HEAD' },
        tasks: [{ id: 'X-1', difficulty: 'easy', tags: [], description: 'Add explicit feature' }] }));
      const r = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'bench', 'run.js'),
        '--tasks', tasks, '--results', path.join(tmp, 'results'), '--no-llm-context', '--max-retries', '1'],
      { env: env(reply), encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.deepEqual(runs().map((m) => [m.outcome, m.attempts.length]), [['BLOCKED', 0]]);
      assert.equal(fs.existsSync(marker), false);
    }
  });
});
