// QB check runner (QB-16), sandbox stage ⑥. Trusted code; runs the contract's
// registry-validated checks (verify/checks/registry.js, qb-checks/1) against the
// candidate in /verify, with no network. It never evaluates text from the
// contract: each check is an adapter name plus JSON parameters.
//
//   stdin   {"root": "/verify", "checks": [{ id, ac_id, adapter, params }]}
//   output  /out/qb-checks.json  {"format":"qb-check-results/1","results":[…],"complete":true}
//
// Each check runs in its own child process (`node qb-check-runner.mjs --child`)
// with a timeout; the child reports on a stdout line prefixed with a random
// nonce it received on stdin, so ordinary output from the code under test is
// never mistaken for a result. This prevents accidental collisions only: code
// under test shares the child and the container and could tamper deliberately
// (grader isolation is a separate, deferred item — docs/verify/executable-checks.md).

import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual, inspect } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const OUT = process.env.QB_CHECK_RESULTS || '/out/qb-checks.json';
const TIMEOUT_MS = Number(process.env.QB_CHECK_TIMEOUT_MS || 10_000);
const show = (v) => inspect(v, { depth: 4, breakLength: Infinity, maxStringLength: 300 }).slice(0, 600);

async function child() {
  const { nonce, root, check } = JSON.parse(readFileSync(0, 'utf8'));
  const report = (r) => { process.stdout.write(`\n${nonce}${JSON.stringify(r)}\n`); process.exit(0); };
  try {
    const { module: mod, export: name } = check.params;
    const realRoot = realpathSync(root);
    const file = realpathSync(path.resolve(realRoot, mod));
    if (!file.startsWith(realRoot + path.sep)) return report({ status: 'error', detail: 'module resolves outside the repository' });
    const ns = await import(pathToFileURL(file).href);
    const target = name === 'default' ? ns.default : (name in ns ? ns[name] : ns.default?.[name]);
    if (check.adapter === 'module_exports') {
      const type = target === null ? 'null' : Array.isArray(target) ? 'array' : typeof target;
      return report(type === check.params.type
        ? { status: 'pass', detail: `${mod} exports ${name} (${type})` }
        : { status: 'fail', detail: `${mod} export ${name} is ${type}, expected ${check.params.type}`, observed: type });
    }
    if (typeof target !== 'function') return report({ status: 'fail', detail: `${mod} export ${name} is not a function`, observed: typeof target });
    if (check.adapter === 'call_returns') {
      let value;
      try { value = await target(...check.params.args); }
      catch (e) { return report({ status: 'fail', detail: `${name}(…) threw: ${String(e && e.message || e).slice(0, 300)}` }); }
      return report(isDeepStrictEqual(value, check.params.expect)
        ? { status: 'pass', detail: `${name}(…) returned the expected value`, observed: show(value) }
        : { status: 'fail', detail: `${name}(…) returned ${show(value)}, expected ${show(check.params.expect)}`, observed: show(value) });
    }
    if (check.adapter === 'call_sequence') {
      // QB-14: instances, then method calls in order; every step with `expect` must match.
      const inst = {};
      for (const [k, spec] of Object.entries(check.params.instances)) {
        try { inst[k] = spec.construct === 'new' ? new target(...spec.args) : await target(...spec.args); }
        catch (e) { return report({ status: 'fail', detail: `creating instance ${k} threw: ${String(e && e.message || e).slice(0, 200)}` }); }
      }
      for (const [i, st] of check.params.steps.entries()) {
        const o = inst[st.on];
        if (!o || typeof o[st.method] !== 'function') return report({ status: 'fail', detail: `step ${i}: ${st.on}.${st.method} is not a function` });
        let v;
        try { v = await o[st.method](...st.args); }
        catch (e) { return report({ status: 'fail', detail: `step ${i}: ${st.on}.${st.method}(…) threw: ${String(e && e.message || e).slice(0, 200)}` }); }
        if (st.expect !== undefined && !isDeepStrictEqual(v, st.expect)) {
          return report({ status: 'fail', detail: `step ${i}: ${st.on}.${st.method}(…) returned ${show(v)}, expected ${show(st.expect)}`, observed: show(v) });
        }
      }
      return report({ status: 'pass', detail: `${check.params.steps.length} step(s) on ${Object.keys(inst).length} instance(s) matched` });
    }
    if (check.adapter === 'call_throws') {
      try { const v = await target(...check.params.args); return report({ status: 'fail', detail: `${name}(…) returned ${show(v)} instead of throwing` }); }
      catch (e) {
        const msg = String(e && e.message || e);
        const want = check.params.message_includes;
        return report(!want || msg.includes(want)
          ? { status: 'pass', detail: `${name}(…) threw: ${msg.slice(0, 200)}` }
          : { status: 'fail', detail: `${name}(…) threw "${msg.slice(0, 200)}", expected a message including "${want}"` });
      }
    }
    return report({ status: 'error', detail: `unknown adapter ${check.adapter}` });
  } catch (e) {
    return report({ status: 'error', detail: `could not load or run the check: ${String(e && e.message || e).slice(0, 300)}` });
  }
}

function runOne(root, check) {
  return new Promise((resolve) => {
    const nonce = `QBCHECK-${randomBytes(16).toString('hex')}:`;
    const t0 = Date.now();
    const p = spawn(process.execPath, [SELF, '--child'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME || '/tmp', NODE_ENV: 'test' } });
    let out = '';
    let timedOut = false;
    p.stdout.on('data', (d) => { if (out.length < 1 << 20) out += d; });
    p.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT_MS);
    p.on('close', (code) => {
      clearTimeout(timer);
      const base = { id: check.id, ac_id: check.ac_id, adapter: check.adapter, duration_ms: Date.now() - t0 };
      if (timedOut) return resolve({ ...base, status: 'error', detail: `timed out after ${TIMEOUT_MS} ms` });
      const line = out.split('\n').reverse().find((l) => l.startsWith(nonce));
      let r = null;
      try { r = line ? JSON.parse(line.slice(nonce.length)) : null; } catch { r = null; }
      if (!r || !['pass', 'fail', 'error'].includes(r.status)) return resolve({ ...base, status: 'error', detail: `no result (exit ${code})` });
      resolve({ ...base, status: r.status, detail: String(r.detail || '').slice(0, 800), ...(r.observed !== undefined ? { observed: String(r.observed).slice(0, 600) } : {}) });
    });
    p.stdin.end(JSON.stringify({ nonce, root, check }));
  });
}

// Same canonical JSON as verify/checks/registry.js checkSetHash (keys sorted, arrays in order).
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
    : JSON.stringify(v === undefined ? null : v));

async function main() {
  const { root, checks } = JSON.parse(readFileSync(0, 'utf8'));
  const check_set_hash = createHash('sha256').update(canon(checks)).digest('hex');
  const results = [];
  for (const check of checks) {
    const r = await runOne(root, check);
    results.push(r);
    process.stdout.write(`${r.status.toUpperCase().padEnd(5)} ${r.id} (${r.adapter}, ${r.ac_id}) ${r.detail}\n`);
  }
  writeFileSync(OUT, JSON.stringify({ format: 'qb-check-results/1', check_set_hash, results, complete: true }) + '\n');
}

if (process.argv.includes('--child')) child(); else main();
