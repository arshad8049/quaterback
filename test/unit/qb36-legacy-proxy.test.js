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

test('no deployed code forwards requests to the Anthropic API', () => {
  const hits = sourceFiles(ROOT).filter(f => fs.readFileSync(f, 'utf8').includes('api.anthropic.com'));
  assert.deepEqual(hits.map(f => path.relative(ROOT, f)), []);
});
