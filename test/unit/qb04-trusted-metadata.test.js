/**
 * QB-04 — model output must not overwrite trusted contract metadata.
 *
 * Done when: injected id, repo_path, created_at and raw_request values cannot
 * override application metadata, and traversal identifiers cannot write
 * outside the designated directory.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const os       = require('os');
const path     = require('path');

const { mockFetch, ollamaReply } = require('../helpers/mocks');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HOSTILE_CONTRACT = {
  id:          '../../model-chosen-location',
  created_at:  '1999-01-01T00:00:00.000Z',
  raw_request: 'something the user never asked for',
  repo_path:   '/',
  goal:        'Add clamp',
  required_behavior:   ['clamp bounds n'],
  constraints:         [],
  acceptance_criteria: [{ id: 'AC-1', criterion: 'clamp exists', met: true }],
  verification_plan:   ['run tests'],
  relevant_context:    [],
  ambiguity_flags:     [],
  clarifying_question: null,
  run_shell:           'rm -rf /',
};

test('compiler keeps trusted metadata and drops unknown model fields', async () => {
  const fetchMock = mockFetch(ollamaReply(HOSTILE_CONTRACT));
  try {
    const { compile } = require('../../intent/compiler');
    const before = Date.now();
    const c = await compile('Add a clamp function');

    assert.match(c.id, UUID_RE);
    assert.equal(c.raw_request, 'Add a clamp function');
    assert.equal(c.repo_path, null);
    assert.ok(Date.parse(c.created_at) >= before - 1000, `created_at taken from model: ${c.created_at}`);
    assert.equal(c.run_shell, undefined);
    assert.equal(c.acceptance_criteria[0].met, null, 'model cannot pre-mark criteria as met');
    assert.equal(c.goal, 'Add clamp');
  } finally {
    fetchMock.restore();
  }
});

test('artifact paths cannot escape their directory', () => {
  const { artifactFile } = require('../../lib/fsafe');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-art-'));
  try {
    for (const bad of ['../../model-chosen-location', '../x', '/etc/passwd', 'a/b', '', '..']) {
      assert.throws(() => artifactFile(root, bad), /Invalid artifact id/, bad);
    }
    const ok = artifactFile(root, '0586ee63-3858-426e-ae40-20bfc8794ccb_attempt1');
    assert.equal(path.dirname(ok), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
