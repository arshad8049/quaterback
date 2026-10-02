/**
 * Hostile output tree (QB-02 review item 4, reopens QB-03).
 *
 * After the agent exits, the workspace — including its .git/ — is untrusted
 * input. Host-side capture currently runs git against the agent's own repo
 * config, so an agent-written core.fsmonitor or clean filter executes on
 * the host. Seeded as `todo` until capture moves to a trusted GIT_DIR /
 * capture container (agent-sandbox.md v2 §6).
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const capture = require('../../agent/capture');

const ATTACKS = {
  'core.fsmonitor': { config: '[core]\n\tfsmonitor = touch PWNED_FSMONITOR\n' },
  'clean filter':   { config: '[filter "x"]\n\tclean = touch PWNED_FILTER; cat\n', attributes: '*.js filter=x\n' },
};

for (const [name, attack] of Object.entries(ATTACKS)) {
  test(`agent-written ${name} does not execute during capture`, { todo: 'QB-02 v2 §6 / QB-03 reopened' }, () => {
    const repo = makeRepo({ 'a.js': '1\n' });
    try {
      fs.appendFileSync(path.join(repo.dir, '.git', 'config'), attack.config);
      if (attack.attributes) fs.writeFileSync(path.join(repo.dir, '.gitattributes'), attack.attributes);
      repo.write('a.js', '2\n');
      try { capture.snapshot(repo.dir); } catch (_) {}
      assert.deepEqual(fs.readdirSync(repo.dir).filter(f => f.startsWith('PWNED')), []);
    } finally {
      repo.cleanup();
    }
  });
}
