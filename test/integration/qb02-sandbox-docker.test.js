/**
 * QB-02 step 1 — Docker integration (T-RES subset). Needs Docker; runs only
 * with QB_INTEGRATION=1 (`npm run test:integration`).
 *
 *   - A child OOM-killed under a main process that exits 0 is reported `oom`.
 *   - A container flooding its logs neither blocks the CLI nor loses its exit state.
 *   - removeRun leaves no containers, networks or volumes for the run.
 */

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../../lib/sandbox/docker');

const ENABLED = process.env.QB_INTEGRATION === '1';
const IMAGE = 'busybox:1.36.1';
const RUN = `qbit-${process.pid}-${Date.now()}`;
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--network', 'none', '--init', '--pids-limit', '64'];

describe('sandbox docker foundation', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  after(async () => { await D.removeRun(RUN); });

  test('docker is available', async () => {
    assert.ok(await D.available(), 'docker daemon not reachable');
    assert.ok((await D.op(['pull', '-q', IMAGE], { timeoutMs: 120_000 })).ok);
  });

  test('OOM-killed child under a main process that exits 0 is classified oom', async () => {
    const r = await D.runStage(`${RUN}-oom`, [...HARDEN, ...D.runLabels(RUN, 'workload'),
      '--memory', '32m', '--memory-swap', '32m', '--tmpfs', '/big:rw,size=128m', IMAGE,
      // The child volunteers as the OOM victim (raising one's own oom_score_adj needs no
      // privilege), so the kernel cannot pick the main shell instead (flaked in CI at 52714f8).
      'sh', '-c', '(echo 1000 > /proc/self/oom_score_adj; exec dd if=/dev/zero of=/big/f bs=1M count=96 2>/dev/null); echo "child exit $?"; exit 0']);
    assert.equal(r.exit_code, 0, 'main process exited 0');
    assert.equal(r.oom_killed, true);
    assert.equal(r.state, 'oom');
  });

  test('a log flood neither blocks nor loses the exit state', async () => {
    const r = await D.runStage(`${RUN}-flood`, [...HARDEN, ...D.runLabels(RUN, 'workload'), IMAGE,
      'sh', '-c', 'head -c 50000000 /dev/zero | tr "\\0" x; echo; echo LAST-LINE; exit 3'],
      { maxBytes: 64 * 1024, waitTimeoutMs: 120_000 });
    assert.equal(r.state, 'execution_error');
    assert.equal(r.exit_code, 3);
    assert.ok(r.stdout_dropped > 49_000_000);
    assert.match(r.stdout, /LAST-LINE\s*$/);
  });

  test('removeRun leaves nothing behind', async () => {
    await D.op(['volume', 'create', ...D.runLabels(RUN), `${RUN}-vol`]);
    await D.op(['network', 'create', '--internal', ...D.runLabels(RUN), `${RUN}-net`]);
    const left = await D.removeRun(RUN);
    assert.deepEqual(left, { containers: 0, networks: 0, volumes: 0 });
  });
});
