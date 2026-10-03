/**
 * lib/sandbox/stages.js — dependencies ② and verification ⑤ (agent-sandbox.md
 * §3.2, §3.5).
 *
 * Dependencies: trusted plan (profile check, manifest fingerprint, scratch copy)
 * → untrusted `npm ci` behind the DEPS proxy → trusted check that the install
 * changed nothing outside node_modules. The install stage never mounts the
 * trusted git volume.
 *
 * Verification: trusted prep (dependency gate; protected tests restored from
 * the base) → the test command from the base package.json, run on the
 * disposable /verify copy with read-only deps, no network, no credentials.
 */

const path = require('path');
const D = require('./docker');
const { hardened } = require('./workspace');
const { AGENT_IMAGE, ensureAgentImage } = require('./agent');
const { startEgress } = require('./egress');
const { readTar } = require('./tar');

const tools = (ws, role, mounts, script, extra = []) => D.runStage(`${ws.runId}-${role}`, [
  ...hardened(ws.runId, role), '--network', 'none', ...extra, ...mounts, ws.image, `/usr/local/lib/qb/${script}`,
], { waitTimeoutMs: 20 * 60_000 });

async function readJsonFrom(container, dir, file) {
  const r = await D.op(['cp', `${container}:${dir}/${file}`, '-'], { raw: true, maxBytes: 1024 * 1024 });
  if (!r.ok || !r.stdout_buffer) return null;
  const f = readTar(r.stdout_buffer).get(file);
  try { return f ? JSON.parse(f.toString('utf8')) : null; } catch { return null; }
}

/**
 * ② Returns { status: 'skip'|'ready'|'blocked'|'setup_failed', reason?, detail?, manifest_fp?, stages }.
 * On 'ready', the deps volume holds node_modules (mount with depsMount()).
 */
async function prepareDeps(ws, { memoryBytes } = {}) {
  const stages = {};
  stages.plan = await tools(ws, 'deps-plan', [...ws.mount('git'), ...ws.mount('scratch')], 'deps-plan.sh');
  if (stages.plan.state !== 'completed') return { status: 'setup_failed', reason: `deps plan ${stages.plan.state}`, stages };
  const plan = await readJsonFrom(`${ws.runId}-deps-plan`, '/git', 'deps-plan.json');
  if (!plan) return { status: 'setup_failed', reason: 'no deps plan', stages };
  if (plan.status !== 'ready') return { ...plan, stages };

  await ensureAgentImage();
  const egress = await startEgress(ws.runId, 'DEPS');
  try {
    const mem = memoryBytes ? ['--memory', String(memoryBytes), '--memory-swap', String(memoryBytes)] : [];
    stages.install = await D.runStage(`${ws.runId}-deps-install`, [
      ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
      '-e', 'HOME=/tmp/home', '-e', 'npm_config_update_notifier=false',
      '--tmpfs', '/tmp/home:rw,size=512m,uid=10001,gid=10001,mode=0700',
      ...ws.mount('scratch'), ...ws.mount('deps'), ...egress.mount(),
      '--entrypoint', '/usr/local/lib/qb/deps-install.sh', AGENT_IMAGE,
    ], { waitTimeoutMs: 20 * 60_000 });
  } finally {
    await egress.stop();
  }
  if (stages.install.state !== 'completed') {
    return { status: 'setup_failed', reason: `npm ci ${stages.install.state}: ${stages.install.reason}`, log: stages.install.stderr.slice(-2000), stages };
  }
  stages.check = await tools(ws, 'deps-check', [...ws.mount('git'), ...ws.mount('scratch', true)], 'deps-check.sh');
  const check = await readJsonFrom(`${ws.runId}-deps-check`, '/git', 'deps-check.json');
  if (!check || check.status !== 'ok') return { status: 'blocked', ...(check || { reason: 'deps check failed' }), stages };
  return { status: 'ready', manifest_fp: plan.manifest_fp, stages };
}

