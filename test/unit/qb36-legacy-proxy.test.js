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
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const SKIP = new Set(['node_modules', '.git', 'test', 'devudu_docs', 'docs', 'bench']);

// What deploys is what the repository tracks: scan git-tracked source files only,
// so local worktrees (e.g. .claude/worktrees/…), caches and untracked scratch
// never count. Same skips as before.
function sourceFiles() {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean)
    .filter((f) => !f.split('/').some((seg) => SKIP.has(seg)) && /\.(js|mjs|cjs|ts)$/.test(f))
    .map((f) => path.join(ROOT, f));
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
  const hits = sourceFiles().filter(f => fs.readFileSync(f, 'utf8').includes('api.anthropic.com'));
  const rel = hits.map(f => path.relative(ROOT, f));
  assert.deepEqual(rel.filter(f => !POLICY_ONLY.has(f)), []);
  for (const f of rel.filter(f => POLICY_ONLY.has(f))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(src, /\bfetch\s*\(|require\(['"](https?|net|tls|undici)['"]\)/, `${f} must not make network requests`);
  }
});
