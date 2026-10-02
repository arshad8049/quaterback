/**
 * QB-02 step 4 — the shipped proxy policy is the one E3 tested (agent-sandbox.md
 * §4.1; E3 gap "the exact tested Squid policy must ship"), and policy rendering
 * accepts only exact hostnames.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { renderPolicy, POLICIES } = require('../../lib/sandbox/egress');

const E3_CONF = path.join(__dirname, '..', '..', 'spikes', 'qb-02', 'e3-network', 'proxy', 'squid.conf');
const rules = (conf) => conf.split('\n').map((l) => l.trim())
  .filter((l) => /^(acl|http_access|http_port|positive_dns_ttl|negative_dns_ttl|cache deny)\b/.test(l));

test('rendered policy has exactly the access rules E3 tested (same allowlist → identical rules)', () => {
  const e3 = fs.readFileSync(E3_CONF, 'utf8');
  const e3Hosts = /acl allowed_hosts dstdomain -n (.+)/.exec(e3)[1].trim().split(/\s+/);
  assert.deepEqual(rules(renderPolicy(e3Hosts)), rules(e3).filter((l) => !l.startsWith('dns_nameservers')));
});

test('INFERENCE allows only api.anthropic.com; DEPS only the npm registry', () => {
  assert.deepEqual(POLICIES.INFERENCE, ['api.anthropic.com']);
  assert.deepEqual(POLICIES.DEPS, ['registry.npmjs.org']);
  assert.match(renderPolicy(POLICIES.INFERENCE), /^acl allowed_hosts dstdomain -n api\.anthropic\.com$/m);
});

for (const bad of ['.anthropic.com', '*.anthropic.com', '1.1.1.1', 'localhost', 'api.anthropic.com\nhttp_access allow all',
  'api.anthropic.com all', 'API.Anthropic.com', 'exa mple.com', '', 'a..b.com']) {
  test(`rejects allowlist entry ${JSON.stringify(bad)}`, () => assert.throws(() => renderPolicy([bad]), /hostname|empty/));
}
