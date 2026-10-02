/**
 * QB-01 audit guard: Quarterback source starts subprocesses only through
 * lib/proc.js (argv, shell:false). Any exec/execSync or `shell: true`
 * outside that module fails this test.
 */

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('fs');
const path     = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = ['qb.js', 'lib', 'run', 'intent', 'context', 'agent', 'verify', 'memory', 'bench'];
const SKIP = new Set(['node_modules', 'fixtures', 'results']);
const ALLOWED = new Set([path.join('lib', 'proc.js')]);

function walk(p, out = []) {
  const st = fs.statSync(p);
  if (st.isFile()) { if (p.endsWith('.js')) out.push(p); return out; }
  for (const name of fs.readdirSync(p)) if (!SKIP.has(name)) walk(path.join(p, name), out);
  return out;
}

test('no shell-string subprocess calls outside lib/proc.js', () => {
  const offenders = [];
  for (const d of DIRS) {
    for (const file of walk(path.join(ROOT, d))) {
      const rel = path.relative(ROOT, file);
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(file, 'utf8');
      if (/\bexecSync\s*\(|\bexec\s*\(\s*['"`]|shell\s*:\s*true|require\(['"]child_process['"]\)/.test(src)) offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
