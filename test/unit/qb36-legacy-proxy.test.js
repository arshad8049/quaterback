/**
 * QB-36 — no unauthenticated route may reach a paid upstream API.
 *
 * The legacy Netlify compile proxy forwarded any POST to api.anthropic.com
 * when QB_PROXY_SECRET was unset. It had no remaining callers and was
 * removed; this test keeps it (and any similar proxy) from coming back.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', 'test', 'devudu_docs', 'docs', 'bench']);

function sourceFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...sourceFiles(abs));
    else if (/\.(js|mjs|cjs|ts)$/.test(ent.name)) out.push(abs);
  }
  return out;
}

test('the legacy compile proxy and its routing are gone', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'netlify', 'functions', 'compile.js')));
  const toml = fs.existsSync(path.join(ROOT, 'netlify.toml')) ? fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8') : '';
  assert.ok(!/\[functions\]/.test(toml), 'netlify.toml still deploys functions');
  assert.ok(!/\.netlify\/functions/.test(toml), 'netlify.toml still routes /api to functions');
});

// Files that may name the host only as egress-policy data (QB-02 §4.3: the
// sandbox proxy's allowlist). Each must make no network requests itself.
const POLICY_ONLY = new Set([path.join('lib', 'sandbox', 'egress.js')]);

test('no deployed code forwards requests to the Anthropic API', () => {
  const hits = sourceFiles(ROOT).filter(f => fs.readFileSync(f, 'utf8').includes('api.anthropic.com'));
  const rel = hits.map(f => path.relative(ROOT, f));
  assert.deepEqual(rel.filter(f => !POLICY_ONLY.has(f)), []);
  for (const f of rel.filter(f => POLICY_ONLY.has(f))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(|require\(['"](https?|net|tls|undici)['"]\)/, `${f} must not make network requests`);
  }
});
