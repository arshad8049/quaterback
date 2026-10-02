/**
 * QB-01 — repository filenames must never be executed as shell syntax.
 *
 * Done when: a filename containing shell metacharacters is treated as a
 * literal path; no marker is created. Spaces, quotes, newlines and leading
 * hyphens are handled without command execution.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const { makeRepo } = require('../helpers/tmprepo');
const { buildGitContext } = require('../../context/git');

const HOSTILE = [
  '$(touch PWNED_SUBST)',
  '`touch PWNED_BACKTICK`',
  'a"; touch PWNED_QUOTE; echo "b',
  "it's.js",
  'with space.js',
  '-rf',
  '--output=PWNED_FLAG',
  'line\nbreak.js',
];

test('git context treats hostile filenames as literal paths', () => {
  const files = Object.fromEntries(HOSTILE.map(f => [f, 'x\n']));
  const repo = makeRepo(files);
  try {
    const ctx = buildGitContext(repo.dir, HOSTILE);

    const markers = fs.readdirSync(repo.dir).filter(f => f.startsWith('PWNED') && !HOSTILE.includes(f));
    assert.deepEqual(markers, [], `shell executed: created ${markers.join(', ')}`);
    assert.ok(!fs.existsSync(path.join(process.cwd(), 'PWNED_SUBST')));

    // Every file was committed once, so each must still report its activity.
    const reported = ctx.recent_changes.map(c => c.file).sort();
    assert.deepEqual(reported, [...HOSTILE].sort());
    for (const c of ctx.recent_changes) assert.equal(c.commits, 1);
  } finally {
    repo.cleanup();
  }
});

test('paths outside the repository are rejected, not queried', () => {
  const repo = makeRepo({ 'a.js': 'x\n' });
  try {
    const ctx = buildGitContext(repo.dir, ['../../etc/passwd', '/etc/passwd', 'a.js']);
    assert.deepEqual(ctx.recent_changes.map(c => c.file), ['a.js']);
  } finally {
    repo.cleanup();
  }
});
