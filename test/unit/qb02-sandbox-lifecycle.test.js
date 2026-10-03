/**
 * QB-02 step 2 — supervisor protocol, reaper and admission (agent-sandbox.md
 * §8.1, §8.3, G5). Runs the real detached supervisor with shortened timings
 * against an empty stub Docker (test/helpers/empty-docker.js), so no Docker is needed.
 * The Docker scenarios (SIGKILL, evasive payload, children, hung client) are in
 * test/integration/qb02-sandbox-lifecycle.test.js.
 */

require('../helpers/empty-docker');               // before any lib/sandbox module reads QB_DOCKER_BIN
process.env.QB_SANDBOX_RENEW_MS = '300';
process.env.QB_SANDBOX_LEASE_TIMEOUT_MS = '1500';
process.env.QB_SANDBOX_KILL_GRACE_MS = '500';
process.env.QB_SANDBOX_READY_MS = '1500';
process.env.QB_SANDBOX_ACK_MS = '3000';
process.env.QB_SANDBOX_DOCKER_OP_MS = '5000';
process.env.QB_SANDBOX_DOCKER_DOWN_MAX_MS = '3000';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const P = require('../../lib/sandbox/protocol');
const { Supervision } = require('../../lib/sandbox/lease');
const { reap } = require('../../lib/sandbox/reaper');
const A = require('../../lib/sandbox/admission');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10_000) {
  const by = Date.now() + ms;
  while (Date.now() < by) { const v = fn(); if (v) return v; await sleep(100); }
  return fn();
}

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-sbx-')); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const newRun = () => { const id = `qbu-${process.pid}-${Math.random().toString(36).slice(2, 8)}`; return [path.join(root, id), id]; };

describe('process identity', () => {
  test('this process is alive; a wrong start time or dead pid is not', () => {
    const me = P.identity(process.pid);
    assert.ok(P.alive(me));
    assert.equal(P.alive({ pid: process.pid, start: `not-${me.start}` }), false, 'PID reuse must not count as alive');
    assert.equal(P.alive({ pid: 2 ** 22 - 3, start: 'x' }), false);
    assert.equal(P.alive(null), false);
  });
});

describe('single terminal writer', () => {
  test('second commit loses; the file keeps the first state', () => {
    const [dir] = newRun(); fs.mkdirSync(dir);
    assert.equal(P.commitTerminal(dir, 'completed', 'supervisor', 'a'), true);
    assert.equal(P.commitTerminal(dir, 'timeout', 'supervisor', 'b'), false);
    assert.equal(P.terminal(dir).state, 'completed');
  });

  test('two processes racing 40 times: exactly one winner each round', async () => {
    const writer = `const P=require(${JSON.stringify(require.resolve('../../lib/sandbox/protocol'))});
      while (Date.now() < +process.argv[3]) {}
      process.stdout.write(P.commitTerminal(process.argv[1], process.argv[2], 'x', 'race') ? 'won' : 'lost');`;
    for (let i = 0; i < 40; i++) {
      const dir = path.join(root, `race${i}`); fs.mkdirSync(dir);
      const at = String(Date.now() + 120);
      const go = (st) => new Promise((res) => {
        let o = ''; const c = spawn(process.execPath, ['-e', writer, dir, st, at]);
        c.stdout.on('data', (d) => { o += d; }); c.on('exit', () => res(o));
      });
      const [a, b] = await Promise.all([go('completed'), go('timeout')]);
      assert.equal([a, b].filter((x) => x === 'won').length, 1, `round ${i}: ${a}/${b}`);
      assert.equal(P.terminal(dir).state, a === 'won' ? 'completed' : 'timeout');
    }
  });
});

