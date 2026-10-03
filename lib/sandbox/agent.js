/**
 * lib/sandbox/agent.js — the agent stage ③ (agent-sandbox.md §3.3).
 *
 * Runs the pinned official Claude Code binary as uid 10001 with no external
 * network interface: its only way out is the read-only-mounted proxy socket.
 * The workspace is the only writable project mount; dependencies (when present)
 * are read-only; credentials are provided per §5 by the caller.
 */

const fs = require('fs');
const path = require('path');
const D = require('./docker');
const { hardened } = require('./workspace');

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');
const AGENT_IMAGE = process.env.QB_SANDBOX_AGENT_IMAGE || D.contentTag('qb-sandbox-agent', path.join(SANDBOX_DIR, 'agent'), ['.']);
/** The pinned Claude Code version (sandbox/agent/Dockerfile ARG) and image, for run records. */
const CLAUDE_VERSION = (fs.readFileSync(path.join(SANDBOX_DIR, 'agent', 'Dockerfile'), 'utf8').match(/^ARG CLAUDE_VERSION=(\S+)$/m) || [])[1] || null;
const AGENT_VERSION = `claude-code@${CLAUDE_VERSION} (${AGENT_IMAGE})`;

// Optional traffic, updates and unused features off (§4.3).
const AGENT_ENV = [
  'HOME=/tmp/home', 'CLAUDE_CONFIG_DIR=/cfg',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1',
  'DISABLE_ERROR_REPORTING=1', 'ENABLE_CLAUDEAI_MCP_SERVERS=false', 'CLAUDE_CODE_DISABLE_ARTIFACT=1',
];

function ensureAgentImage() {
  return D.ensureImage(AGENT_IMAGE, [path.join(SANDBOX_DIR, 'agent')], 'agent');
}

/**
 * @param {object} ws       workspace (createWorkspace)
 * @param {object} egress   proxy for policy INFERENCE (startEgress)
 * @param {object} o        { briefing, credentialArgs: string[], depsMount?: string[], memoryBytes, killedBy, waitTimeoutMs }
 *   credentialArgs: docker flags that provide the credential (§5): a per-run
 *   config volume mounted at /cfg (Mode S) or `-e NAME` passthrough (Mode K).
 */
async function runAgent(ws, egress, o) {
  await ensureAgentImage();
  const mem = o.memoryBytes ? ['--memory', String(o.memoryBytes), '--memory-swap', String(o.memoryBytes)] : [];
  return D.runStage(`${ws.runId}-agent`, [
    ...hardened(ws.runId, 'workload'), '--network', 'none', ...mem,
    ...AGENT_ENV.flatMap((e) => ['-e', e]),
    ...ws.mount('work'), ...(o.depsMount || []), ...egress.mount(), ...(o.credentialArgs || []),
    '--tmpfs', '/tmp/home:rw,size=64m,uid=10001,gid=10001,mode=0700',
    '--entrypoint', '/usr/local/lib/qb/agent-entry.sh', AGENT_IMAGE,
  ], { input: o.briefing, waitTimeoutMs: o.waitTimeoutMs, killedBy: o.killedBy, maxBytes: 512 * 1024 });
}

module.exports = { runAgent, ensureAgentImage, AGENT_IMAGE, AGENT_VERSION, AGENT_ENV };
