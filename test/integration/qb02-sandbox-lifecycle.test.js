/**
 * QB-02 step 2 — T-LIFE on the product supervisor (agent-sandbox.md §8.3, G5a–e).
 * Re-runs the E4 scenarios against lib/sandbox, with real Docker. Needs
 * QB_INTEGRATION=1. Timings are shortened; the bound under test is
 * last renewal + lease + grace (+ one Docker op) exactly as in G5a.
 */

process.env.QB_SANDBOX_RENEW_MS = '500';
process.env.QB_SANDBOX_LEASE_TIMEOUT_MS = '3000';
process.env.QB_SANDBOX_KILL_GRACE_MS = '1500';
process.env.QB_SANDBOX_DOCKER_OP_MS = '8000';
process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS = '60000';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const D = require('../../lib/sandbox/docker');
const P = require('../../lib/sandbox/protocol');
const { reap } = require('../../lib/sandbox/reaper');

const ENABLED = process.env.QB_INTEGRATION === '1';
const LINUX = process.platform === 'linux';
const DRIVER = require.resolve('../helpers/sandbox-driver');
const BOUND_MS = 3000 + 1500 + 8000 + 1500;   // lease + grace + docker op + harness slack
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const by = Date.now() + ms; let v; while (!(v = fn()) && Date.now() < by) await sleep(200); return v; }

// Kills its own in-container timeout watcher, spawns every kind of child, ignores signals.
const EVASIVE = `echo start
( trap '' TERM; exec sleep 7101 ) &
( sh -c 'sleep 7102 &' & )
setsid sleep 7103 &
nohup sleep 7104 >/dev/null 2>&1 &
pkill -KILL -x timeout && echo "killed timeout watcher"
trap '' TERM INT HUP
i=0; while :; do sleep 1; i=$((i+1)); echo "alive $i"; done
`;

