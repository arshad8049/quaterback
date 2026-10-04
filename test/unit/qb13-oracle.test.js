/**
 * QB-13: the test oracle is checked by trusted arithmetic and approved by a human.
 * - computable examples are recomputed independently of any model; the saved
 *   T-002 contract's three arithmetic errors are rejected, a unit-conversion
 *   fixture is checked by trusted calculation;
 * - generated contracts are proposals: a PASS needs a human-approved oracle,
 *   frozen by hash (a change after approval voids it), independent of the
 *   implementation-generating model (contract file / benchmark oracle).
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { validateExamples, parseDuration, formatDuration } = require('../../intent/examples');
const { contractState, approve, approvalState, contractHash } = require('../../intent/contract-state');
const { aggregate } = require('../../verify/verdict');
const { checkSetHash } = require('../../verify/checks/registry');
const { verify } = require('../../verify/verifier');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');
const store = require('../../run/store');

const ROOT = path.join(__dirname, '..', '..');
const T002 = require('../../bench/results/T-002_1790654092867.json').qb.contract;   // the saved artifact from the review

describe('trusted arithmetic for computable examples', () => {
  test('the saved T-002 contract: all three errors are rejected, with the correct values', () => {
    const { errors, checked } = validateExamples(T002);
    assert.deepEqual(errors.map((e) => [e.where, e.claim, e.correct]), [
      ['AC-1', "30000 ms → '5m'", '30s'], ['AC-2', "120000 ms → '20m'", '2m'], ['AC-3', "25000 ms → '4m 10s'", '25s']]);
    assert.deepEqual(checked.map((e) => e.where), ['AC-4']);
    const s = contractState(T002);
    assert.equal(s.state, 'invalid');
    assert.equal(s.errors.length, 3);
    assert.match(s.errors[0], /AC-1 example is wrong: 30000 ms → '5m' \(correct: 30s\)/);
  });
  test('through the real compiler: the T-002 model output is never finalized', async () => {
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply({ ...T002, clarifying_question: null }));
    try { assert.equal(contractState(await compile('Add a formatDuration(ms) function to src/wav.js')).state, 'invalid'); }
    finally { m.restore(); }
  });
  const FIXTURE = { id: 'c', goal: 'Add formatDuration(ms) to src/wav.js, returning text like "1m 23s"', clarifying_question: null,
    acceptance_criteria: [
      { id: 'AC-1', criterion: "formats 83000 ms as '1m 23s'", kind: 'behavioral' },
      { id: 'AC-2', criterion: "formatDuration(45000) → '45s'", kind: 'behavioral' },
      { id: 'AC-3', criterion: 'formats 2 hours as "2h"', kind: 'behavioral' }],
    checks: [{ id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/wav.js', export: 'formatDuration', args: [83000], expect: '1m 23s' } }] };
  test('a unit-conversion fixture is checked by trusted calculation (criteria and checks)', () => {
    const { errors, checked } = validateExamples(FIXTURE);
    assert.deepEqual(errors, []);
    assert.deepEqual(checked.map((e) => e.where).sort(), ['AC-1', 'AC-3', 'CHK-1']);
    assert.equal(contractState(FIXTURE).state, 'finalized');
  });
  test('a wrong expected value in a check is caught too', () => {
    const bad = { ...FIXTURE, checks: [{ ...FIXTURE.checks[0], params: { ...FIXTURE.checks[0].params, args: [30000], expect: '5m' } }] };
    const s = contractState(bad);
    assert.equal(s.state, 'invalid');
    assert.match(s.errors.join(' '), /CHK-1 example is wrong: 30000 (ms|milliseconds?) → '5m' \(correct: 30s\)/);
  });
  test('duration arithmetic', () => {
    assert.deepEqual(['1m 23s', '45s', '0s', '2 minutes', '1h 2m 3s', '1.5s', 'soon', '5m later', ''].map(parseDuration),
      [83000, 45000, 0, 120000, 3723000, 1500, null, null, null]);
    assert.deepEqual([30000, 120000, 25000, 83000, 0].map(formatDuration), ['30s', '2m', '25s', '1m 23s', '0s']);
  });
});

const TREE = 'a'.repeat(40);
const REPORT = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'node-test-reports', 'pass.ndjson'), 'utf8');
const BASE = { id: 'c', goal: 'Add clamp', clarifying_question: null, verification_plan: ['call clamp'], scope: { allowed_changes: ['src/**'] },
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n', met: null, kind: 'behavioral' }],
  checks: [{ id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', params: { module: 'src/u.js', export: 'clamp', args: [5, 0, 3], expect: 3 } }] };
const PASSING = { id: 'e', status: 'completed', diff: 'diff --git a/src/u.js b/src/u.js\n+x', candidate_tree: TREE,
  sandbox: { verification: { status: 'ran', state: 'completed', exit_code: 0, output: '', report: REPORT, tree: TREE },
    checks: { tree: TREE, requested: BASE.checks, check_set_hash: checkSetHash(BASE.checks), results_text: JSON.stringify({ format: 'qb-check-results/1', complete: true, check_set_hash: checkSetHash(BASE.checks),
      results: [{ id: 'CHK-1', ac_id: 'AC-1', adapter: 'call_returns', status: 'pass', detail: 'ok', duration_ms: 1 }] }) } } };

describe('a PASS needs a human-approved, frozen oracle', () => {
  const v = async (c) => { const m = mockFetch(ollamaReply({ met: true, evidence: 'x' })); try { return await verify(c, null, PASSING, {}); } finally { m.restore(); } };
  test('model-generated (unapproved) contract → unresolved, even with passing evidence', async () => {
    const r = await v(BASE);
    assert.equal(r.verdict, 'unresolved');
    assert.deepEqual([r.oracle.approved, r.oracle.reason], [false, 'not_approved']);
  });
  test('approved by a human → pass; the report names the frozen hash', async () => {
    const c = approve(BASE, { via: 'interactive' });
    const r = await v(c);
    assert.equal(r.verdict, 'pass');
    assert.deepEqual([r.oracle.approved, r.oracle.via, r.oracle.contract_hash], [true, 'interactive', contractHash(BASE)]);
  });
  const MUTATIONS = {
    'a criterion reworded':     (c) => ({ ...c, acceptance_criteria: [{ ...c.acceptance_criteria[0], criterion: 'clamp exists' }] }),
    'a check expectation changed': (c) => ({ ...c, checks: [{ ...c.checks[0], params: { ...c.checks[0].params, expect: 5 } }] }),
    'a criterion re-kinded':    (c) => ({ ...c, acceptance_criteria: [{ ...c.acceptance_criteria[0], kind: 'non_behavioral' }] }),
    'a check removed':          (c) => ({ ...c, checks: [] }),
  };
  for (const [name, mut] of Object.entries(MUTATIONS)) {
    test(`changed after approval (${name}) → not approved, cannot pass`, async () => {
      const c = mut(approve(BASE, { via: 'interactive' }));
      assert.deepEqual(approvalState(c), { approved: false, reason: 'changed_after_approval' });
      assert.notEqual((await v(c)).verdict, 'pass');
    });
  }
  test('an approval not made by a human does not count', () => {
    assert.equal(approvalState({ ...approve(BASE, { via: 'x' }), approval: { ...approve(BASE, { via: 'x' }).approval, by: 'model' } }).approved, false);
  });
  test('rules 3 gate; older records replay unchanged', () => {
    const input = { hasDiff: true, criteriaResults: [{ id: 'AC-1', met: true }], testResults: null, verification: { outcome: 'passed' } };
    assert.equal(aggregate({ ...input, rules: 3, oracleApproved: false }).verdict, 'unresolved');
    assert.equal(aggregate({ ...input, rules: 3, oracleApproved: true }).verdict, 'pass');
    assert.equal(aggregate({ ...input, rules: 2 }).verdict, 'pass');
  });
});

describe('entry points: the human approves before anything runs', () => {
  const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
  const PRELOAD_AGENT = path.join(__dirname, '..', 'helpers', 'preload-fake-sandbox.js');
  let tmp, repo, marker, script;
  const MODEL = { goal: 'Add clamp', required_behavior: ['clamp'], constraints: [], verification_plan: ['call clamp'], relevant_context: [],
    ambiguity_flags: [], clarifying_question: null, acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n', kind: 'behavioral', requirement_ids: ['R-1'] }],
    checks: BASE.checks, requirements: [{ id: 'R-1', quote: 'Add clamp' }] };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb13-'));
    repo = makeRepo({ 'src/u.js': 'module.exports = {};\n' });
    marker = path.join(tmp, 'AGENT-RAN');
    script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [{ touch: marker }, { write: 'src/u.js', content: 'x\n' }] }));
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const qb = (extra = [], reply = MODEL) => spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'qb.js'),
    'Add clamp', '--repo', repo.dir, '--agent', 'claude-code', '--no-llm-context', '--max-retries', '1', ...extra],
  { encoding: 'utf8', timeout: 30_000, env: { ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'),
    QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: JSON.stringify(reply) } });
  const runs = () => fs.readdirSync(path.join(tmp, 'runs')).map((id) => store.loadRun(id, path.join(tmp, 'runs')));

  test('noninteractive, no contract file → BLOCKED needs_contract_approval; the proposal is saved; the agent never runs', () => {
    const r = qb();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const [run] = runs();
    assert.deepEqual([run.manifest.outcome, run.manifest.outcome_reason, run.manifest.attempts.length], ['BLOCKED', 'needs_contract_approval', 0]);
    const proposal = JSON.parse(fs.readFileSync(path.join(run.dir, 'proposed-contract.json'), 'utf8'));
    assert.deepEqual(proposal.acceptance_criteria, [{ id: 'AC-1', criterion: 'clamp bounds n', kind: 'behavioral', requirement_ids: ['R-1'] }]);
    assert.deepEqual(proposal.requirements, [{ id: 'R-1', quote: 'Add clamp' }]);
    assert.equal(proposal.checks[0].id, 'CHK-1');
    assert.match(r.stdout, /--contract-file/);
    assert.equal(fs.existsSync(marker), false);
  });
  test('the reviewed file is the oracle: it runs, approved via contract-file and frozen; the model is not asked', () => {
    const file = path.join(tmp, 'contract.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'Add clamp', acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n', requirement_ids: ['R-1'] }],
      verification_plan: ['call clamp'], checks: BASE.checks, requirements: [{ id: 'R-1', quote: 'Add clamp' }],
      approval: { by: 'human', via: 'forged', contract_hash: 'x' } }));                     // an approval in the file is ignored
    const r = qb(['--contract-file', file], { not: 'a contract' });                         // the model reply is unusable: never used
    const [run] = runs();
    assert.equal(run.manifest.attempts.length, 1, r.stdout + r.stderr);
    assert.ok(fs.existsSync(marker), 'the agent ran');
    const c = run.readArtifact('contract');
    assert.equal(c.approval.via, 'contract-file');
    assert.match(c.approval.note, /^sha256:[0-9a-f]{64}$/);
    assert.equal(c.approval.contract_hash, contractHash(c));
  });
  test('a contract file with an arithmetic error is rejected; the agent never runs', () => {
    const file = path.join(tmp, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ goal: 'formatDuration(ms)', acceptance_criteria: [{ id: 'AC-1', criterion: "formats 30000 ms as '5m'" }],
      verification_plan: ['x'] }));
    const r = qb(['--contract-file', file]);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const [run] = runs();
    assert.equal(run.manifest.outcome, 'BLOCKED');
    assert.match(run.manifest.outcome_reason, /invalid_contract: AC-1 example is wrong/);
    assert.equal(fs.existsSync(marker), false);
  });

  test('benchmark: a task with a human-written oracle is approved; without one it cannot pass', () => {
    const tasks = path.join(tmp, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify({ meta: { repo: repo.dir, base_rev: 'HEAD' }, tasks: [
      { id: 'X-1', difficulty: 'easy', tags: [], description: 'Add clamp',
        oracle: { approved_by: 'reviewer', acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n', requirement_ids: ['R-1'] }], verification_plan: ['call clamp'], checks: BASE.checks,
          requirements: [{ id: 'R-1', quote: 'Add clamp' }] } },
      { id: 'X-2', difficulty: 'easy', tags: [], description: 'Add clamp' }] }));
    const r = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'bench', 'run.js'),
      '--tasks', tasks, '--results', path.join(tmp, 'results'), '--no-llm-context', '--max-retries', '1', '--no-baseline'],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'),
      QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: JSON.stringify(MODEL) } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const res = (id) => JSON.parse(fs.readFileSync(path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results')).find((f) => f.startsWith(id))), 'utf8')).qb;
    assert.deepEqual(res('X-1').oracle, { approved: true, via: 'benchmark-oracle' });
    assert.deepEqual(res('X-2').oracle, { approved: false, via: null });
    assert.notEqual(res('X-2').final_verdict, 'pass');
  });
});

// ── KAN-13 review (68122d8): approval is enforced at the shared execution boundary ──
describe('shared execution boundary: no agent without a current human approval', () => {
  const { execute } = require('../../agent/runner');
  const { runBaseline } = require('../../bench/baseline');
  const spy = () => { const s = { calls: 0, args: null }; s.fn = async (a) => { s.calls++; s.args = a; return { status: 'completed', changes: [] }; }; return s; };
  const ex = (contract, agent = 'claude-code', extra = {}) => { const s = spy(); return execute('brief', contract, null, { agent, repoPath: '/r', runSandboxed: s.fn, ...extra }).then((r) => ({ r, s })); };

  test('a finalized but unapproved contract never reaches the sandbox', async () => {
    const { r, s } = await ex(BASE);
    assert.equal(s.calls, 0);
    assert.deepEqual([r.status, r.error], ['blocked', 'contract not approved: not_approved']);
  });
  test('approved, then the goal changed → blocked before the sandbox', async () => {
    const { r, s } = await ex({ ...approve(BASE, { via: 'interactive' }), goal: 'something else' });
    assert.equal(s.calls, 0);
    assert.equal(r.error, 'contract not approved: changed_after_approval');
  });
  test('the manual agent is gated too; a dry run needs no oracle', async () => {
    assert.equal((await ex(BASE, 'manual')).r.status, 'blocked');
    assert.equal((await ex(BASE, 'dry-run')).r.status, 'dry_run');
  });
  test('approved → runs; the explicit exploration mode is the only unapproved path', async () => {
    assert.equal((await ex(approve(BASE, { via: 'interactive' }))).s.calls, 1);
    assert.equal((await ex(BASE, 'claude-code', { unapprovedExploration: true })).s.calls, 1);
  });
  test('benchmark baseline: same gate, and the same approved checks', async () => {
    const s1 = spy();
    const blocked = await runBaseline('task', '/r', { contract: BASE, runSandboxed: s1.fn });
    assert.deepEqual([blocked.status, s1.calls], ['blocked', 0]);
    const s2 = spy();
    await runBaseline('task', '/r', { contract: approve(BASE, { via: 'benchmark-oracle' }), runSandboxed: s2.fn });
    assert.equal(s2.calls, 1);
    assert.deepEqual(s2.args.checks, BASE.checks);
  });
});

describe('the approval view shows everything the approval covers', () => {
  test('goal, required behaviour, constraints, criteria, plan and checks are all shown', () => {
    const { formatOracle } = require('../../intent/oracle-view');
    const c = { ...BASE, goal: 'GOAL-x', required_behavior: ['REQ-x'], constraints: ['CON-x'], verification_plan: ['PLAN-x'],
      acceptance_criteria: [{ id: 'AC-1', criterion: 'CRIT-x', kind: 'behavioral' }] };
    const text = formatOracle(c);
    for (const needle of ['GOAL-x', 'REQ-x', 'CON-x', 'CRIT-x', 'PLAN-x', 'CHK-1', '"expect":3', 'src/**', 'UNENFORCED', contractHash(c).slice(0, 16)]) {
      assert.ok(text.includes(needle), `missing ${needle}`);
    }
    const { approvedContent } = require('../../intent/contract-state');
    assert.deepEqual(Object.keys(approvedContent(c)).sort(),
      ['acceptance_criteria', 'checks', 'constraint_policy', 'constraints', 'goal', 'required_behavior', 'requirements', 'scope', 'verification_plan'], 'a new hashed field must be added to the view');
  });
});

describe('standalone agent CLI and benchmark honour the boundary', () => {
  const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
  const PRELOAD_AGENT = path.join(__dirname, '..', 'helpers', 'preload-fake-sandbox.js');
  let tmp, repo, marker, script, file;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb13b-'));
    repo = makeRepo({ 'src/u.js': 'module.exports = {};\n' });
    marker = path.join(tmp, 'AGENT-RAN');
    script = path.join(tmp, 'agent.json');
    fs.writeFileSync(script, JSON.stringify({ steps: [{ touch: marker }, { write: 'src/u.js', content: 'x\n' }] }));
    file = path.join(tmp, 'contract.json');
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });
  const env = () => ({ ...process.env, QB_FAKE_AGENT_SCRIPT: script, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'),
    QB_TEST_OLLAMA_REPLY: JSON.stringify({ goal: 'Add clamp', required_behavior: ['clamp'], constraints: [], verification_plan: ['call clamp'],
      relevant_context: [], ambiguity_flags: [], clarifying_question: null, acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp bounds n', requirement_ids: ['R-1'] }], checks: BASE.checks,
      requirements: [{ id: 'R-1', quote: 'Add clamp' }] }) });
  const agentCli = (extra = []) => spawnSync(process.execPath, ['--require', PRELOAD_AGENT, path.join(ROOT, 'agent', 'cli.js'),
    '--contract', file, '--agent', 'claude-code', '--repo', repo.dir, ...extra], { encoding: 'utf8', timeout: 30_000, env: env() });

  const TRACED = { ...BASE, raw_request: 'Add clamp', requirements: [{ id: 'R-1', quote: 'Add clamp' }],
    acceptance_criteria: [{ ...BASE.acceptance_criteria[0], requirement_ids: ['R-1'] }] };
  test('agent/cli.js: unapproved → exit 2, the agent never runs', () => {
    fs.writeFileSync(file, JSON.stringify(TRACED));
    const r = agentCli();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /contract not approved/);
    assert.equal(fs.existsSync(marker), false);
  });
  test('agent/cli.js: an approval written into the file is ignored', () => {
    fs.writeFileSync(file, JSON.stringify(approve(TRACED, { via: 'forged' })));
    assert.equal(agentCli().status, 2);
    assert.equal(fs.existsSync(marker), false);
  });
  test('agent/cli.js: --approve-contract (shown the full oracle first) → runs', () => {
    fs.writeFileSync(file, JSON.stringify(TRACED));
    const r = agentCli(['--approve-contract']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Test oracle — review everything below/);
    assert.ok(fs.existsSync(marker), 'the agent ran');
  });

  const bench = (extra = []) => {
    const tasks = path.join(tmp, 'tasks.json');
    fs.writeFileSync(tasks, JSON.stringify({ meta: { repo: repo.dir, base_rev: 'HEAD' }, tasks: [{ id: 'X-1', difficulty: 'easy', tags: [], description: 'Add clamp' }] }));
    const r = spawnSync(process.execPath, ['--require', PRELOAD, '--require', PRELOAD_AGENT, path.join(ROOT, 'bench', 'run.js'),
      '--tasks', tasks, '--results', path.join(tmp, 'results'), '--no-llm-context', '--max-retries', '1', ...extra], { encoding: 'utf8', timeout: 60_000, env: env() });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(fs.readFileSync(path.join(tmp, 'results', fs.readdirSync(path.join(tmp, 'results'))[0]), 'utf8'));
  };
  test('benchmark without an oracle: blocked (needs_oracle), no agent in either arm', () => {
    const res = bench();
    assert.deepEqual([res.qb.mode, res.qb.blocked, res.baseline], ['blocked', 'needs_oracle', undefined]);
    assert.equal(fs.existsSync(marker), false);
  });
  test('benchmark --explore: an explicit, recorded mode that runs but can never PASS', () => {
    const res = bench(['--explore']);
    assert.equal(res.qb.mode, 'exploration');
    assert.ok(fs.existsSync(marker), 'exploration runs the agent');
    assert.notEqual(res.qb.final_verdict, 'pass');
    assert.notEqual(res.baseline.verdict, 'pass');
  });
});
