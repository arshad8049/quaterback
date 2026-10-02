#!/usr/bin/env node
/**
 * Test driver: plays the QB CLI's part for one sandboxed stage, so integration
 * tests can SIGKILL "the CLI" mid-stage. Uses the product modules unchanged.
 *
 * Usage: sandbox-driver.js <runDir> <runId> <payload-file> <deadline_ms> <in_container_timeout_s>
 * Prints "STARTED <container>" once the workload runs; then waits, renewing the lease,
 * until the stage ends, and proposes the classified outcome.
 */
const fs = require('fs');
const { Supervision } = require('../../lib/sandbox/lease');
const D = require('../../lib/sandbox/docker');
const P = require('../../lib/sandbox/protocol');

const [runDir, runId, payloadFile, deadline, inTimeout] = process.argv.slice(2);
const IMAGE = 'busybox:1.36.1';
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--network', 'none', '--init', '--pids-limit', '64'];

(async () => {
  const s = await Supervision.start(runDir, runId);
  s.onSupervisorLost = async () => {
    for (let i = 0; i < 5; i++) {
      const r = await D.runContainers(runId, { running: true });
      if (!r.length) break;
      await D.op(['kill', ...r]);
    }
    P.commitTerminal(runDir, 'infra_error', 'cli', 'supervisor_lost');
    await D.removeRun(runId);
    process.exit(4);
  };
  await D.op(['volume', 'create', ...D.runLabels(runId), `${runId}-work`]);
  await D.op(['run', '-d', '--name', `${runId}-keeper`, ...HARDEN, ...D.runLabels(runId, 'keeper'),
    '-v', `${runId}-work:/v/work`, IMAGE, 'sleep', '2147483647']);
  await s.beginStage('agent', Number(deadline));
  const name = `${runId}-agent`;
  await D.op(['run', '-d', '--name', name, ...HARDEN, ...D.runLabels(runId, 'workload'),
    IMAGE, 'timeout', '-s', 'KILL', String(inTimeout), 'sh', '-c', fs.readFileSync(payloadFile, 'utf8')]);
  process.stdout.write(`STARTED ${name}\n`);
  await D.op(['wait', name], { timeoutMs: 10 * 60_000 });
  s.endStage('agent');
  const st = await D.inspectState(name);
  const { classifyStage } = require('../../lib/sandbox/states');
  const c = classifyStage(st, { killedBy: s.terminal() && s.terminal().state === 'timeout' ? 'deadline' : null });
  const t = await s.propose(c.state, c.reason);
  process.stdout.write(`TERMINAL ${t && t.state}\n`);
  process.exit(0);
})().catch((e) => { process.stderr.write(String(e.stack || e)); process.exit(1); });