/** Mount for node_modules (read-only) under a project root inside the container. */
const depsMount = (ws, root) => ['-v', `${ws.runId}-deps:${root}/node_modules:ro`];

/**
 * ⑤ Returns { status: 'not_run'|'ran', reason?, prep, stage? }.
 * `deps` is prepareDeps' result; the test command comes from the BASE package.json.
 */
async function runVerification(ws, deps, { memoryBytes, killedBy, waitTimeoutMs = 30 * 60_000 } = {}) {
  const prepStage = await tools(ws, 'verify-prep', [...ws.mount('git', true), ...ws.mount('verify'), ...ws.mount('out')], 'verify-prep.sh');
  const prep = await readJsonFrom(`${ws.runId}-verify-prep`, '/out', 'verify-prep.json');
  if (prepStage.state !== 'completed' || !prep) return { status: 'not_run', reason: 'verify_prep_failed', prepStage };
  if (prep.status === 'dependency_change_required') return { status: 'not_run', reason: 'dependency_change_required', prep };

  const hasTest = await D.op(['run', '--rm', ...hardened(ws.runId, 'probe'), '--network', 'none', ...ws.mount('verify', true),
    '--entrypoint', 'node', AGENT_IMAGE, '-e',
    'try{const p=JSON.parse(require("fs").readFileSync("/verify/package.json","utf8"));process.exit(p&&p.scripts&&p.scripts.test?0:1)}catch{process.exit(1)}']);
  if (hasTest.status !== 0) return { status: 'not_run', reason: 'no_test_command', prep };

  const mem = memoryBytes ? ['--memory', String(memoryBytes), '--memory-swap', String(memoryBytes)] : [];
  // QB-06: QB's node:test reporter writes the machine-readable report to the out
  // volume, next to the normal console reporter. A repo whose test script passes
  // its own --test-reporter flags makes node refuse the mix: no report, no pass.
  const nodeOptions = `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER} --test-reporter-destination=${REPORT}`;
  const name = `${ws.runId}-verify`;
  const stage = await D.runStage(name, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
    '-e', 'HOME=/tmp/home', '-e', 'CI=1', '-e', 'npm_config_update_notifier=false', '-e', `NODE_OPTIONS=${nodeOptions}`,
    ...ws.mount('out'),
    '--tmpfs', '/tmp/home:rw,size=256m,uid=10001,gid=10001,mode=0700',
    ...ws.mount('verify'), ...(deps && deps.status === 'ready' ? depsMount(ws, '/verify') : []),
    '-w', '/verify', '--entrypoint', 'npm', AGENT_IMAGE, 'test',
  ], { waitTimeoutMs, killedBy, maxBytes: 256 * 1024 });
  const report = await readReport(name);
  return { status: 'ran', prep, stage, report: report.text, report_error: report.error };
}

const REPORTER = '/usr/local/lib/qb/qb-test-reporter.mjs';
const REPORT = '/out/qb-node-test.ndjson';
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/** The raw report text (validated later by verify/tests.js), or why there is none. */
async function readReport(container) {
  const r = await D.op(['cp', `${container}:${REPORT}`, '-'], { raw: true, maxBytes: MAX_REPORT_BYTES + 64 * 1024 });
  if (!r.ok) return { text: null, error: /No such file|not found|Could not find/i.test(r.stderr) ? 'no_machine_readable_report' : 'report_unreadable' };
  if (!r.stdout_buffer) return { text: null, error: 'report_too_large' };
  const f = readTar(r.stdout_buffer).get(path.basename(REPORT));
  if (!f) return { text: null, error: 'no_machine_readable_report' };
  if (f.length > MAX_REPORT_BYTES) return { text: null, error: 'report_too_large' };
  return { text: f.toString('utf8'), error: null };
}

module.exports = { prepareDeps, runVerification, depsMount };
