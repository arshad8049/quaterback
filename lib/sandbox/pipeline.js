/**
 * lib/sandbox/pipeline.js — one sandboxed agent run, end to end (agent-sandbox.md).
 *
 *   docker available? → reap leftovers → admission → supervisor (readiness)
 *   → workspace + keeper → ① seed → ② deps → credentials (§5) → ③ agent
 *   → ④ capture → ⑤ verification → proposal (the supervisor commits and removes)
 *
 * Nothing from the repository runs on the host. The CLI enforces each stage's
 * deadline itself, so a timed-out agent's partial edits are still captured
 * (QB-22); the supervisor holds a backstop deadline (stage + grace + capture
 * allowance) and the CLI lease, and acts only if the CLI hangs or dies.
 *
 * Returns an object shaped like agent/schema.js ExecutionResult fields, plus
 * `sandbox` evidence (stage states, capture verdict, deps, verification).
 */

const crypto = require('crypto');
const os = require('os');
const path = require('path');
const D = require('./docker');
const { Supervision } = require('./lease');
const { reap } = require('./reaper');
const { admit, stageMemoryLimit } = require('./admission');
const { createWorkspace } = require('./workspace');
const { prepareDeps, runVerification, depsMount } = require('./stages');
const { credentialsForRun } = require('./auth');
const { startEgress } = require('./egress');
const { runAgent } = require('./agent');
const { CONFIG } = require('./protocol');

const DEFAULT_DEADLINES = Object.freeze({
  seed: 10 * 60_000, deps: 20 * 60_000, agent: 30 * 60_000, capture: 10 * 60_000, verify: 30 * 60_000,
});
const BACKSTOP_SLACK_MS = 5 * 60_000;

function defaultStateDir() {
  return process.env.QB_SANDBOX_STATE_DIR || path.join(os.homedir(), '.qb', 'sandbox');
}

const STATUS_FROM_STAGE = { completed: 'completed', execution_error: 'execution_error', timeout: 'timeout',
  oom: 'oom', cancelled: 'cancelled', infra_error: 'infra_error' };

/**
 * @param {object} o
 * @param {string} o.repoPath    the user's checkout (read, never written)
 * @param {string} o.briefing    prompt for the agent (stdin)
 * @param {object} [o.deadlines] per-stage ms
 * @param {string} [o.stateDir]
 * @param {Function} [o.agentStage] tests only: (ws, egress) => stage result, replacing the Claude stage
 * @param {boolean} [o.verify=true]
 */
