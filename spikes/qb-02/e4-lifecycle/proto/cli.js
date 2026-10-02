#!/usr/bin/env node
/**
 * E4 prototype — a stand-in for the QB CLI's side of the §8.3 protocol.
 *
 * Spawns the detached supervisor and waits for its readiness handshake before
 * creating any Docker resource; renews the lease; hands each stage to the
 * supervisor and waits for the ack before starting it; watches the supervisor's
 * identity and, if it dies, kills and cleans up itself (infra_error,
 * supervisor_lost). Never commits a normal outcome itself: it proposes one.
 *
 * Usage: cli.js <runDir> <payload-script-file> <stage_deadline_ms> <in_container_timeout_s>
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common');

const [runDir, payloadFile, deadlineArg, inTimeoutArg] = process.argv.slice(2);
const runId = path.basename(runDir);
const f = (n) => path.join(runDir, n);
const IMAGE = process.env.E4_IMAGE || 'busybox:1.36.1';
const HARDEN = ['--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--init', '--pids-limit', '64',
  '--label', `qb.run=${runId}`];

fs.mkdirSync(runDir, { recursive: true });
const run = { run_id: runId, cli: C.identity(process.pid), created_resources: false };
C.atomicWrite(f('run.json'), run);

// 1. Spawn the supervisor detached (own session), then wait for its readiness.
const out = fs.openSync(f('supervisor.log'), 'a');
const sup = spawn(process.execPath, [path.join(__dirname, 'supervisor.js'), runDir],
  { detached: true, stdio: ['ignore', out, out], env: process.env });
sup.unref();
fs.writeFileSync(f('supervisor.pid'), String(sup.pid));

const readyBy = Date.now() + C.CFG.readyMs;
let supId = null;
while (Date.now() < readyBy) {
  const s = C.readJson(f('supervisor.json'));
  if (s && s.ready && s.pid === sup.pid) { supId = { pid: s.pid, start: s.start }; break; }
  C.sleepMs(100);
}
if (!supId) {
  try { process.kill(sup.pid, 'SIGKILL'); } catch {}
  C.commitTerminal(runDir, 'infra_error', 'cli', 'supervisor_not_ready');
  C.event(runDir, 'cli', 'supervisor_not_ready', { created_resources: false });
  process.exit(3);
}
run.supervisor = supId;
C.atomicWrite(f('run.json'), run);
C.event(runDir, 'cli', 'supervisor_ready', supId);

// 2. Lease renewals start now and continue for the CLI's whole life.
let seq = 0;
const renew = () => C.atomicWrite(f('lease.json'), { seq: ++seq, at: new Date().toISOString() });
renew();
setInterval(renew, C.CFG.renewMs);

// 3. Per-run resources (only after readiness): network, tmpfs volumes, keeper, proxy stand-in.
const net = `${runId}-egress`;
C.docker(['network', 'create', '--internal', '--label', `qb.run=${runId}`, net]);
for (const v of ['work', 'deps']) {
  C.docker(['volume', 'create', '--driver', 'local', '--label', `qb.run=${runId}`,
    '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=16m,uid=10001,gid=10001', `${runId}-${v}`]);
}
const vols = ['-v', `${runId}-work:/v/work`, '-v', `${runId}-deps:/v/deps`];
C.docker(['run', '-d', '--name', `${runId}-keeper`, ...HARDEN, '--network', 'none', '--label', 'qb.role=keeper',
  ...vols, IMAGE, 'sleep', '2147483647']);
C.docker(['run', '-d', '--name', `${runId}-proxy`, ...HARDEN, '--network', net, '--label', 'qb.role=proxy',
  IMAGE, 'sleep', '2147483647']);
run.created_resources = true;
C.atomicWrite(f('run.json'), run);

// 4. Hand the stage to the supervisor; start it only after the ack.
const stageId = 'agent-1';
C.atomicWrite(f('stage.json'), { id: stageId, deadline_ms: +deadlineArg });
const ackBy = Date.now() + 5000;
while (!(C.readJson(f('stage-ack.json')) || {}).id && Date.now() < ackBy) C.sleepMs(100);
C.event(runDir, 'cli', 'stage_acked', { id: stageId });

const payload = fs.readFileSync(payloadFile, 'utf8');
const r = C.docker(['run', '-d', '--name', `${runId}-agent`, ...HARDEN, '--network', 'none',
  '--label', 'qb.role=workload', '--memory', '128m', '--memory-swap', '128m', ...vols,
  IMAGE, 'timeout', '-s', 'KILL', String(inTimeoutArg), 'sh', '-c', payload]);
C.event(runDir, 'cli', 'workload_started', { ok: r.ok, id: r.stdout.slice(0, 12) });
fs.writeFileSync(f('workload_started'), new Date().toISOString());

// 5. Watch the supervisor; if it dies first, the CLI cleans up (supervisor_lost).
const watch = setInterval(() => {
  if (fs.existsSync(f('terminal.json'))) return;
  if (!C.alive(supId)) {
    clearInterval(watch);
    C.event(runDir, 'cli', 'supervisor_lost');
    const t0 = Date.now();
    const k = C.killAll(runDir, 'cli', runId);
    C.commitTerminal(runDir, 'infra_error', 'cli', 'supervisor_lost');
    const left = C.cleanup(runDir, 'cli', runId);
    C.atomicWrite(f('cli-recovery.json'), { detected_at: new Date(t0).toISOString(), kill_ms: k.kill_ms, left });
    process.exit(4);
  }
}, 500);

// 6. Wait for the workload asynchronously (keeps renewals flowing), then propose an outcome.
const w = spawn(process.env.E4_DOCKER || 'docker', ['wait', `${runId}-agent`], { stdio: ['ignore', 'pipe', 'ignore'] });
w.on('exit', () => {
  const st = JSON.parse(C.docker(['inspect', '-f', '{{json .State}}', `${runId}-agent`]).stdout || '{}');
  // §8.4 precedence: OOMKilled wins over the exit code.
  const state = st.OOMKilled ? 'oom' : st.ExitCode === 0 ? 'completed' : 'execution_error';
  C.atomicWrite(f('stage-done.json'), { id: stageId });
  C.atomicWrite(f('proposal.json'), { state, reason: `exit=${st.ExitCode} oom=${st.OOMKilled}` });
  C.event(runDir, 'cli', 'proposed', { state });
  const by = Date.now() + 30000;
  const t = setInterval(() => {
    if (fs.existsSync(f('terminal.json')) && !C.alive(supId) || Date.now() > by) {
      clearInterval(t); process.exit(0);
    }
  }, 200);
});
