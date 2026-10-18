/**
 * QB-29 re-review 2 in real Docker (QB_INTEGRATION=1): while an image binding is active,
 * containers launch from the pinned immutable image id, and a created container whose image
 * is not pinned is removed before its workload runs.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const D = require('../../lib/sandbox/docker');
const { AGENT_IMAGE, ensureAgentImage } = require('../../lib/sandbox/agent');

const ENABLED = process.env.QB_INTEGRATION === '1';
const TAG = `qb-test-pin:${process.pid}`;
const OTHER = 'busybox:1.36.1';
const HARD = ['--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '10001:10001'];

describe('QB-29: launches are bound to the pinned image identity', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  let pinnedId;
  before(async () => {
    await ensureAgentImage();
    assert.ok((await D.op(['pull', '-q', OTHER], { timeoutMs: 120_000 })).ok);
    pinnedId = (await D.op(['image', 'inspect', '-f', '{{.Id}}', AGENT_IMAGE])).stdout.trim();
    assert.ok((await D.op(['tag', AGENT_IMAGE, TAG])).ok);
  });
  after(async () => { await D.op(['rmi', TAG]); });

  test('a tag retagged after validation still launches the pinned image (the workload runs the original)', async () => {
    const release = D.bindImages({ [TAG]: pinnedId });
    let launched;
    try {
      assert.ok((await D.op(['tag', OTHER, TAG])).ok);          // retag between validation and launch
      const st = await D.runStage(`qb29-bound-${process.pid}`, [...HARD, TAG, 'node', '-e', 'console.log("node " + process.version)']);
      assert.equal(st.state, 'completed', st.stderr);
      assert.match(st.stdout, /^node v\d+/, 'the retagged (busybox) image ran instead of the pinned one');
      const r = await D.op(['run', '--rm', ...HARD, TAG, 'node', '-e', 'console.log("run ok")']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /run ok/);
    } finally {
      launched = release();
      await D.op(['rm', '-f', `qb29-bound-${process.pid}`]);
      await D.op(['tag', AGENT_IMAGE, TAG]);
    }
    assert.equal(launched.length, 2);
    for (const l of launched) assert.equal(l.image, pinnedId);
  });

  test('a container created from an unpinned image is removed before its workload runs', async () => {
    const release = D.bindImages({ [TAG]: pinnedId });
    const name = `qb29-unpinned-${process.pid}`;
    let launched;
    try {
      const st = await D.runStage(name, [...HARD, OTHER, 'sh', '-c', 'echo WORKLOAD-RAN']);
      assert.notEqual(st.state, 'completed');
      assert.match(st.reason || '', /image identity/);
      assert.doesNotMatch(st.stdout || '', /WORKLOAD-RAN/);
      assert.equal((await D.op(['inspect', name])).ok, false, 'the unpinned container was not removed');
      const r = await D.op(['run', '--rm', ...HARD, OTHER, 'sh', '-c', 'echo WORKLOAD-RAN']);
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stdout, /WORKLOAD-RAN/);
    } finally { launched = release(); await D.op(['rm', '-f', name]); }
    assert.deepEqual(launched, []);
  });
});
