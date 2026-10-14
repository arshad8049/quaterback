/**
 * KAN-66: the local compiler model (deepseek-r1:7b) writes valid `checks`, then repeats them
 * as check-shaped OBJECTS in `verification_plan` (a list of strings). QB-17 reported each one
 * as "unreadable", so every contract for the request below was invalid and nothing ran
 * (6 of 6 real attempts, 2026-10-14). The fixture is the model's captured output, unedited.
 *
 * A step of exactly the demonstrated shape — a call_returns check with module, export, args and
 * expect and nothing else — is now rendered as text from its own fields, for the human to approve
 * with the rest of the contract. Nothing is invented or left unseen: every other shape (the other
 * adapters, extra or malformed fields) is still unreadable, and the contract still fails closed on
 * everything else. Re-review (comment 10302): scoped to call_returns; the other adapters carry
 * fields (constructor setup, optional message) that a short rendering could hide.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');

const ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');
const REQUEST = 'In src/duration.js, formatDuration(30000) should return "30s" instead of "0m 30s"; formatDuration(90000) should still return "1m 30s".';
const CAPTURED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'kan66', 'deepseek-r1-7b-output.json'), 'utf8'));
const copy = (o) => JSON.parse(JSON.stringify(o));
/**
 * The captured output with its two OTHER defects repaired, both still rejected by QB as they
 * should be: an invented enforcement kind (made advisory) and requirement quotes with " turned
 * into ' that left parts of the request untraced (QB-14; here one requirement quotes it whole).
 */
const VALID_POLICY = () => {
  const c = { ...copy(CAPTURED), constraint_policy: [{ constraint: 0, advisory: true }], requirements: [{ id: 'R-1', quote: REQUEST }] };
  for (const ac of c.acceptance_criteria) ac.requirement_ids = ['R-1'];
  return c;
};

async function compiled(reply) {
  const { compile } = require('../../intent/compiler');
  const { contractState } = require('../../intent/contract-state');
  const m = mockFetch(ollamaReply(reply));
  try {
    const c = await compile(REQUEST);
    return { c, s: contractState(c) };
  } finally { m.restore(); }
}

