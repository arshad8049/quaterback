/**
 * QB-02 T-LIFE variant (agent-sandbox.md §11.2, G5c): the Docker daemon is
 * stopped mid-run, then started again. Linux CI only: it really stops dockerd
 * (`sudo systemctl`), so it runs alone, after the integration suite, and only
 * with QB_DOCKER_DAEMON_CONTROL=1. The portable version (a Docker CLI that
 * stops answering) is in test/integration/qb02-sandbox-lifecycle.test.js.
 */

process.env.QB_SANDBOX_RENEW_MS = '500';
process.env.QB_SANDBOX_LEASE_TIMEOUT_MS = '3000';
process.env.QB_SANDBOX_KILL_GRACE_MS = '1500';
process.env.QB_SANDBOX_DOCKER_OP_MS = '8000';
process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS = '120000';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const D = require('../../lib/sandbox/docker');
const P = require('../../lib/sandbox/protocol');

const ENABLED = process.env.QB_DOCKER_DAEMON_CONTROL === '1' && process.platform === 'linux';
const DRIVER = require.resolve('../helpers/sandbox-driver');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const systemctl = (...a) => spawnSync('sudo', ['systemctl', ...a], { encoding: 'utf8' });
const childPids = () => spawnSync('pgrep', ['-f', '^(sh -c )?sleep 720[1-4]( &)?$'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

const EVASIVE = `( trap '' TERM; exec sleep 7201 ) &
( sh -c 'sleep 7202 &' & )
setsid sleep 7203 &
nohup sleep 7204 >/dev/null 2>&1 &
trap '' TERM INT HUP
while :; do sleep 1; done
`;

describe('T-LIFE: Docker daemon stopped mid-run', { skip: !ENABLED && 'Linux CI only (QB_DOCKER_DAEMON_CONTROL=1)' }, () => {
  let root;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-dstop-'));
    assert.ok((await D.op(['pull', '-q', 'busybox:1.36.1'], { timeoutMs: 120_000 })).ok);
  });
  after(() => {
    systemctl('start', 'docker.socket', 'docker');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('workload stopped with the daemon; run ends infra_error; everything removed once Docker returns; no child survives', async () => {
    const live = (await D.op(['info', '-f', '{{.LiveRestoreEnabled}}'])).stdout.trim();
    assert.equal(live, 'false', 'this scenario assumes live-restore is off (with it, workloads outlive the daemon; §12 warns)');
    const payload = path.join(root, 'evasive.sh');
    fs.writeFileSync(payload, EVASIVE);
    const id = `qbds-${process.pid}`;
    const dir = path.join(root, id);
    const child = spawn(process.execPath, [DRIVER, dir, id, payload, '120000', '3600'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    while (!/STARTED/.test(out)) await sleep(100);
    await sleep(2000);
    assert.ok(childPids().length >= 4, 'expected the evasive children to be running');

    assert.equal(systemctl('stop', 'docker.socket', 'docker').status, 0);
    await sleep(6000);
    assert.equal((await D.available()), null, 'Docker should be unreachable');
    assert.deepEqual(childPids(), [], 'stopping the daemon (live-restore off) should stop the workload');
    assert.equal(systemctl('start', 'docker.socket', 'docker').status, 0);

    const by = Date.now() + 90_000;
    let left;
    while (Date.now() < by) {
      if (P.terminal(dir) && await D.available()) {
        const vols = (await D.op(['volume', 'ls', '-q', '--filter', `label=qb.run=${id}`])).stdout.trim();
        left = (await D.runContainers(id)).length + (vols ? vols.split('\n').length : 0);
        if (left === 0) break;
      }
      await sleep(500);
    }
    const t = P.terminal(dir);
    assert.equal(t && t.state, 'infra_error', `${JSON.stringify(t)}\n${out}`);
    assert.equal(left, 0, 'run resources left after Docker returned');
    assert.deepEqual(childPids(), []);
  });
});
