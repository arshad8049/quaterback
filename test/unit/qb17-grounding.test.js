/**
 * QB-17: intent is grounded in the repository before it is finalized.
 * - root (qb.js) and standalone (intent/cli.js) compilation receive the SAME repository survey;
 * - a fully specified "cleaner" request does not trigger a redundant question;
 * - a still-ambiguous answer stays blocked with its unresolved choice; bounded rounds;
 *   a machine-readable handoff state;
 * - explicit requirements, inferred requirements and proposed defaults are distinct, and
 *   defaults are shown and approved, never silently applied;
 * - incomplete compiler output is rejected, never filled with fallback text.
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

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

const REQUEST = 'Add a clamp function to src/utils.js';
const CONTRACT = {
  goal: 'Add a clamp function', required_behavior: ['clamp(n, min, max) returns n bounded to [min, max]'], constraints: [],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp is exported from src/utils.js', requirement_ids: ['R-1'] }],
  requirements: [{ id: 'R-1', quote: REQUEST }], verification_plan: ['run tests'], relevant_context: [], ambiguity_flags: [], clarifying_question: null,
};
const userContent = (body) => JSON.parse(body).messages.find((m) => m.role === 'user').content;

let tmp, repo;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb17-'));
  repo = makeRepo({ 'src/utils.js': '// UTILS_MARKER\nmodule.exports = {};\n', 'README.md': '# demo\n' });
});
afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

function spawnWithLog(script, args, { cwd, reply = CONTRACT, input } = {}) {
  const log = path.join(tmp, `prompts-${path.basename(script)}-${Math.random().toString(36).slice(2)}.ndjson`);
  const r = spawnSync(process.execPath, ['--require', PRELOAD, script, ...args], {
    cwd: cwd || ROOT, encoding: 'utf8', timeout: 30_000, input,
    env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'),
      QB_TEST_OLLAMA_REPLY: JSON.stringify(reply), QB_TEST_PROMPT_LOG: log },
  });
  const prompts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { r, prompts };
}

describe('root and standalone compilation receive equivalent grounding', () => {
  test('qb.js compiles with a repository survey (pre-fix: no repo context at all)', () => {
    const { r, prompts } = spawnWithLog(path.join(ROOT, 'qb.js'), [REQUEST, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify']);
    assert.ok(prompts.length >= 1, r.stdout + r.stderr);
    const u = userContent(prompts[0]);
    assert.match(u, /REPOSITORY SURVEY/);
    assert.match(u, /src\/utils\.js/);
    assert.match(u, /UTILS_MARKER/);
  });
  test('qb.js and intent/cli.js send the same grounded compiler input for the same repo and request', () => {
    const root = spawnWithLog(path.join(ROOT, 'qb.js'), [REQUEST, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify']);
    const cli = spawnWithLog(path.join(ROOT, 'intent', 'cli.js'), [REQUEST, '--repo', repo.dir]);
    assert.ok(cli.prompts.length >= 1, cli.r.stdout + cli.r.stderr);
    assert.equal(userContent(cli.prompts[0]), userContent(root.prompts[0]));
    // without --repo the standalone CLI surveys the working directory, like qb.js's default --repo
    const cwdCli = spawnWithLog(path.join(ROOT, 'intent', 'cli.js'), [REQUEST], { cwd: repo.dir });
    assert.equal(userContent(cwdCli.prompts[0]), userContent(root.prompts[0]));
  });
});

describe('ambiguity rules respect what the request already says', () => {
  const SPECIFIED = 'Make src/dates.js cleaner by extracting the duplicated date parsing in parseDate() and parseRange() into one helper toDate(text) in src/dates.js, with no change to either function\'s return values.';
  test('a fully specified "cleaner" request reaches the compiler instead of a redundant question (pre-fix: DSA asks)', async () => {
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply({ ...CONTRACT, requirements: [{ id: 'R-1', quote: SPECIFIED }] }));
    try {
      const c = await compile(SPECIFIED);
      assert.equal(c.clarifying_question, null);
      assert.equal(m.calls.length, 1);
    } finally { m.restore(); }
  });
  test('the vague request still asks, with machine-readable choices', async () => {
    const { compile } = require('../../intent/compiler');
    const m = mockFetch(ollamaReply(CONTRACT));
    try {
      const c = await compile('Make src/dates.js cleaner');
      assert.match(c.clarifying_question, /What does "cleaner" mean/);
      assert.equal(m.calls.length, 0);
      assert.equal(c.unresolved[0].id, 'cleaner');
      assert.ok(c.unresolved[0].choices.length >= 4);
    } finally { m.restore(); }
  });
});

describe('bounded clarification with a machine-readable handoff state', () => {
  test('a still-ambiguous answer stays blocked with its unresolved choice (pre-fix: any answer skipped the rule)', async () => {
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(CONTRACT));
    try {
      const s = await compileIntent('Make the code cleaner', { repoPath: repo.dir, answers: ['just make it nicer'] });
      assert.equal(s.state, 'needs_clarification');
      assert.equal(s.round, 2);
      assert.equal(s.max_rounds, 3);
      assert.equal(s.unresolved[0].id, 'cleaner');
      assert.ok(s.unresolved[0].choices.includes('extract helper functions'));
      assert.deepEqual(s.history, [{ round: 1, question_id: 'cleaner', question: s.unresolved[0].question, answer: 'just make it nicer' }]);
      assert.equal(m.calls.length, 0, 'never compiled past the open choice');
    } finally { m.restore(); }
  });
  test('after the maximum rounds it is blocked — never finalized', async () => {
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(CONTRACT));
    try {
      const s = await compileIntent('Make the code cleaner', { repoPath: repo.dir, answers: ['nicer', 'you decide', 'cleaner please'] });
      assert.deepEqual([s.state, s.reason, s.round, s.unresolved[0].id], ['blocked', 'clarification_rounds_exhausted', 3, 'cleaner']);
      assert.equal(s.contract, undefined);
    } finally { m.restore(); }
  });
  test('an answer that picks a concrete choice resolves the rule and compilation proceeds, grounded', async () => {
    const { compileIntent } = require('../../intent/session');
    const req = 'Make src/utils.js cleaner';
    const m = mockFetch(ollamaReply({ ...CONTRACT, requirements: [{ id: 'R-1', quote: req }] }));
    try {
      const s = await compileIntent(req, { repoPath: repo.dir, answers: ['extract helper functions from the long ones'] });
      assert.equal(s.state, 'finalized', JSON.stringify(s));
      const u = JSON.parse(m.calls[0].init.body).messages[1].content;
      // re-review 2: the clarification is labelled with its question id and the selected choice
      assert.match(u, /CLARIFICATION 1:\nQ\(cleaner\): What does "cleaner" mean[^\n]*\nA: extract helper functions from the long ones \[selected: extract_helpers\]/);
      assert.match(u, /REPOSITORY SURVEY/);
      assert.equal(s.survey.files_total, 2);
    } finally { m.restore(); }
  });
  test('qb.js: a vague --clarify answer ends BLOCKED needs_clarification with a handoff file naming the open choice', () => {
    const { r } = spawnWithLog(path.join(ROOT, 'qb.js'), ['Make the code cleaner', '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--clarify', 'just make it nicer']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const ids = fs.readdirSync(path.join(tmp, 'runs'));
    const run = store.loadRun(ids[0], path.join(tmp, 'runs'));
    assert.deepEqual([run.manifest.outcome, run.manifest.outcome_reason], ['BLOCKED', 'needs_clarification']);
    const h = JSON.parse(fs.readFileSync(path.join(run.dir, 'clarification.json'), 'utf8'));
    assert.deepEqual([h.state, h.round, h.max_rounds, h.unresolved[0].id], ['needs_clarification', 2, 3, 'cleaner']);
    assert.match(r.stdout, /extract helper functions/);
  });
  test('qb.js: repeated --clarify answers are used round by round; still vague after the last round → BLOCKED', () => {
    const { r } = spawnWithLog(path.join(ROOT, 'qb.js'), ['Make the code cleaner', '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify',
      '--clarify', 'nicer', '--clarify', 'you decide', '--clarify', 'cleaner please']);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const ids = fs.readdirSync(path.join(tmp, 'runs'));
    const run = store.loadRun(ids[0], path.join(tmp, 'runs'));
    assert.deepEqual([run.manifest.outcome, run.manifest.outcome_reason], ['BLOCKED', 'clarification_rounds_exhausted']);
  });
});

describe('explicit, inferred and proposed defaults are distinct; defaults need approval', () => {
  const { contractState, approve, approvalState } = require('../../intent/contract-state');
  const { formatOracle } = require('../../intent/oracle-view');
  const C = (extra = {}) => ({ id: 'c', goal: 'clamp', raw_request: 'Add clamp(n, min, max).', clarifying_question: null,
    requirements: [{ id: 'R-1', quote: 'Add clamp(n, min, max).' }, { id: 'R-2', implied: true, text: 'existing tests keep passing', reason: 'not stated, but required' }],
    proposed_defaults: [{ id: 'D-1', text: 'clamp throws a RangeError when min > max', reason: 'the request does not say what happens when min > max' }],
    acceptance_criteria: [
      { id: 'AC-1', criterion: 'clamp(5, 0, 3) returns 3', requirement_ids: ['R-1'] },
      { id: 'AC-2', criterion: 'existing tests pass', requirement_ids: ['R-2'], preserves: { tests: ['test/dates.test.js'] } },   // QB-15: preservation names its tests
      { id: 'AC-3', criterion: 'clamp(1, 3, 0) throws RangeError', requirement_ids: ['D-1'] }], ...extra });

  test('a criterion may trace to a proposed default; the view shows the three kinds separately (pre-fix: D-1 unknown → invalid)', () => {
    assert.equal(contractState(C()).state, 'finalized', JSON.stringify(contractState(C())));
    const v = formatOracle(C());
    assert.match(v, /Proposed defaults \(not in your request — QB's choice; approving the contract approves them\)/);
    assert.match(v, /D-1 clamp throws a RangeError when min > max → AC-3  \(reason: the request does not say what happens when min > max\)/);
    assert.match(v, /R-2 \(implied\) "existing tests keep passing" → AC-2/);
  });
  test('a default is part of the approved oracle: changing it voids the approval', () => {
    const a = approve(C(), { via: 'test' });
    assert.equal(approvalState(a).approved, true);
    assert.deepEqual(approvalState({ ...a, proposed_defaults: [{ ...a.proposed_defaults[0], text: 'clamp swaps min and max' }] }), { approved: false, reason: 'changed_after_approval' });
  });
  test('malformed defaults are rejected: no reason, bad id, unknown D-id, a default no criterion uses', () => {
    for (const [extra, re] of [
      [{ proposed_defaults: [{ id: 'D-1', text: 'x' }] }, /D-1 has no text or reason/],
      [{ proposed_defaults: [{ id: 'default', text: 'x', reason: 'y' }] }, /proposed default id "default" is missing, malformed or duplicated/],
      [{ acceptance_criteria: [...C().acceptance_criteria.slice(0, 2), { id: 'AC-3', criterion: 'z', requirement_ids: ['D-9'] }] }, /AC-3 names unknown requirement "D-9"/],
      [{ acceptance_criteria: C().acceptance_criteria.slice(0, 2) }, /proposed default D-1 .* is not covered by any acceptance criterion/],
    ]) assert.match((contractState(C(extra)).errors || []).join(' | '), re, JSON.stringify(extra));
  });
});

describe('incomplete compiler output is rejected, never filled', () => {
  test('missing required_behavior / verification_plan → invalid, naming the fields (pre-fix: generic fallback text → finalized)', async () => {
    const { compile } = require('../../intent/compiler');
    const { contractState } = require('../../intent/contract-state');
    const partial = { ...CONTRACT };
    delete partial.required_behavior;
    delete partial.verification_plan;
    const m = mockFetch(ollamaReply(partial));
    try {
      const c = await compile(REQUEST);
      const s = contractState(c);
      assert.equal(s.state, 'invalid');
      assert.match(s.errors.join(' | '), /incomplete compiler output: missing required_behavior, verification_plan/);
      assert.ok(!JSON.stringify(c).includes('Run the existing test suite and verify'), 'no fallback plan text');
    } finally { m.restore(); }
  });
  test('an unreadable list entry is not stringified into the contract', async () => {
    const { compile } = require('../../intent/compiler');
    const { contractState } = require('../../intent/contract-state');
    const m = mockFetch(ollamaReply({ ...CONTRACT, required_behavior: [{ weird: 1 }] }));
    try {
      const c = await compile(REQUEST);
      assert.match(contractState(c).errors.join(' | '), /incomplete compiler output: unreadable required_behavior\[0\]/);
    } finally { m.restore(); }
  });
});

describe('QB-17 re-review: an answer resolves only on an affirmative selection, bound to its question', () => {
  const REQ = 'Make src/dates.js cleaner';
  const UNDECIDED = 'I cannot decide between naming and duplication; please ask me again.';
  const finalReply = (req) => ({ ...CONTRACT, requirements: [{ id: 'R-1', quote: req }] });
  const { detectAmbiguity } = require('../../intent/dsa');

  test('senior repro: "cannot decide between naming and duplication" leaves the choice open (pre-fix: resolved → finalized)', async () => {
    assert.notEqual(detectAmbiguity(REQ, [UNDECIDED]), null);
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(finalReply(REQ)));
    try {
      const s = await compileIntent(REQ, { repoPath: repo.dir, answers: [UNDECIDED] });
      assert.equal(s.state, 'needs_clarification', JSON.stringify(s));
      assert.equal(s.unresolved[0].id, 'cleaner');
      assert.equal(m.calls.length, 0, 'never compiled past the open choice');
    } finally { m.restore(); }
  });
  test('senior repro through the CLI handoffs: qb.js --clarify → BLOCKED (agent never runs); intent/cli.js --clarify → exit 2, needs_clarification', () => {
    const { r } = spawnWithLog(path.join(ROOT, 'qb.js'), [REQ, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--clarify', UNDECIDED], { reply: finalReply(REQ) });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    const run = store.loadRun(fs.readdirSync(path.join(tmp, 'runs'))[0], path.join(tmp, 'runs'));
    assert.deepEqual([run.manifest.outcome, run.manifest.outcome_reason], ['BLOCKED', 'needs_clarification']);
    assert.deepEqual(run.manifest.attempts, [], 'no attempt started: the agent was never invoked');
    const cli = spawnWithLog(path.join(ROOT, 'intent', 'cli.js'), [REQ, '--repo', repo.dir, '--clarify', UNDECIDED], { reply: finalReply(REQ) });
    assert.equal(cli.r.status, 2, cli.r.stdout + cli.r.stderr);
    const h = JSON.parse(cli.r.stdout.slice(cli.r.stdout.indexOf('{'), cli.r.stdout.lastIndexOf('}') + 1));
    assert.deepEqual([h.state, h.unresolved[0].id], ['needs_clarification', 'cleaner']);
    assert.equal(cli.prompts.length, 0);
  });
  test('negated choices, several unselected alternatives and deferrals stay open', () => {
    for (const a of ['not naming', 'no duplication removal', 'naming or duplication', 'either naming or extracting helpers',
      'extract helpers, rename things and shorten functions', 'you choose: naming?', 'maybe naming', 'not sure, perhaps duplication']) {
      assert.notEqual(detectAmbiguity(REQ, [a]), null, a);
    }
  });
  test('positive guards: a structured selection and a single affirmative free-text choice resolve it', async () => {
    assert.equal(detectAmbiguity(REQ, ['cleaner=improve_naming']), null);
    assert.equal(detectAmbiguity(REQ, [{ question: 'cleaner', choice: 'remove_duplication' }]), null);
    assert.equal(detectAmbiguity(REQ, ['remove the duplicated parsing']), null);
    assert.notEqual(detectAmbiguity(REQ, ['cleaner=not_a_choice']), null, 'unknown choice id');
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(finalReply(REQ)));
    try {
      const s = await compileIntent(REQ, { repoPath: repo.dir, answers: ['cleaner=extract_helpers'] });
      assert.equal(s.state, 'finalized', JSON.stringify(s));
    } finally { m.restore(); }
    const ok = spawnWithLog(path.join(ROOT, 'qb.js'), [REQ, '--repo', repo.dir, '--agent', 'dry-run', '--no-llm-context', '--no-llm-verify', '--clarify', 'cleaner=improve_naming'], { reply: finalReply(REQ) });
    assert.ok(ok.prompts.length >= 1, ok.r.stdout + ok.r.stderr);
  });
  test('the handoff lists stable choice ids for structured selection', async () => {
    const { compileIntent } = require('../../intent/session');
    const s = await compileIntent(REQ, { repoPath: repo.dir, answers: [] });
    assert.deepEqual(s.unresolved[0].options.map((o) => o.id), ['reduce_function_length', 'improve_naming', 'extract_helpers', 'remove_duplication']);
  });
  test('each answer is bound to its question: answering one vague term never resolves another', async () => {
    const two = 'Make src/dates.js cleaner and more readable';
    const { compileIntent } = require('../../intent/session');
    const m = mockFetch(ollamaReply(finalReply(two)));
    try {
      const s = await compileIntent(two, { repoPath: repo.dir, answers: ['remove duplication'] });
      assert.equal(s.state, 'needs_clarification', JSON.stringify(s));
      assert.deepEqual(s.unresolved.map((u) => u.id), ['more_quality']);
      assert.deepEqual(s.history.map((h) => h.question_id), ['cleaner']);
      const both = await compileIntent(two, { repoPath: repo.dir, answers: ['remove duplication', 'more_quality=split_long_functions'] });
      assert.equal(both.state, 'finalized', JSON.stringify(both));
      // a structured selection names its own question, whatever was asked first
      const named = await compileIntent(two, { repoPath: repo.dir, answers: ['more_quality=remove_duplication'] });
      assert.deepEqual([named.state, named.unresolved.map((u) => u.id)], ['needs_clarification', ['cleaner']]);
    } finally { m.restore(); }
  });
});
