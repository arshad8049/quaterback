#!/usr/bin/env node
/**
 * scripts/smoke.js — post-deploy smoke checks for the one canonical deployment (QB-37):
 * Cloudflare Workers (wrangler.toml: landing_page/_worker.js + landing_page static assets).
 *
 *   node scripts/smoke.js [base-url]      default https://quaterback.velorallc.workers.dev
 *
 * Every check is NON-DESTRUCTIVE: it never creates a signup, a telemetry token, a metric or
 * an email. It proves each public route is wired to the worker (not a stale static file or
 * another platform) and fails closed: static pages, every API route, admin auth refusals,
 * input validation, and that server-only files are not served.
 * Exit code 0 = all passed; 1 = a failure (each listed).
 */

const DEFAULT_BASE = 'https://quaterback.velorallc.workers.dev';

const CHECKS = [
  ['GET / serves the landing page', 'GET', '/', {}, (r, t) => r.status === 200 && /<html/i.test(t) && /Quarterback/.test(t)],
  ['GET /privacy.html serves the privacy page', 'GET', '/privacy.html', {}, (r, t) => r.status === 200 && /Privacy Policy/.test(t)],
  ['GET /robots.txt', 'GET', '/robots.txt', {}, (r) => r.status === 200],
  ['the worker source is not served', 'GET', '/_worker.js', {}, (r) => r.status === 404],
  ['the database schema is not served', 'GET', '/schema.sql', {}, (r) => r.status === 404],
  ['migrations are not served', 'GET', '/migrations/0002_qb33_telemetry_auth.sql', {}, (r) => r.status === 404],
  ['legacy Pages functions are not served', 'GET', '/functions/api/metrics.js', {}, (r) => r.status === 404],
  ['signup: CORS preflight', 'OPTIONS', '/api/beta-access', {}, (r) => r.status === 204],
  ['signup: invalid input is a defined 400 (nothing stored)', 'POST', '/api/beta-access', { json: { email: null } }, (r) => r.status === 400],
  ['signup: GET is 405', 'GET', '/api/beta-access', {}, (r) => r.status === 405],
  ['metrics: no token is 401', 'POST', '/api/metrics', { json: { email: 'smoke@example.invalid' } }, (r) => r.status === 401],
  ['telemetry: a bad verification code is 400', 'GET', `/api/telemetry/verify?code=${'0'.repeat(64)}`, {}, (r) => r.status === 400],
  ['telemetry: revoke without a token is 401', 'POST', '/api/telemetry/revoke', {}, (r) => r.status === 401],
  ['telemetry: delete without a token is 401', 'POST', '/api/telemetry/delete', {}, (r) => r.status === 401],
  ['admin report: no credentials is 401, no-store, no data', 'GET', '/api/report', {}, (r, t) => r.status === 401 && /no-store/.test(r.headers.get('cache-control') || '') && !/@/.test(t)],
  ['admin report: a URL secret is refused (400)', 'GET', '/api/report?secret=smoke', {}, (r) => r.status === 400],
  ['admin export: no credentials is 401', 'GET', '/api/submissions?format=csv', {}, (r, t) => r.status === 401 && !/@/.test(t)],
];

async function smoke(base = DEFAULT_BASE, { fetchImpl = fetch } = {}) {
  const results = [];
  for (const [name, method, p, o, ok] of CHECKS) {
    try {
      const init = { method, headers: {}, redirect: 'manual' };
      if (o.json !== undefined) { init.body = JSON.stringify(o.json); init.headers['Content-Type'] = 'application/json'; }
      const r = await fetchImpl(new URL(p, base).href, init);
      const t = await r.text();
      results.push({ name, pass: Boolean(ok(r, t)), status: r.status });
    } catch (e) { results.push({ name, pass: false, error: String(e && e.message || e) }); }
  }
  return { base, passed: results.every((x) => x.pass), results };
}

if (require.main === module) {
  smoke(process.argv[2] || DEFAULT_BASE).then((s) => {
    for (const r of s.results) console.log(`${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.pass ? '' : ` (${r.status ?? r.error})`}`);
    console.log(s.passed ? `\nall ${s.results.length} smoke checks passed against ${s.base}` : `\nSMOKE FAILED against ${s.base}`);
    process.exit(s.passed ? 0 : 1);
  });
}

module.exports = { smoke, CHECKS, DEFAULT_BASE };