describe('KAN-66: check-shaped verification_plan steps are read, not rejected', () => {
  test('the captured model output: the plan is rendered from each step\'s own fields (pre-fix: unreadable verification_plan[0], [1])', async () => {
    const { c, s } = await compiled(copy(CAPTURED));
    assert.deepEqual(c.verification_plan, [
      'call_returns: formatDuration(30000) from src/duration.js returns "30s"',
      'call_returns: formatDuration(90000) from src/duration.js returns "1m 30s"',
    ]);
    const errors = (s.errors || []).join(' | ');
    assert.doesNotMatch(errors, /verification_plan/);
    // Still fail closed on the output's OTHER defect: an enforcement kind the model invented.
    assert.equal(s.state, 'invalid');
    assert.match(errors, /constraint 0 has an unknown enforcement/);
  });

  test('with that defect absent, the same output is a finalized contract whose checks are unchanged', async () => {
    const { c, s } = await compiled(VALID_POLICY());
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
    assert.deepEqual(c.checks.map((k) => [k.id, k.ac_id, k.adapter, k.params.args[0], k.params.expect]),
      [['CHK-1', 'AC-1', 'call_returns', 30000, '30s'], ['CHK-2', 'AC-2', 'call_returns', 90000, '1m 30s']]);
  });

  test('only call_returns is read: the other adapters stay unreadable, whatever their fields (re-review 10302)', async () => {
    const ctor = (args) => ({ adapter: 'call_sequence', params: { module: 'src/vad.js', export: 'VAD', instances: { a: { construct: 'new', args } },
      steps: [{ on: 'a', method: 'onSpeech', args: [300] }, { on: 'a', method: 'stats', args: [], expect: { n: 1 } }] } });
    for (const [bad, label] of [
      [{ adapter: 'module_exports', params: { module: 'src/a.js', export: 'f', type: 'function' } }, 'module_exports'],
      [{ adapter: 'call_throws', params: { module: 'src/a.js', export: 'f', args: [-1], message_includes: 'negative' } }, 'call_throws'],
      [{ adapter: 'call_throws', params: { module: 'src/a.js', export: 'f', args: [-1], message_includes: 123 } }, 'call_throws, non-string message_includes'],
      [ctor([]), 'call_sequence, new VAD()'],
      [ctor([16000]), 'call_sequence, new VAD(16000): would have rendered the same text as new VAD()'],
      [{ adapter: 'call_sequence', params: { module: 'src/vad.js', export: 'VAD', steps: [{ on: 'a', method: 'stats', args: [] }] } }, 'call_sequence, no instances'],
    ]) {
      const { s } = await compiled({ ...VALID_POLICY(), verification_plan: [bad] });
      assert.equal(s.state, 'invalid', label);
      assert.match(s.errors.join(' | '), /unreadable verification_plan\[0\]/, label);
    }
  });

  test('a call_returns step with any field the text would not show, or a malformed one, stays unreadable', async () => {
    const ok = { plan_item: 0, adapter: 'call_returns', params: { module: 'src/duration.js', export: 'formatDuration', args: [30000], expect: '30s' } };
    const { c } = await compiled({ ...VALID_POLICY(), verification_plan: [ok] });
    assert.deepEqual(c.verification_plan, ['call_returns: formatDuration(30000) from src/duration.js returns "30s"'], 'control');
    for (const [bad, label] of [
      [{ ...ok, params: { ...ok.params, timeout_ms: 5 } }, 'extra param'],
      [{ ...ok, note: 'x' }, 'extra step field'],
      [{ ...ok, params: { module: ok.params.module, export: ok.params.export, args: [30000] } }, 'no expect'],
      [{ ...ok, plan_item: '0' }, 'plan_item not an integer'],
      [{ ...ok, plan_item: -1 }, 'negative plan_item'],
      [{ ...ok, ac_id: 1 }, 'ac_id not a string'],
      [{ ...ok, params: { ...ok.params, export: '' } }, 'empty export'],
    ]) {
      const { s } = await compiled({ ...VALID_POLICY(), verification_plan: [bad] });
      assert.equal(s.state, 'invalid', label);
      assert.match(s.errors.join(' | '), /unreadable verification_plan\[0\]/, label);
    }
  });

  test('re-review 10308: a malformed check with a text field does not fall back to that text; text-shaped objects still read', async () => {
    const ok = { plan_item: 0, adapter: 'call_returns', params: { module: 'src/duration.js', export: 'formatDuration', args: [30000], expect: '30s' } };
    for (const [bad, label] of [
      [{ ...ok, description: 'Run the check', params: { ...ok.params, timeout_ms: 123 } }, 'reviewer repro: description + extra timeout_ms (pre-fix: plan "Run the check", finalized)'],
      [{ ...ok, text: 'Run the check', params: { module: ok.params.module, export: ok.params.export, args: [30000] } }, 'text + missing expect'],
      [{ adapter: 'call_throws', params: { module: 'src/a.js', export: 'f', args: [] }, step: 'f throws' }, 'other adapter + step'],
      [{ params: ok.params, description: 'Run the check' }, 'params without adapter + description'],
      [{ adapter: 'call_returns', description: 'Run the check' }, 'adapter without params + description'],
    ]) {
      const { c, s } = await compiled({ ...VALID_POLICY(), verification_plan: [bad] });
      assert.equal(s.state, 'invalid', label);
      assert.match(s.errors.join(' | '), /unreadable verification_plan\[0\]/, label);
      assert.ok(!(c.verification_plan || []).some((p) => /Run the check|f throws/.test(p)), label);
    }
    // control: an ordinary text-shaped object (no adapter/params) is read as before (QB-17)
    const { c, s } = await compiled({ ...VALID_POLICY(), verification_plan: [{ text: 'Run the test suite' }, { description: 'Call formatDuration(90000)' }] });
    assert.deepEqual(c.verification_plan, ['Run the test suite', 'Call formatDuration(90000)']);
    assert.equal(s.state, 'finalized', JSON.stringify(s.errors));
  });

  test('anything else stays unreadable and the contract invalid: unknown adapter, missing params, bare plan index, wrong field types', async () => {
    for (const [bad, label] of [
      [{ adapter: 'shell', params: { cmd: 'rm -rf /' } }, 'unknown adapter'],
      [{ plan_item: 0, adapter: 'call_returns' }, 'no params'],
      [{ plan_item: 0 }, 'bare plan index'],
      [{ adapter: 'call_returns', params: { module: 'src/duration.js', export: 'formatDuration', args: 30000, expect: '30s' } }, 'args not a list'],
      [{ adapter: 'call_returns', params: { module: 7, export: 'f', args: [], expect: 1 } }, 'module not a string'],
    ]) {
      const { c, s } = await compiled({ ...VALID_POLICY(), verification_plan: [bad] });
      assert.equal(s.state, 'invalid', label);
      assert.match(s.errors.join(' | '), /incomplete compiler output: unreadable verification_plan\[0\]; missing verification_plan/, label);
      assert.ok(!JSON.stringify(c.verification_plan || []).includes('rm -rf'), label);
    }
  });
});

describe('KAN-66 through qb.js: the captured output reaches the approval step', () => {
  let tmp, repo;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kan66-'));
    repo = makeRepo({ 'src/duration.js': 'module.exports = { formatDuration: (ms) => `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s` };\n' });
  });
  afterEach(() => { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); });

  test('non-interactive run stops for human approval and writes the rendered plan (pre-fix: "unusable contract", nothing to approve)', () => {
    const r = spawnSync(process.execPath, ['--require', PRELOAD, 'qb.js', REQUEST, '--repo', repo.dir, '--agent', 'claude-code'], {
      cwd: ROOT, encoding: 'utf8', timeout: 60_000, input: '',
      env: { ...process.env, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: JSON.stringify(VALID_POLICY()) },
    });
    const out = r.stdout + r.stderr;
    assert.doesNotMatch(out, /unusable contract/, out);
    assert.match(out, /needs a human's approval/, out);
    const file = out.match(/Review \(and edit if needed\): (\S+)/)[1];
    const proposed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(proposed.verification_plan, [
      'call_returns: formatDuration(30000) from src/duration.js returns "30s"',
      'call_returns: formatDuration(90000) from src/duration.js returns "1m 30s"',
    ]);
  });
});
