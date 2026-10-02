/**
 * lib/sandbox/agent.js — the agent stage ③ (agent-sandbox.md §3.3).
 *
 * Runs the pinned official Claude Code binary as uid 10001 with no external
 * network interface: its only way out is the read-only-mounted proxy socket.
 * The workspace is the only writable project mount; dependencies (when present)
 * are read-only; credentials are provided per §5 by the caller.
 */

const path = require('path');
const D = require('./docker');
const { hardened } = require('./workspace');

const AGENT_IMAGE = process.env.QB_SANDBOX_AGENT_IMAGE || 'qb-sandbox-agent:dev';
const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');

// Optional traffic, updates and unused features off (§4.3).
const AGENT_ENV = [
  'HOME=/tmp/home', 'CLAUDE_CONFIG_DIR=/cfg',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1', 'DISABLE_AUTOUPDATER=1', 'DISABLE_TELEMETRY=1',
  'DISABLE_ERROR_REPORTING=1', 'ENABLE_CLAUDEAI_MCP_SERVERS=false', 'CLAUDE_CODE_DISABLE_ARTIFACT=1',
];

async function ensureAgentImage() {
  let r = await D.op(['image', 'inspect', '-f', '{{.Id}}', AGENT_IMAGE]);
  if (r.ok) return r.stdout.trim();
  r = await D.op(['build', '-q', '-t', AGENT_IMAGE, path.join(SANDBOX_DIR, 'agent')], { timeoutMs: 20 * 60_000 });
  if (!r.ok) throw Object.assign(new Error(`agent image build failed: ${r.stderr.slice(-500)}`), { code: 'IMAGE_BUILD_FAILED' });
  return r.stdout.trim();
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

module.exports = { runAgent, ensureAgentImage, AGENT_IMAGE, AGENT_ENV };
