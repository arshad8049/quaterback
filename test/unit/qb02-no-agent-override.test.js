/**
 * QB-02 §10 / T-HARNESS — the shipped code has no host-execution path for the
 * coding agent, and nothing a user can set selects one.
 *
 * The agent runs only through lib/sandbox/pipeline (Docker). The runner does not
 * start processes, does not read QB_AGENT_COMMAND or NODE_ENV, and the old
 * host-side capture module is gone. Tests substitute the pipeline through a
 * function parameter (`runSandboxed`), never through the environment.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { approve } = require('../../intent/contract-state');   // a human-approved oracle (QB-13)
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHIPPED = ['qb.js', 'agent', 'bench', 'verify', 'lib', 'run', 'intent', 'context', 'memory'];
const SKIP = new Set(['node_modules', 'fixtures', 'results', 'sandbox']);

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (p.endsWith('.js')) out.push(p); return out; }
  for (const n of fs.readdirSync(p)) if (!SKIP.has(n)) walk(path.join(p, n), out);
  return out;
}
const shippedFiles = () => SHIPPED.flatMap((d) => walk(path.join(ROOT, d)));

test('the runner starts no processes and has no command override', () => {
  const src = read('agent/runner.js');
  assert.doesNotMatch(src, /require\(['"](\.\.\/lib\/proc|child_process)['"]\)/);
  assert.doesNotMatch(src, /QB_AGENT_COMMAND|NODE_ENV|agentCommand/);
  assert.match(src, /require\('\.\.\/lib\/sandbox\/pipeline'\)/);
});

test('no shipped code reads QB_AGENT_COMMAND', () => {
  const hits = shippedFiles().filter((f) => fs.readFileSync(f, 'utf8').includes('QB_AGENT_COMMAND'));
  assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
});

test('the host-side capture module is gone and nothing imports it', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'agent', 'capture.js')), false);
  const hits = shippedFiles().filter((f) => /require\(['"][./]*(agent\/)?capture['"]\)/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map((f) => path.relative(ROOT, f)), []);
});

test('the verifier never runs repository tests on the host', () => {
  const src = read('verify/checker.js');
  assert.doesNotMatch(src, /require\(['"](\.\.\/lib\/proc|child_process)['"]\)/);
  assert.match(src, /sandbox\?\.verification/);
});

test('with the pipeline injected, claude-code goes through it (and only it)', async () => {
  const { execute } = require('../../agent/runner');
  let calls = 0;
  const r = await execute('brief', approve({ id: 'c', goal: 'g', acceptance_criteria: [{ id: 'AC-1', criterion: 'c' }] }, { via: 'test' }), null, {
    agent: 'claude-code', repoPath: '/nonexistent',
    runSandboxed: async (o) => { calls++; assert.equal(o.repoPath, '/nonexistent'); return { status: 'no_change', sandbox: { run_id: 'x' } }; },
  });
  assert.equal(calls, 1);
  assert.equal(r.status, 'no_change');
});
