/**
 * Known false-PASS reproductions from the engineering review (p.32, Recipes A-C).
 *
 * These are Phase 2 tickets. They are seeded now, marked `todo`, so the
 * suite reports them without failing CI. When the Phase 2 fix lands, drop
 * the `todo` option — the assertion is already the post-fix behaviour.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');

const { mockFetch, ollamaReply } = require('../helpers/mocks');
const { makeRepo } = require('../helpers/tmprepo');

const AFFIRMATIVE = ollamaReply({ met: true, evidence: 'looks implemented', repair: null });

test('QB-08 Recipe A: clarification-only contract never reaches PASS', async () => {
  const { verify } = require('../../verify/verifier');
  const r = await verify(
    { id: 'probe', clarifying_question: 'Which behavior?' },
    null,
    { id: 'probe-run', diff: 'diff --git a/x b/x\n+x' },
    { repoPath: null },
  );
  assert.notEqual(r.verdict, 'pass');
});

test('QB-07 Recipe B: negative prose is never parsed as a positive vote', async () => {
  const fetchMock = mockFetch(ollamaReply('The criterion is not implemented.'));
  try {
    const { judgeAll } = require('../../verify/judge');
    const [r] = await judgeAll(
      [{ id: 'AC-1', criterion: 'targetFunction exists' }],
      'diff --git a/x b/x\n+// fixture',
      {},
    );
    assert.notEqual(r.met, true);
    assert.ok(!r.votes.includes(true), `votes were ${JSON.stringify(r.votes)}`);
  } finally {
    fetchMock.restore();
  }
});

test('QB-06 Recipe C: test command exiting 2 cannot produce PASS', { todo: 'Phase 2 — QB-06' }, async () => {
  const repo = makeRepo({
    'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(2)"' } }),
  });
  const fetchMock = mockFetch(AFFIRMATIVE);
  try {
    const { verify } = require('../../verify/verifier');
    const contract = {
      id: 'c1',
      acceptance_criteria: [{ id: 'AC-1', criterion: 'add() is defined', met: null }],
    };
    const context = { patterns: { test_runner: 'node-test' }, relevant_files: [] };
    const r = await verify(contract, context, { id: 'e1', diff: 'diff --git a/a.js b/a.js\n+function add() {}' }, { repoPath: repo.dir });
    assert.notEqual(r.verdict, 'pass');
  } finally {
    fetchMock.restore();
    repo.cleanup();
  }
});