async function runSandboxed(o) {
  const t0 = Date.now();
  const deadlines = { ...DEFAULT_DEADLINES, ...(o.deadlines || {}) };
  const stateDir = o.stateDir || defaultStateDir();
  const runsRoot = path.join(stateDir, 'runs');
  const sandbox = { stages: {} };
  const done = (status, reason, extra = {}) => ({
    status, reason, diff: null, changes: [], unsupported_changes: [], base_tree: null, candidate_tree: null,
    exit_code: null, signal: null, stderr_tail: null, error: reason, duration_ms: Date.now() - t0, sandbox, ...extra,
  });

  const docker = await D.available();
  if (!docker) return done('blocked', 'sandbox_unavailable: Docker is not running or not installed (start Docker; `qb doctor` for details)');
  sandbox.docker = docker;
  sandbox.reaped = await reap(runsRoot);

  const runId = `qb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  sandbox.run_id = runId;
  const adm = admit(stateDir, { runId });
  if (!adm.ok) return done('blocked', adm.reason, { sandbox: { ...sandbox, admission: adm } });
  sandbox.admission = { memory_checked: adm.memory_checked, peak: adm.peak, mem_available: adm.mem_available };

  let sup = null;
  let lost = false;
  try {
    try {
      sup = await Supervision.start(path.join(runsRoot, runId), runId);
    } catch (e) {
      return done('infra_error', `supervisor: ${e.message}`);
    }
    sup.onSupervisorLost = async () => { lost = true; await D.removeRun(runId); };
    const stage = async (name, fn) => {
      if (lost) throw Object.assign(new Error('supervisor lost'), { code: 'SUPERVISOR_LOST' });
      await sup.beginStage(name, deadlines[name] + CONFIG.killGraceMs + BACKSTOP_SLACK_MS);
      try { return await fn(); } finally { sup.endStage(name); }
    };
    const finish = async (status, reason, extra) => {
      const proposed = ['completed', 'no_change'].includes(status) ? 'completed' : status;
      const t = sup ? await sup.propose(proposed, reason) : null;
      sandbox.terminal = t;
      // If the supervisor's backstop fired, its state wins (§8.4 precedence).
      if (t && t.actor === 'supervisor' && t.state !== proposed) return done(t.state, `supervisor: ${t.reason}`, extra);
      return done(status, reason, extra);
    };

    const ws = await createWorkspace(runId);
    sandbox.images = { tools: ws.image };

    // ① seed
    const seeded = await stage('seed', () => ws.seed(o.repoPath, { memoryBytes: stageMemoryLimit('seed') }));
    sandbox.stages.seed = { state: seeded.stage.state, reason: seeded.stage.reason };
    if (seeded.stage.state !== 'completed' || !seeded.report) return finish('setup_failed', `seed ${seeded.stage.state}: ${seeded.error || seeded.stage.stderr.slice(-300)}`);
    if (seeded.report.changed_during_read.length) return finish('setup_failed', 'checkout_changed_during_read');
    sandbox.seed = { base_tree: seeded.baseTree, user_head: seeded.userHead, rejected: seeded.report.rejected };

    // ② dependencies
    const deps = await stage('deps', () => prepareDeps(ws, { memoryBytes: stageMemoryLimit('deps') }));
    sandbox.deps = { status: deps.status, reason: deps.reason, detail: deps.detail, manifest_fp: deps.manifest_fp };
    if (deps.status === 'blocked') return finish('blocked', `${deps.reason}${deps.detail ? `: ${deps.detail}` : ''}`);
    if (deps.status === 'setup_failed') return finish('setup_failed', deps.reason);

    // credentials (§5) — not needed when a test replaces the agent stage
    let cred = null;
    if (!o.agentStage) {
      try { cred = await credentialsForRun(ws, stateDir, { stageDeadlineMs: deadlines.agent }); }
      catch (e) { return finish(e.code === 'INFRA' ? 'infra_error' : 'blocked', `${(e.code || 'auth').toLowerCase()}: ${e.message}`); }
      sandbox.credential_mode = cred.mode;
    }

    // ③ agent
    if (!(await ws.keeperAlive())) return finish('infra_error', 'keeper not running (Docker restarted?)');
    const egress = await startEgress(runId, 'INFERENCE');
    let agent;
    try {
      agent = await stage('agent', () => (o.agentStage
        ? o.agentStage(ws, egress, { waitTimeoutMs: deadlines.agent })
        : runAgent(ws, egress, {
          briefing: o.briefing, credentialArgs: cred.credentialArgs,
          depsMount: deps.status === 'ready' ? depsMount(ws, '/work') : [],
          memoryBytes: stageMemoryLimit('agent'), waitTimeoutMs: deadlines.agent,
        })));
    } finally {
      await egress.stop();
    }
    sandbox.stages.agent = { state: agent.state, reason: agent.reason, exit_code: agent.exit_code, oom_killed: agent.oom_killed };

    // ④ capture — on every agent outcome, so partial edits stay inspectable (QB-22)
    if (!(await ws.keeperAlive())) return finish('infra_error', 'keeper not running (Docker restarted?)');
    const cap = await stage('capture', () => ws.capture({ memoryBytes: stageMemoryLimit('capture') }));
    sandbox.capture = { verdict: cap.verdict, scan: cap.scan && { files: cap.scan.files, bytes: cap.scan.bytes } };
    const evidence = captureEvidence(cap, agent);

    let status = STATUS_FROM_STAGE[agent.state] || 'infra_error';
    if (status === 'completed' && cap.verdict.state === 'no_change') status = 'no_change';
    if (cap.verdict.state === 'error') return finish('infra_error', `capture: ${cap.verdict.reason}`, evidence);
    if (cap.verdict.state === 'unresolved') {
      evidence.unsupported_changes = unsupportedFrom(cap);
      sandbox.capture.unresolved = cap.verdict.reason;
    }
    // A path with a .git component (e.g. sub/.git/config) cannot be delivered safely.
    const gitPaths = evidence.changes.filter((c) => c.file.split('/').some((p) => p.toLowerCase() === '.git')).map((c) => c.file);
    if (gitPaths.length) {
      evidence.unsupported_changes.push(...gitPaths);
      sandbox.capture.unresolved = sandbox.capture.unresolved || 'git_metadata_path';
    }

    // ⑤ verification — only for a cleanly completed agent with a faithful capture
    if (o.verify !== false && status === 'completed' && cap.verdict.state === 'captured') {
      const ver = await stage('verify', () => runVerification(ws, deps, {
        memoryBytes: stageMemoryLimit('verify'), waitTimeoutMs: deadlines.verify }));
      sandbox.verification = {
        status: ver.status, reason: ver.reason, prep: ver.prep,
        state: ver.stage && ver.stage.state, exit_code: ver.stage && ver.stage.exit_code,
        oom_killed: ver.stage && ver.stage.oom_killed,
        duration_ms: ver.stage ? ver.stage.duration_ms : null,
        output: ver.stage ? `${ver.stage.stdout}${ver.stage.stderr}`.slice(-8000) : null,
      };
    }
    return finish(status, agent.reason, evidence);
  } catch (e) {
    return done('infra_error', `${e.code || 'error'}: ${e.message}`);
  } finally {
    if (sup) sup.close();
    await D.removeRun(runId);               // backstop; normally the supervisor already removed everything
    adm.release();
  }
}


/** Map capture output to ExecutionResult fields. */
function captureEvidence(cap, agent) {
  const changes = [];
  const ns = cap.nameStatus || [];
  for (let i = 0; i + 1 < ns.length; i += 2) {
    const file = ns[i + 1];
    const n = (cap.numstat || {})[file] || { additions: 0, deletions: 0, binary: false };
    changes.push({ file, status: ns[i][0], additions: n.additions, deletions: n.deletions, binary: n.binary });
  }
  const diff = cap.patch && cap.patch.length ? cap.patch.toString('utf8') : null;
  return {
    diff, changes, unsupported_changes: [],
    // Exact bytes for `qb patch` (the text `diff` is for display and judging).
    patch_raw: cap.patch && cap.patch.length ? cap.patch : null,
    base_listing: cap.baseListing || null,
    base_tree: cap.baseTree || null, candidate_tree: cap.candidateTree || null,
    exit_code: agent.exit_code, signal: null,
    stderr_tail: agent.stderr ? agent.stderr.slice(-2000) : null,
  };
}

function unsupportedFrom(cap) {
  const d = cap.verdict.detail;
  if (Array.isArray(d)) return d.map((x) => x.path || String(x));
  return [`capture: ${cap.verdict.reason}${d ? ` (${d})` : ''}`];
}

module.exports = { runSandboxed, defaultStateDir, DEFAULT_DEADLINES };
