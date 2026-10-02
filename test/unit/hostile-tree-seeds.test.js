/**
 * Hostile output tree (QB-02 review item 4, reopens QB-03).
 *
 * After the agent exits, the workspace — including its .git/ — is untrusted
 * input. Host-side capture currently runs git against the agent's own repo
 * config, so an agent-written core.fsmonitor or clean filter executes on
 * the host.
 *
 * Each attack has two tests:
 *   - KNOWN DEFECT: an executable reproduction. It passes while the attack
 *     still executes, and reports it as a demonstrated defect. It is not a
 *     security regression and must never be read as one.
 *   - The security regression: `todo` until capture moves to a trusted
 *     GIT_DIR in a capture container (agent-sandbox.md §6). QB-03 cannot
 *     close until it passes un-todo'd.
 *
 * When the fix lands, the KNOWN DEFECT tests fail on purpose: delete them
 * and remove `todo` from the regressions.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const capture = require('../../agent/capture');

// Each payload only creates a marker file inside the throwaway test repo.
const ATTACKS = {
  'core.fsmonitor': { config: '[core]\n\tfsmonitor = touch PWNED_FSMONITOR\n' },
  'clean filter':   { config: '[filter "x"]\n\tclean = touch PWNED_FILTER; cat\n', attributes: '*.js filter=x\n' },
};

/** Plant the attack in a fresh repo, run host-side capture, return the markers it left. */
function captureHostileTree(attack) {
  const repo = makeRepo({ 'a.js': '1\n' });
  try {
    fs.appendFileSync(path.join(repo.dir, '.git', 'config'), attack.config);
    if (attack.attributes) fs.writeFileSync(path.join(repo.dir, '.gitattributes'), attack.attributes);
    repo.write('a.js', '2\n');
    try { capture.snapshot(repo.dir); } catch (_) {}
    return fs.readdirSync(repo.dir).filter(f => f.startsWith('PWNED'));
  } finally {
    repo.cleanup();
  }
}

for (const [name, attack] of Object.entries(ATTACKS)) {
  test(`KNOWN DEFECT (QB-03 open): agent-written ${name} executes on the host during capture`, (t) => {
    const markers = captureHostileTree(attack);
    assert.notDeepEqual(markers, [],
      `${name} no longer executes during capture. If §6 capture has landed, delete this ` +
      'reproduction and remove `todo` from the matching security regression.');
    t.diagnostic(`DEMONSTRATED DEFECT: ${name} payload ran on the host (${markers.join(', ')})`);
  });

  test(`agent-written ${name} does not execute during capture`, { todo: 'QB-03 open: demonstrated defect, fixed by agent-sandbox.md §6' }, () => {
    assert.deepEqual(captureHostileTree(attack), []);
  });
}
