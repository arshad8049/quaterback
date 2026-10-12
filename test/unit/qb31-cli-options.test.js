/**
 * QB-31: unsupported agents and invalid options fail BEFORE any model execution.
 *   - the agent must be a registered adapter (qb-agent-adapter/1); a known-but-unsupported
 *     agent (Cursor, Codex, Gemini) is named as not supported yet;
 *   - --max-retries is a whole number 1..10 (pre-fix: 'abc' and '0' silently became 3, '-1' ran);
 *   - --deadline is a positive number of minutes (pre-fix: 'abc' was silently ignored);
 *   - --repo must be a git work tree, --contract-file must exist, --telemetry needs a token.
 * The CLI cases run qb.js end to end with the network stubbed and logged: zero model calls,
 * zero run records, exit code 2.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proc = require('../../lib/proc');
const { makeRepo } = require('../helpers/tmprepo');
const { validateRunOptions } = require('../../lib/run-options');
const A = require('../../agent/adapters');

const QB = path.join(__dirname, '..', '..', 'qb.js');
const PRELOAD = path.join(__dirname, '..', 'helpers', 'preload-ollama.js');

describe('QB-31: the agent adapter registry', () => {
  test('is versioned and lists exactly the implemented adapters', () => {
    assert.equal(A.ADAPTER_INTERFACE, 'qb-agent-adapter/1');
    assert.deepEqual(Object.keys(A.ADAPTERS).sort(), ['claude-code', 'dry-run', 'manual']);
    assert.equal(A.ADAPTERS['claude-code'].support, 'supported');
    for (const id of ['cursor', 'codex', 'gemini']) assert.match(A.adapterProblem(id), /not supported yet/);
    assert.match(A.adapterProblem('vim'), /unknown agent "vim"/);
    assert.equal(A.adapterProblem('claude-code'), null);
  });
  test('the execution schema accepts exactly the registered adapters', () => {
    const { ExecutionResultSchema } = require('../../agent/schema');
    assert.deepEqual([...ExecutionResultSchema.shape.agent_used.options].sort(), Object.keys(A.ADAPTERS).sort());
  });
});

describe('QB-31: run options are validated up front', () => {
  let repo;
  const ok = () => ({ repo: repo.dir, agent: 'dry-run', maxRetries: '3', clarify: [] });
  test('setup', () => { repo = makeRepo({ 'a.js': '1\n' }); });
  test('valid options pass and are normalized', () => {
    const r = validateRunOptions(ok(), 'do x');
    assert.deepEqual(r.errors, []);
    assert.equal(r.maxRetries, 3);
    assert.equal(r.deadlineMs, 0);
    assert.equal(validateRunOptions({ ...ok(), deadline: '1.5' }, 'x').deadlineMs, 90_000);
  });
  for (const [label, patch, re] of [
    ['an unsupported agent', { agent: 'cursor' }, /--agent: "cursor" is not supported yet.*supported: claude-code, dry-run, manual/],
    ['an unknown agent', { agent: 'vim' }, /--agent: unknown agent "vim"/],
    ['non-numeric retries', { maxRetries: 'abc' }, /--max-retries must be a whole number from 1 to 10/],
    ['zero retries', { maxRetries: '0' }, /--max-retries/],
    ['negative retries', { maxRetries: '-1' }, /--max-retries/],
    ['fractional retries', { maxRetries: '2.5' }, /--max-retries/],
    ['too many retries', { maxRetries: '11' }, /--max-retries/],
    ['a non-numeric deadline', { deadline: 'abc' }, /--deadline must be a positive number of minutes/],
    ['a zero deadline', { deadline: '0' }, /--deadline/],
    ['a missing repo', { repo: '/nonexistent/qb31' }, /--repo .* does not exist/],
    ['a missing contract file', { contractFile: '/nonexistent/c.json' }, /--contract-file .* does not exist/],
    ['telemetry without a token', { telemetry: true }, /--telemetry needs a telemetry token/],
  ]) {
    test(`${label} is refused`, () => {
      const saved = process.env.QB_TELEMETRY_TOKEN; delete process.env.QB_TELEMETRY_TOKEN;
      try { assert.match(validateRunOptions({ ...ok(), ...patch }, 'x').errors.join('\n'), re); }
      finally { if (saved !== undefined) process.env.QB_TELEMETRY_TOKEN = saved; }
    });
  }
  test('claude-code needs a git work tree; dry-run and manual work in any directory, as before', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-nogit-'));
    try {
      assert.match(validateRunOptions({ ...ok(), repo: d, agent: 'claude-code' }, 'x').errors.join('\n'), /--repo .* is not a git work tree; --agent claude-code needs one/);
      for (const agent of ['dry-run', 'manual']) assert.deepEqual(validateRunOptions({ ...ok(), repo: d, agent }, 'x').errors, []);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
  test('an empty request is refused', () => assert.match(validateRunOptions(ok(), '   ').errors.join('\n'), /request is empty/));
  test('every problem is reported at once', () => assert.equal(validateRunOptions({ ...ok(), agent: 'cursor', maxRetries: 'x', deadline: '-2' }, 'x').errors.length, 3));
  test('cleanup', () => repo.cleanup());
});

describe('QB-31: qb.js refuses before any model call', () => {
  for (const [label, args] of [
    ['--agent cursor', ['--agent', 'cursor']],
    ['--max-retries abc', ['--max-retries', 'abc']],
    ['--max-retries 0', ['--max-retries', '0']],
    ['--deadline abc', ['--deadline', 'abc']],
  ]) {
    test(`${label}: exit 2, no model call, no run record (pre-fix: the intent model was called)`, () => {
      const repo = makeRepo({ 'a.js': '1\n' });
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qb31-cli-'));
      try {
        const log = path.join(tmp, 'fetch.log');
        const r = proc.run(process.execPath, ['--require', PRELOAD, QB, 'Add a clamp function', '--repo', repo.dir, '--no-llm-context', '--no-llm-verify', ...args], {
          env: { ...process.env, QB_TEST_FETCH_LOG: log, QB_RUNS_DIR: path.join(tmp, 'runs'), QB_MEMORY_DIR: path.join(tmp, 'mem'), QB_TEST_OLLAMA_REPLY: '{}' },
          encoding: 'utf8', timeout: 30_000,
        });
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.equal(fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', '', 'a model call was made');
        assert.equal(fs.existsSync(path.join(tmp, 'runs')) ? fs.readdirSync(path.join(tmp, 'runs')).length : 0, 0, 'a run record was created');
        assert.match(r.stderr, /qb: invalid options/);
      } finally { repo.cleanup(); fs.rmSync(tmp, { recursive: true, force: true }); }
    });
  }
});