let root, payload;
const runs = [];
function startDriver(deadlineMs, env = {}, inContainerTimeoutS = '3') {
  const id = `qbit-${process.pid}-${runs.length}-${Date.now() % 100000}`;
  const dir = path.join(root, id);
  runs.push(id);
  const child = spawn(process.execPath, [DRIVER, dir, id, payload, String(deadlineMs), inContainerTimeoutS],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const started = new Promise((res) => { const i = setInterval(() => { if (/STARTED/.test(out)) { clearInterval(i); res(); } }, 100); });
  return { id, dir, child, started, output: () => out };
}
async function stopTimes(id, t0, ms = 60_000) {
  let stopped = -1;
  const by = Date.now() + ms;
  while (Date.now() < by) {
    const now = Date.now();
    if (stopped < 0 && !(await D.runContainers(id, { running: true })).length) stopped = now - t0;
    const vols = (await D.op(['volume', 'ls', '-q', '--filter', `label=qb.run=${id}`])).stdout.split('\n').filter(Boolean);
    const all = (await D.runContainers(id)).length + vols.length;
    if (stopped >= 0 && all === 0) return { stopped, cleaned: now - t0 };
    await sleep(200);
  }
  return { stopped, cleaned: -1 };
}
const childPids = () => (LINUX
  ? spawnSync('pgrep', ['-f', '^(sh -c )?sleep 710[1-4]( &)?$'], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  : []);

describe('T-LIFE: product supervisor with Docker', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-tlife-'));
    payload = path.join(root, 'evasive.sh');
    fs.writeFileSync(payload, EVASIVE);
    assert.ok((await D.op(['pull', '-q', 'busybox:1.36.1'], { timeoutMs: 120_000 })).ok);
  });
  after(async () => {
    for (const id of runs) await D.removeRun(id);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('CLI SIGKILLed mid-stage → bounded termination, ABANDONED, nothing left, no child survives', async () => {
    const d = startDriver(120_000);
    await d.started; await sleep(4500);                       // past the 3 s in-container timeout
    const kids = childPids();
    if (LINUX) assert.ok(kids.length >= 4, `expected the 4 evasive children, saw ${kids.length}`);
    const t0 = Date.now(); d.child.kill('SIGKILL');
    const t = await stopTimes(d.id, t0);
    assert.ok(t.stopped >= 0 && t.stopped <= BOUND_MS, `stopped after ${t.stopped} ms (bound ${BOUND_MS})`);
    assert.ok(t.cleaned >= 0, 'resources not removed');
    assert.equal(P.terminal(d.dir).state, 'ABANDONED');
    if (LINUX) assert.deepEqual(childPids(), [], 'a child process survived');
  });

  test('payload disables its own timeout; external deadline still stops it while the CLI renews', async () => {
    const d = startDriver(5000);
    await d.started;
    const exit = await new Promise((res) => d.child.on('exit', res));
    assert.equal(exit, 0, d.output());
    const t = P.terminal(d.dir);
    assert.equal(t.state, 'timeout');
    const e = P.readJson(path.join(d.dir, 'enforcement.json'));
    assert.deepEqual(e.left, { containers: 0, networks: 0, volumes: 0 });
    if (LINUX) assert.deepEqual(childPids(), []);
  });

  test('CLI and supervisor both killed → still running until the reaper, which cleans up', async () => {
    const d = startDriver(120_000);
    await d.started;
    const sup = P.readJson(path.join(d.dir, 'run.json')).supervisor;
    process.kill(sup.pid, 'SIGKILL'); d.child.kill('SIGKILL');
    await sleep(5000);
    assert.ok((await D.runContainers(d.id, { running: true })).length > 0, 'expected the residual: nothing enforces until next start');
    const decisions = await reap(root);
    assert.equal(decisions.find((x) => x.runId === d.id).decision, 'reaped');
    assert.equal(P.terminal(d.dir).state, 'ABANDONED');
    assert.equal((await D.runContainers(d.id)).length, 0);
  });

  test('supervisor SIGKILLed, CLI alive → CLI recovers: infra_error / supervisor_lost, nothing left', async () => {
    const d = startDriver(120_000);
    await d.started;
    const sup = P.readJson(path.join(d.dir, 'run.json')).supervisor;
    const t0 = Date.now(); process.kill(sup.pid, 'SIGKILL');
    const t = await stopTimes(d.id, t0);
    assert.ok(t.stopped >= 0 && t.stopped <= 500 + 8000 + 1500, `stopped after ${t.stopped} ms`);
    assert.equal(P.terminal(d.dir).reason, 'supervisor_lost');
  });

  test('Docker unavailable past the deadline → nothing claimed, retried, infra_error, cleaned up when it returns (G5c)', async () => {
    const stub = path.join(root, 'docker-down-stub');
    const down = path.join(root, 'docker-is-down');
    const real = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
    // While the marker exists, every new Docker command fails the way a stopped daemon does.
    fs.writeFileSync(stub, `#!/bin/sh\nif [ -e '${down}' ]; then echo 'Cannot connect to the Docker daemon' >&2; exit 1; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
    // The workload must outlive the deadline (its own in-container timeout is 60 s). With
    // the default 3 s it could exit by itself right at the 3 s deadline: `docker wait`
    // (already running) returned, the driver proposed an outcome while Docker was "down",
    // and the supervisor committed it — the flake seen on macOS and once on CI.
    const d = startDriver(3000, { QB_DOCKER_BIN: stub }, '60');
    await d.started;
    fs.writeFileSync(down, '');
    await sleep(3000 + 1500 + 4000);                         // well past deadline + grace
    assert.equal(P.terminal(d.dir), null, 'nothing may be committed while enforcement cannot be confirmed');
    assert.ok((await D.runContainers(d.id, { running: true })).length > 0, 'residual: the workload runs while Docker is unreachable');
    fs.rmSync(down);
    const t = await until(() => P.terminal(d.dir), 30_000);
    assert.equal(t.state, 'infra_error');
    assert.match(t.reason, /docker_unavailable/);
    const e = await until(() => P.readJson(path.join(d.dir, 'enforcement.json')), 30_000);
    assert.equal(e.docker_unavailable, true);
    assert.deepEqual(e.left, { containers: 0, networks: 0, volumes: 0 });
    assert.match(fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8'), /"docker_unavailable"/);
    await new Promise((res) => (d.child.exitCode !== null ? res() : d.child.on('exit', res)));
  });

  test('first docker kill hangs → enforcement continues after the Docker op timeout', async () => {
    const stub = path.join(root, 'docker-stub');
    const marker = path.join(root, 'hung-once');
    const real = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(stub, `#!/bin/sh\nif [ "$1" = kill ] && [ ! -e '${marker}' ]; then touch '${marker}'; exec sleep 60; fi\nexec '${real}' "$@"\n`, { mode: 0o755 });
    const d = startDriver(4000, { QB_DOCKER_BIN: stub });
    await d.started;
    await new Promise((res) => d.child.on('exit', res));
    assert.equal(P.terminal(d.dir).state, 'timeout');
    const ev = fs.readFileSync(path.join(d.dir, 'events.jsonl'), 'utf8');
    assert.match(ev, /"timedOut":true/, 'the hung kill should have timed out');
    assert.equal((await D.runContainers(d.id)).length, 0);
  });
});
