/**
 * QB-02 §10 / T-HARNESS — the shipped runner has no host-execution override.
 *
 * QB_AGENT_COMMAND used to replace the agent argv for any process that set
 * it, and NODE_ENV is user-settable, so neither may select what runs. Only
 * an explicitly injected `agentCommand` (test harnesses) can.
 *
 * A stub `claude` on PATH stands in for the default agent, so this test can
 * never launch the real one.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const { runAgentCaptured } = require('../../agent/runner');

test('QB_AGENT_COMMAND and NODE_ENV=test do not change the agent', () => {
  const repo = makeRepo({ 'a.js': '1\n' });
  const tmp  = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-override-'));
  const saved = { PATH: process.env.PATH, QB_AGENT_COMMAND: process.env.QB_AGENT_COMMAND, NODE_ENV: process.env.NODE_ENV };
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    const defaultMarker  = path.join(tmp, 'default-agent-ran');
    const overrideMarker = path.join(tmp, 'override-ran');
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ntouch '${defaultMarker}'\n`, { mode: 0o755 });

    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    process.env.NODE_ENV = 'test';
    process.env.QB_AGENT_COMMAND = JSON.stringify([
      process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(overrideMarker)}, '')`,
    ]);

    const r = runAgentCaptured('task', repo.dir);

    assert.equal(r.status, 'no_change', r.error || '');
    assert.ok(fs.existsSync(defaultMarker), 'the default agent argv was not used');
    assert.ok(!fs.existsSync(overrideMarker), 'QB_AGENT_COMMAND selected a host command');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('an injected agentCommand must be a non-empty string array', () => {
  for (const bad of [[], 'claude', [1], null]) {
    assert.throws(() => runAgentCaptured('task', os.tmpdir(), { agentCommand: bad }), TypeError);
  }
});