describe('supervisor protocol (real detached supervisor)', () => {
  test('readiness handshake: start() resolves only once the supervisor is ready', async () => {
    const [dir, id] = newRun();
    const s = await Supervision.start(dir, id);
    assert.ok(P.alive(s.supervisor));
    assert.equal(P.readJson(path.join(dir, 'supervisor.json')).ready, true);
    const t = await s.propose('completed', 'test');
    assert.equal(t.state, 'completed');
    assert.equal(t.actor, 'supervisor');
  });

  test('a supervisor that never becomes ready: start() throws, it is killed, infra_error committed', async () => {
    const [dir, id] = newRun();
    await assert.rejects(Supervision.start(dir, id, { supervisorPath: require.resolve('../helpers/never-ready-supervisor') }),
      (e) => e.code === 'SUPERVISOR_NOT_READY');
    const t = P.terminal(dir);
    assert.equal(t.state, 'infra_error');
    assert.equal(t.reason, 'supervisor_not_ready');
  });

  test('stage deadline is enforced even while the lease keeps renewing; renewals cannot extend it', async () => {
    const [dir, id] = newRun();
    const s = await Supervision.start(dir, id);
    const t0 = Date.now();
    await s.beginStage('agent', 1000);
    const t = await until(() => P.terminal(dir), 10_000);
    s.close();
    const elapsed = Date.now() - t0;
    assert.equal(t.state, 'timeout');
    assert.equal(t.reason, 'stage_deadline');
    assert.ok(elapsed >= 1000 + 500 - 300 && elapsed < 6000, `enforced after ${elapsed} ms`);
  });

  test('lease expiry (CLI gone) → ABANDONED by the supervisor', async () => {
    const [dir, id] = newRun();
    const s = await Supervision.start(dir, id);
    await s.beginStage('agent', 60_000);
    s.close();                                    // stop renewing, as a SIGKILLed CLI would
    const lastRenewal = Date.parse(P.readJson(path.join(dir, 'lease.json')).at);
    const t = await until(() => P.terminal(dir), 20_000);
    assert.ok(t, 'no terminal state within 20 s');
    assert.deepEqual([t.state, t.reason], ['ABANDONED', 'lease_expired']);
    // Bound measured by the supervisor itself (its enforcement record), not by this
    // test's polling: last renewal + lease (1.5 s) + grace (0.5 s) + 2 s for its
    // 200 ms poll and scheduling on a loaded CI runner. The exact G5a bound is
    // asserted with Docker in test/integration/qb02-sandbox-lifecycle.test.js.
    const e = await until(() => P.readJson(path.join(dir, 'enforcement.json')), 10_000);
    const late = Date.parse(e.enforce_at) - lastRenewal;
    assert.ok(late >= 1500 && late < 1500 + 500 + 2000, `enforced ${late} ms after the last renewal`);
  });

  test('a completed proposal is committed by the supervisor, which then exits', async () => {
    const [dir, id] = newRun();
    const s = await Supervision.start(dir, id);
    await s.beginStage('agent', 60_000);
    s.endStage('agent');
    const t = await s.propose('completed', 'exit 0');
    assert.equal(t.state, 'completed');
    assert.equal(await until(() => !P.alive(s.supervisor), 5000), true);
  });

  test('supervisor killed → onSupervisorLost fires once', async () => {
    const [dir, id] = newRun();
    const s = await Supervision.start(dir, id);
    let calls = 0;
    s.onSupervisorLost = () => { calls++; P.commitTerminal(dir, 'infra_error', 'cli', 'supervisor_lost'); };
    process.kill(s.supervisor.pid, 'SIGKILL');
    await until(() => calls > 0, 5000);
    await sleep(1200);
    s.close();
    assert.equal(calls, 1);
    assert.equal(P.terminal(dir).reason, 'supervisor_lost');
  });
});

const DAY = 24 * 60 * 60 * 1000;
const JUMP = require.resolve('../helpers/preload-clock-jump');

/** Run fn with Date.now moved by `ms` in this process, from `afterMs` on. */
async function withCliClockJump(ms, afterMs, fn) {
  const real = Date.now;
  const timer = setTimeout(() => { Date.now = () => real() + ms; }, afterMs);
  try { return await fn(); } finally { clearTimeout(timer); Date.now = real; }
}
/** Start a real supervisor whose wall clock jumps by `ms` right after it starts. */
async function startJumped(dir, id, ms) {
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_OPTIONS: `--require ${JUMP}`, QB_TEST_CLOCK_JUMP_MS: String(ms), QB_TEST_CLOCK_JUMP_AFTER_MS: '50' });
  try { return await Supervision.start(dir, id); } finally {
    for (const k of ['NODE_OPTIONS', 'QB_TEST_CLOCK_JUMP_MS', 'QB_TEST_CLOCK_JUMP_AFTER_MS']) {
      if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
    }
  }
}

