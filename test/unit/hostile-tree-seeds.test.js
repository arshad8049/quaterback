/**
 * Hostile output tree (QB-02 review item 4; QB-03).
 *
 * The two reproduced attacks — an agent-written core.fsmonitor, and a clean
 * filter + .gitattributes — executed on the host because agent/capture.js ran
 * git against the agent's own repository. That module is gone: capture now runs
 * in the trusted capture container with a trusted GIT_DIR and never reads the
 * agent's .git (agent-sandbox.md §6).
 *
 * The attacks themselves are executed against the real capture path in
 * test/integration/qb02-sandbox-capture.test.js ("QB-03 attacks: …"), which needs
 * Docker. This unit test guards the structural fix: no shipped code runs git on
 * the host against a workspace, and capture's git uses only trusted config.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

test('the host-side capture that executed agent git config no longer exists', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'agent', 'capture.js')), false);
});

test('capture uses only trusted git configuration and never the agent .git', () => {
  const env = fs.readFileSync(path.join(ROOT, 'sandbox', 'scripts', 'git-env.sh'), 'utf8');
  for (const needle of ['GIT_CONFIG_NOSYSTEM=1', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_DIR=/git/repo',
    'core.fsmonitor=false', 'core.hooksPath=/dev/null', 'core.attributesFile=/dev/null', 'GIT_ATTR_SOURCE']) {
    assert.ok(env.includes(needle), `git-env.sh is missing ${needle}`);
  }
  const capture = fs.readFileSync(path.join(ROOT, 'sandbox', 'scripts', 'capture.sh'), 'utf8');
  assert.match(capture, /--exclude \.git/);
  const code = capture.replace(/^\s*#.*$/gm, '');          // executable lines only
  assert.doesNotMatch(code, /\/work\/\.git/, 'capture must not reference the agent repository');
  assert.doesNotMatch(code, /git -C \/work|GIT_DIR=\/work/);
});

test('the integration regression for both attacks exists', () => {
  const t = fs.readFileSync(path.join(ROOT, 'test', 'integration', 'qb02-sandbox-capture.test.js'), 'utf8');
  assert.match(t, /QB-03 attacks: agent-written fsmonitor and clean filter never execute during capture/);
  assert.match(t, /fsmonitor = touch/);
  assert.match(t, /clean = touch/);
});
