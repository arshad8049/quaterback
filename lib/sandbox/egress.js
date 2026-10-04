/**
 * lib/sandbox/egress.js — the per-run egress proxy Ⓟ (agent-sandbox.md §4).
 *
 * Creates a fresh bridge network (IPv6 off) and a socket volume, renders the
 * Squid policy for one endpoint policy, and starts the hardened proxy. Untrusted
 * containers never join the network: they mount the socket volume read-only.
 */

const fs = require('fs');
const path = require('path');
const D = require('./docker');

const SANDBOX_DIR = path.join(__dirname, '..', '..', 'sandbox');
const PROXY_IMAGE = process.env.QB_SANDBOX_PROXY_IMAGE || D.contentTag('qb-sandbox-proxy', path.join(SANDBOX_DIR, 'proxy'), ['.']);
const TEMPLATE = path.join(SANDBOX_DIR, 'proxy', 'squid.conf.tmpl');

/** Endpoint policies (§4.3). Exact hostnames only. */
const POLICIES = Object.freeze({
  // Mode S/K inference. platform.claude.com (OAuth refresh) is excluded: runs
  // start from a freshly refreshed credential (pre-run refresh, §5.2), and the
  // E1 watch decides whether in-run refresh is ever needed.
  INFERENCE: ['api.anthropic.com'],
  DEPS: ['registry.npmjs.org'],
  // The clean auth container only (login, logout, pre-run refresh): OAuth
  // exchange/refresh plus inference. Never used by a stage with repository code.
  AUTH: ['platform.claude.com', 'claude.ai', 'console.anthropic.com', 'api.anthropic.com'],
});

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** Render the Squid config for an allowlist. Throws on anything that is not a plain hostname. */
function renderPolicy(hosts) {
  if (!hosts.length) throw new Error('empty allowlist');
  for (const h of hosts) {
    if (!HOST_RE.test(h) || /^[0-9.]+$/.test(h)) throw new Error(`not an exact hostname: ${JSON.stringify(h)}`);
  }
  const tmpl = fs.readFileSync(TEMPLATE, 'utf8');
  if (tmpl.split('{{ALLOWED_HOSTS}}').length !== 2) throw new Error('policy template must contain exactly one {{ALLOWED_HOSTS}}');
  return tmpl.replace('{{ALLOWED_HOSTS}}', hosts.join(' '));
}

function ensureProxyImage() {
  return D.ensureImage(PROXY_IMAGE, [path.join(SANDBOX_DIR, 'proxy')], 'proxy');
}

/**
 * Start Ⓟ for a run with the given policy. Returns { sockVolume, mount(), logs(), stop() }.
 * Throws (code INFRA) if the proxy does not come up.
 */
async function startEgress(runId, policyName, { hosts } = {}) {
  const allow = hosts || POLICIES[policyName];
  if (!allow) throw new Error(`unknown egress policy ${policyName}`);
  const conf = renderPolicy(allow);
  const image = await ensureProxyImage();
  const net = `${runId}-egress-${policyName.toLowerCase()}`;
  const sock = `${runId}-sock-${policyName.toLowerCase()}`;
  const proxy = `${runId}-proxy-${policyName.toLowerCase()}`;
  const steps = [
    ['network', 'create', '--driver', 'bridge', '--ipv6=false', ...D.runLabels(runId), net],
    ['volume', 'create', '--driver', 'local', ...D.runLabels(runId), '--opt', 'type=tmpfs', '--opt', 'device=tmpfs', '--opt', 'o=size=1m', sock],
    ['run', '-d', '--name', proxy, ...D.runLabels(runId, 'proxy'), '--network', net,
      '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,size=64m', '--tmpfs', '/run:rw,size=1m',
      '--memory', '256m', '--memory-swap', '256m', '--pids-limit', '512',
      '--log-driver', 'local', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false',
      '-e', `QB_SQUID_CONF=${conf}`, '-v', `${sock}:/sock`, image],
  ];
  for (const s of steps) {
    const r = await D.op(s);
    if (!r.ok) throw Object.assign(new Error(`egress ${s[0]}: ${r.stderr.trim().slice(0, 300)}`), { code: 'INFRA' });
  }
  for (let i = 0; i < 100; i++) {
    const l = await D.op(['logs', proxy]);
    if (/squid up/.test(l.stdout + l.stderr)) {
      return {
        policy: policyName, allow, sockVolume: sock, proxy,
        mount: () => ['-v', `${sock}:/sock:ro`, '-e', 'HTTPS_PROXY=http://127.0.0.1:8888', '-e', 'HTTP_PROXY=http://127.0.0.1:8888'],
        logs: async () => { const r = await D.op(['logs', proxy]); return r.stdout + r.stderr; },
        stop: async () => { await D.op(['rm', '-f', proxy]); await D.op(['network', 'rm', net]); await D.op(['volume', 'rm', '-f', sock]); },
      };
    }
    const st = await D.inspectState(proxy);
    if (st && !st.Running) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const l = await D.op(['logs', proxy]);
  throw Object.assign(new Error(`proxy did not start: ${(l.stdout + l.stderr).slice(-500)}`), { code: 'INFRA' });
}

module.exports = { startEgress, renderPolicy, ensureProxyImage, POLICIES, PROXY_IMAGE };