describe('T-LIFE wall-clock jump (§11.2): only monotonic time bounds the protocol', () => {
  const SLOW = require.resolve('../helpers/slow-ready-supervisor');

  for (const [name, ms] of [['forward', DAY], ['backward', -DAY]]) {
    test(`CLI: a ${name} jump while waiting for readiness neither fails nor hangs start()`, { timeout: 10_000 }, async () => {
      const [dir, id] = newRun();
      const s = await withCliClockJump(ms, 200, () => Supervision.start(dir, id, { supervisorPath: SLOW }));
      s.close();
      process.kill(s.supervisor.pid, 'SIGKILL');
      assert.equal(P.terminal(dir), null);
    });
  }

  test('CLI: a backward jump does not stretch the readiness timeout', { timeout: 10_000 }, async () => {
    const [dir, id] = newRun();
    const t0 = P.mono();
    await withCliClockJump(-DAY, 200, () => assert.rejects(
      Supervision.start(dir, id, { supervisorPath: require.resolve('../helpers/never-ready-supervisor') }),
      (e) => e.code === 'SUPERVISOR_NOT_READY'));
    assert.ok(P.mono() - t0 < 4000);
  });

  test('supervisor: a forward jump does not fire a stage deadline early', async () => {
    const [dir, id] = newRun();
    const s = await startJumped(dir, id, DAY);
    await s.beginStage('agent', 60_000);
    await sleep(2500);
    assert.equal(P.terminal(dir), null, 'deadline fired after a wall-clock jump');
    s.endStage('agent');
    assert.equal((await s.propose('completed', 'exit 0')).state, 'completed');
  });

  test('supervisor: a backward jump does not delay a stage deadline', async () => {
    const [dir, id] = newRun();
    const s = await startJumped(dir, id, -DAY);
    const t0 = P.mono();
    await s.beginStage('agent', 1000);
    const t = await until(() => P.terminal(dir), 10_000);
    s.close();
    assert.equal(t && t.state, 'timeout');
    assert.ok(P.mono() - t0 < 6000);
  });
});

describe('reaper', () => {
  test('owners dead → ABANDONED; owners alive (pid + start time) → left alone; PID reuse does not count', async () => {
    const me = P.identity(process.pid);
    const mk = (name, owner) => {
      const d = path.join(root, name); fs.mkdirSync(d);
      P.atomicWrite(path.join(d, 'run.json'), { run_id: name, cli: owner, supervisor: owner });
    };
    mk('qbu-dead', { pid: 2 ** 22 - 5, start: 'x' });
    mk('qbu-reused', { pid: process.pid, start: `not-${me.start}` });
    mk('qbu-live', me);
    const d = Object.fromEntries((await reap(root)).map((x) => [x.runId, x.decision]));
    assert.deepEqual(d, { 'qbu-dead': 'reaped', 'qbu-reused': 'reaped', 'qbu-live': 'owner_alive' });
    assert.equal(P.terminal(path.join(root, 'qbu-dead')).state, 'ABANDONED');
    assert.equal(P.terminal(path.join(root, 'qbu-live')), null);
  });
});

describe('admission (§8.1)', () => {
  const plenty = 'MemAvailable:   67108864 kB\n';
  test('one run per installation; released slot can be retaken', () => {
    const a = A.admit(root, { runId: 'r1', meminfo: plenty });
    assert.equal(a.ok, true);
    const b = A.admit(root, { runId: 'r2', meminfo: plenty });
    assert.deepEqual([b.ok, b.reason, b.owner_run], [false, 'run_in_progress', 'r1']);
    a.release();
    assert.equal(A.admit(root, { runId: 'r3', meminfo: plenty }).ok, true);
  });

  test('a lock left by a dead owner is reclaimed', () => {
    fs.writeFileSync(path.join(root, 'admission.lock'), JSON.stringify({ pid: 2 ** 22 - 7, start: 'x', run_id: 'old' }));
    assert.equal(A.admit(root, { runId: 'new', meminfo: plenty }).ok, true);
  });

  test('insufficient memory → refused with the numbers, and the slot is released', () => {
    const r = A.admit(root, { runId: 'r1', meminfo: 'MemAvailable:   1048576 kB\n' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'insufficient_host_resources');
    assert.ok(r.needed > r.mem_available);
    assert.equal(A.admit(root, { runId: 'r2', meminfo: plenty }).ok, true);
  });

  test('default per-run peak fits a 16 GB host; stage limits cover writes + working set', () => {
    const GiB = 1024 ** 3;
    assert.ok(A.perRunPeak() + 2 * GiB <= 12 * GiB, `peak ${(A.perRunPeak() / GiB).toFixed(1)} GiB`);
    assert.ok(A.stageMemoryLimit('deps') >= (1.1 * (1 + 1.5) + 2) * GiB);
    assert.equal(A.memAvailable('MemTotal: 1 kB\nMemAvailable:   2048 kB\n'), 2048 * 1024);
  });
});
