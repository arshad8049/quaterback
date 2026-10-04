/**
 * QB-02 step 4 — T-NET on the product images (agent-sandbox.md §4, §11.2).
 * QB_INTEGRATION=1 only. The rebinding / mixed / failover / DNS-exfiltration
 * cases ran in E3 against the same Squid rules (the unit test
 * qb02-sandbox-egress keeps the shipped rules identical); this file checks that
 * the product proxy and agent image deliver that boundary.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const D = require('../../lib/sandbox/docker');
const { startEgress } = require('../../lib/sandbox/egress');
const { ensureAgentImage, AGENT_IMAGE } = require('../../lib/sandbox/agent');
const { createWorkspace, hardened } = require('../../lib/sandbox/workspace');

const ENABLED = process.env.QB_INTEGRATION === '1';
const RUN = `qbnet-${process.pid}`;
let egress, ws, C;

/** Run a shell command inside the untrusted agent container; resolves { code, out }. */
async function inside(cmd) {
  const r = await D.op(['exec', C, 'sh', '-c', cmd], { timeoutMs: 60_000 });
  return { code: r.status, out: (r.stdout + r.stderr).trim() };
}
const connect = (target) => inside(`curl -s -o /dev/null --max-time 15 -w '%{http_connect}' -p -x http://127.0.0.1:8888 ${target}; true`);

describe('T-NET: product proxy + agent image', { skip: !ENABLED && 'set QB_INTEGRATION=1 (needs Docker)' }, () => {
  before(async () => {
    await ensureAgentImage();
    ws = await createWorkspace(RUN);
    egress = await startEgress(RUN, 'INFERENCE');
    C = `${RUN}-agent-probe`;
    const r = await D.op(['run', '-d', '--name', C, ...hardened(RUN, 'workload'), '--network', 'none',
      ...ws.mount('work'), ...egress.mount(), '--entrypoint', 'sh', AGENT_IMAGE, '-c',
      'socat TCP-LISTEN:8888,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/sock/proxy.sock & exec sleep infinity']);
    assert.ok(r.ok, r.stderr);
    await new Promise((res) => setTimeout(res, 1000));
  });
  after(async () => { await D.removeRun(RUN); });

  test('no route except loopback; every non-lo device down', async () => {
    const r = await inside(`v4=$(tail -n +2 /proc/net/route | wc -l); up=0
      for i in /sys/class/net/*; do [ -d "$i" ] || continue; n=\${i##*/}; [ "$n" = lo ] && continue
        [ "$(cat $i/operstate)" = down ] || up=$((up+1)); done; echo "$v4 $up"`);
    assert.equal(r.out, '0 0');
  });

  for (const [name, cmd] of [
    ['direct internet (1.1.1.1:443)', 'curl -s --max-time 5 https://1.1.1.1/ -o /dev/null'],
    ['cloud metadata (169.254.169.254)', 'curl -s --max-time 5 http://169.254.169.254/ -o /dev/null'],
    ['DNS resolution', 'getent hosts example.com'],
  ]) {
    test(`unreachable without the proxy: ${name}`, async () => assert.notEqual((await inside(cmd)).code, 0));
  }

  test('the socket cannot be removed or replaced (read-only mount)', async () => {
    assert.notEqual((await inside('rm -f /sock/proxy.sock')).code, 0);
    assert.notEqual((await inside('touch /sock/evil')).code, 0);
    assert.equal((await inside('[ -S /sock/proxy.sock ]')).code, 0);
  });

  test('CONNECT to the INFERENCE host is allowed', async () => assert.equal((await connect('https://api.anthropic.com/')).out, '200'));

  for (const [name, target] of [
    ['a non-listed host', 'https://example.com/'],
    ['a subdomain of the allowed host', 'https://evil.api.anthropic.com/'],
    ['an IP literal', 'https://1.1.1.1/'],
    ['the OAuth host (excluded from INFERENCE)', 'https://platform.claude.com/'],
    ['the npm registry (DEPS only)', 'https://registry.npmjs.org/'],
    ['the allowed host on port 80', 'http://api.anthropic.com:80/'],
  ]) {
    test(`CONNECT refused: ${name}`, async () => assert.equal((await connect(target)).out, '403'));
  }

  test('the agent container runs as uid 10001, read-only root, no capabilities', async () => {
    assert.equal((await inside('id -u')).out, '10001');
    assert.notEqual((await inside('touch /etc/x')).code, 0);
    assert.match((await inside('grep CapEff /proc/self/status')).out, /CapEff:\s+0+$/);
    const ins = await D.op(['inspect', '-f', '{{.HostConfig.NetworkMode}} {{.HostConfig.Privileged}} {{len .HostConfig.PortBindings}}', C]);
    assert.equal(ins.stdout.trim(), 'none false 0');
  });

  test('managed settings are installed in the image', async () => {
    const r = await inside('cat /etc/claude-code/managed-settings.json');
    assert.match(r.out, /"WebFetch"/);
    assert.match(r.out, /"WebSearch"/);
  });
});
