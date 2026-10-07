/**
 * Quarterback landing — Cloudflare Worker
 *
 * Handles API routes, then falls through to static assets for everything else.
 * Bindings required (set in Cloudflare dashboard → Workers → Settings):
 *   DB           — D1 database  (qb-beta)
 *   RESEND_API_KEY — secret env var
 *   ADMIN_SECRET   — secret env var
 */

const RESEND_URL = 'https://api.resend.com/emails';
const FROM       = 'Quarterback Beta <onboarding@resend.dev>';
const OWNER      = 'ashaik8.us@gmail.com';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Block direct access to worker source files
    if (url.pathname.startsWith('/functions/') || url.pathname === '/_worker.js') {
      return new Response('Not found', { status: 404 });
    }

    // ── API routes ────────────────────────────────────────────────────────────
    if (url.pathname === '/api/beta-access') {
      return handleBetaAccess(request, env);
    }
    if (url.pathname === '/api/metrics') {
      return handleMetrics(request, env);
    }
    if (url.pathname === '/api/telemetry/request') {
      return handleTelemetryRequest(request, env);
    }
    if (url.pathname === '/api/telemetry/verify') {
      return handleTelemetryVerify(request, env);
    }
    if (url.pathname === '/api/telemetry/revoke') {
      return handleTelemetryRevoke(request, env);
    }
    if (url.pathname === '/api/report') {
      return handleReport(request, env);
    }
    if (url.pathname === '/api/submissions') {
      return handleSubmissions(request, env);
    }

    // ── Static assets fallback ────────────────────────────────────────────────
    return env.ASSETS.fetch(request);
  },
};

// ─── POST /api/beta-access ────────────────────────────────────────────────────

async function handleBetaAccess(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  const agent = (body.agent || '').trim() || null;

  if (!email || !email.includes('@') || !email.includes('.')) {
    return json({ error: 'Invalid email' }, 400);
  }

  // Deduplicate
  const existing = await env.DB
    .prepare('SELECT id FROM submissions WHERE email = ?')
    .bind(email).first();
  if (existing) return json({ ok: true, duplicate: true });

  const ip       = request.headers.get('CF-Connecting-IP') || null;
  const referrer = request.headers.get('Referer') || null;

  await env.DB
    .prepare('INSERT INTO submissions (email, agent, ip, referrer) VALUES (?, ?, ?, ?)')
    .bind(email, agent, ip, referrer).run();

  const { count } = await env.DB
    .prepare('SELECT COUNT(*) as count FROM submissions').first();

  await Promise.allSettled([
    sendWelcome(email, env.RESEND_API_KEY),
    sendOwnerNotify(email, agent, count, ip, referrer, env.RESEND_API_KEY),
  ]);

  return json({ ok: true });
}

// ─── Telemetry credentials (QB-33) ────────────────────────────────────────────
//
// A registered email alone authorizes nothing. To send metrics a user proves control of the
// email: POST /api/telemetry/request mails a one-time link (expires in 30 min); opening it
// (GET /api/telemetry/verify?code=…) issues a revocable token, shown once, scoped to
// `metrics:write`. Only sha256 hashes of codes and tokens are stored. POST
// /api/telemetry/revoke (with the token) revokes it.

const TOKEN_PREFIX = 'qbt_';
const CODE_TTL_MS = 30 * 60 * 1000;
const MAX_CODE_REQUESTS_PER_HOUR = 3;
const MAX_METRICS_PER_HOUR = 60;
const MAX_METRICS_BODY_BYTES = 4096;
const SITE = 'https://quaterback.velorallc.workers.dev';

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes = 32) {
  const a = new Uint8Array(bytes); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const isoIn = (ms) => new Date(Date.now() + ms).toISOString();
const hourAgo = () => new Date(Date.now() - 3600 * 1000).toISOString();

/** Read a JSON body with a hard size limit. Returns { body } or { error, status }. */
async function boundedJson(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return { error: 'Payload too large', status: 413 };
  let text;
  try { text = await request.text(); } catch { return { error: 'Unreadable body', status: 400 }; }
  if (new TextEncoder().encode(text).length > maxBytes) return { error: 'Payload too large', status: 413 };
  try { return { body: JSON.parse(text) }; } catch { return { error: 'Invalid JSON', status: 400 }; }
}

async function handleTelemetryRequest(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const r = await boundedJson(request, 1024);
  if (r.error) return json({ error: r.error }, r.status);
  const email = r.body && typeof r.body.email === 'string' ? r.body.email.trim().toLowerCase() : '';
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Invalid email' }, 400);
  // The same answer whether or not the email is registered (no enumeration).
  const accepted = json({ ok: true, message: 'If this email is registered, a one-time link has been sent.' }, 202);
  const registered = await env.DB.prepare('SELECT id FROM submissions WHERE email = ?').bind(email).first();
  if (!registered) return accepted;
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM telemetry_verifications WHERE email = ? AND created_at > ?').bind(email, hourAgo()).first();
  if (recent && recent.n >= MAX_CODE_REQUESTS_PER_HOUR) return json({ error: 'Too many requests' }, 429);
  const code = randomHex(32);
  await env.DB.prepare('INSERT INTO telemetry_verifications (code_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(code), email, new Date().toISOString(), isoIn(CODE_TTL_MS)).run();
  await sendTelemetryLink(email, `${SITE}/api/telemetry/verify?code=${code}`, env.RESEND_API_KEY);
  return accepted;
}

async function handleTelemetryVerify(request, env) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const code = new URL(request.url).searchParams.get('code') || '';
  if (!/^[0-9a-f]{64}$/.test(code)) return json({ error: 'Invalid or expired link' }, 400);
  const row = await env.DB.prepare('SELECT id, email, expires_at, used_at FROM telemetry_verifications WHERE code_hash = ?').bind(await sha256Hex(code)).first();
  if (!row || row.used_at || row.expires_at < new Date().toISOString()) return json({ error: 'Invalid or expired link' }, 400);
  // One use: mark used only if still unused (a concurrent second click gets nothing).
  const used = await env.DB.prepare('UPDATE telemetry_verifications SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(new Date().toISOString(), row.id).run();
  if (!used.meta || used.meta.changes !== 1) return json({ error: 'Invalid or expired link' }, 400);
  const token = `${TOKEN_PREFIX}${randomHex(32)}`;
  await env.DB.prepare('INSERT INTO telemetry_tokens (token_hash, email, scope, created_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), row.email, 'metrics:write', new Date().toISOString()).run();
  return new Response(JSON.stringify({ ok: true, token, scope: 'metrics:write',
    note: 'Shown once. Set QB_TELEMETRY_TOKEN to this value. Revoke: POST /api/telemetry/revoke with Authorization: Bearer <token>.' }), {
    status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** The token row for a request's bearer token with `scope`, or null. */
async function bearer(request, env, scope) {
  const m = /^Bearer\s+(qbt_[0-9a-f]{64})$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  const row = await env.DB.prepare('SELECT id, email, scope, revoked_at FROM telemetry_tokens WHERE token_hash = ?').bind(await sha256Hex(m[1])).first();
  if (!row || row.revoked_at || row.scope !== scope) return null;
  return row;
}

async function handleTelemetryRevoke(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const tok = await bearer(request, env, 'metrics:write');
  if (!tok) return json({ error: 'Unauthorized' }, 401);
  await env.DB.prepare('UPDATE telemetry_tokens SET revoked_at = ? WHERE id = ?').bind(new Date().toISOString(), tok.id).run();
  return json({ ok: true, revoked: true });
}

// ─── POST /api/metrics (QB-33) ────────────────────────────────────────────────
//
// Authorization: a verified, unrevoked `metrics:write` token — never an email.
// The body is validated strictly: only known fields, exact types, bounds; a run id is
// accepted once (replay protection); at most MAX_METRICS_PER_HOUR per token. Every row is
// stored as `client_reported`: it is what a client says, not an independently verified result.

const LAYERS_RE = /^L[1-5](,L[1-5]){0,4}$/;
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const METRIC_FIELDS = {
  run_id:       (v) => typeof v === 'string' && RUN_ID_RE.test(v),
  passed:       (v) => typeof v === 'boolean',
  attempts:     (v) => Number.isInteger(v) && v >= 1 && v <= 20,
  duration_ms:  (v) => Number.isInteger(v) && v >= 0 && v <= 24 * 3600 * 1000,
  repair_count: (v) => Number.isInteger(v) && v >= 0 && v <= 19,
  layers_used:  (v) => typeof v === 'string' && LAYERS_RE.test(v) && new Set(v.split(',')).size === v.split(',').length,
  qb_version:   (v) => typeof v === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(v),
};
const REQUIRED_METRICS = ['run_id', 'passed', 'attempts', 'duration_ms', 'repair_count', 'qb_version'];

/** Validation errors for a metrics body (empty = valid). */
function metricsErrors(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['body must be a JSON object'];
  const errors = [];
  for (const k of Object.keys(b)) if (!METRIC_FIELDS[k]) errors.push(`unknown field: ${k}`);
  for (const k of REQUIRED_METRICS) if (!(k in b)) errors.push(`missing field: ${k}`);
  for (const [k, ok] of Object.entries(METRIC_FIELDS)) if (k in b && !ok(b[k])) errors.push(`invalid ${k}`);
  if (!errors.length && b.repair_count > b.attempts - 1) errors.push('repair_count exceeds attempts - 1');
  return errors;
}

async function handleMetrics(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const tok = await bearer(request, env, 'metrics:write');
  if (!tok) return json({ error: 'Unauthorized: a verified telemetry token is required (an email is not a credential)' }, 401);
  const r = await boundedJson(request, MAX_METRICS_BODY_BYTES);
  if (r.error) return json({ error: r.error }, r.status);
  const errors = metricsErrors(r.body);
  if (errors.length) return json({ error: 'Invalid metrics', details: errors }, 400);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM client_metrics WHERE token_id = ? AND created_at > ?').bind(tok.id, hourAgo()).first();
  if (recent && recent.n >= MAX_METRICS_PER_HOUR) return json({ error: 'Too many requests' }, 429);
  const b = r.body;
  try {
    await env.DB.prepare(`INSERT INTO client_metrics
      (run_id, token_id, passed, attempts, duration_ms, repair_count, layers_used, qb_version, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'client_reported', ?)`)
      .bind(b.run_id, tok.id, b.passed ? 1 : 0, b.attempts, b.duration_ms, b.repair_count, b.layers_used ?? null, b.qb_version, new Date().toISOString()).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) return json({ error: 'Duplicate run_id' }, 409);
    throw e;
  }
  return json({ ok: true, source: 'client_reported' });
}

// ─── GET /api/report ─────────────────────────────────────────────────────────

async function handleReport(request, env) {
  if (!checkSecret(request, env)) return json({ error: 'Unauthorized' }, 403);

  const [signups, runs, summary] = await Promise.all([
    env.DB.prepare(
      'SELECT id, email, agent, created_at, ip, referrer FROM submissions ORDER BY created_at DESC'
    ).all(),
    env.DB.prepare(
      'SELECT run_id, passed, attempts, duration_ms, repair_count, layers_used, qb_version, source, created_at FROM client_metrics ORDER BY created_at DESC LIMIT 500'
    ).all(),
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions)                             AS total_signups,
        COUNT(*)                                                       AS total_runs,
        ROUND(100.0 * SUM(passed) / NULLIF(COUNT(*), 0), 1)           AS pass_rate_pct,
        ROUND(AVG(attempts), 2)                                        AS avg_attempts,
        ROUND(AVG(duration_ms))                                        AS avg_duration_ms,
        ROUND(AVG(repair_count), 2)                                    AS avg_repairs
      FROM client_metrics
    `).first(),
  ]);

  // QB-33: these numbers are what clients reported — never independently verified results.
  return json({
    client_reported: {
      label: 'Client-reported run outcomes (authenticated, schema-validated, NOT independently verified). Not benchmark evidence.',
      summary, metrics: runs.results,
    },
    signups: signups.results,
  });
}

// ─── GET /api/submissions ────────────────────────────────────────────────────

async function handleSubmissions(request, env) {
  if (!checkSecret(request, env)) return json({ error: 'Unauthorized' }, 403);
  const fmt = new URL(request.url).searchParams.get('format') || 'json';

  const { results } = await env.DB
    .prepare('SELECT id, email, agent, created_at, ip, referrer FROM submissions ORDER BY created_at DESC')
    .all();

  if (fmt === 'csv') {
    const header = 'id,email,agent,created_at,ip,referrer\n';
    const rows   = results.map(r =>
      [r.id, r.email, r.agent ?? '', r.created_at, r.ip ?? '', r.referrer ?? '']
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');
    return new Response(header + rows, {
      headers: {
        'Content-Type': 'text/csv',
        'Content-Disposition': 'attachment; filename="qb-beta-signups.csv"',
      },
    });
  }

  return json({ count: results.length, signups: results });
}

// ─── Email helpers ────────────────────────────────────────────────────────────

async function sendWelcome(to, apiKey) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0D100F;font-family:'Helvetica Neue',Arial,sans-serif;color:#C6CFCB;">
<div style="max-width:580px;margin:0 auto;padding:48px 32px;">
  <div style="margin-bottom:32px;">
    <span style="font-family:monospace;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#6FBF9F;">Quarterback</span>
    <span style="font-size:13px;color:#4A5652;margin-left:8px;">· by Velora</span>
  </div>
  <h1 style="margin:0 0 20px 0;font-size:28px;font-weight:400;color:#F4F1EA;line-height:1.3;">You're on the beta list.</h1>
  <p style="margin:0 0 24px 0;font-size:16px;line-height:1.65;color:#9AA5A0;">
    Quarterback is a control loop that runs around your coding agent. You write the intent — it compiles it, supplies your codebase context, watches execution, verifies the result, and repairs failures automatically. You stop correcting. You start accepting.
  </p>
  <div style="margin:32px 0;padding:24px 28px;background:#121615;border:1px solid #262E2B;border-radius:8px;">
    <div style="font-family:monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#E08A4C;margin-bottom:16px;">Early access — try it now</div>
    <p style="margin:0 0 10px 0;font-size:14px;color:#C6CFCB;"><strong style="color:#F4F1EA;">1.</strong> Install Ollama</p>
    <pre style="margin:0 0 18px 0;padding:10px 14px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;">brew install ollama &amp;&amp; ollama pull deepseek-r1:7b</pre>
    <p style="margin:0 0 10px 0;font-size:14px;color:#C6CFCB;"><strong style="color:#F4F1EA;">2.</strong> Clone &amp; install</p>
    <pre style="margin:0 0 18px 0;padding:10px 14px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;">git clone https://github.com/arshad8049/quaterback
cd quaterback &amp;&amp; npm install</pre>
    <p style="margin:0 0 10px 0;font-size:14px;color:#C6CFCB;"><strong style="color:#F4F1EA;">3.</strong> Run your first task</p>
    <pre style="margin:0 0 16px 0;padding:10px 14px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;">node qb.js "add getVersion() to src/utils.js" \\
  --repo /path/to/repo --agent claude-code</pre>
    <p style="margin:0;font-size:13px;color:#8A948F;">No API keys needed. Everything runs locally via Ollama.</p>
  </div>
  <div style="margin:28px 0;padding:18px 22px;border:1px solid #2E4F44;border-radius:6px;background:#0A0D0C;">
    <div style="font-family:monospace;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#6FBF9F;margin-bottom:8px;">Help us improve QB</div>
    <p style="margin:0;font-size:14px;line-height:1.65;color:#8A948F;">
      Telemetry is off unless you turn it on. To share run outcome metrics, request a telemetry token (we email you a one-time link), then run with <code style="font-family:monospace;background:#121615;padding:2px 5px;border-radius:3px;color:#C6CFCB;">--telemetry</code> and <code style="font-family:monospace;background:#121615;padding:2px 5px;border-radius:3px;color:#C6CFCB;">QB_TELEMETRY_TOKEN</code> set. It sends pass/fail, attempts, duration, repair count, layers and the QB version, tied to your token.
    </p>
  </div>
  <p style="margin:28px 0 0 0;font-size:15px;line-height:1.65;color:#9AA5A0;">
    We'll send cohort onboarding details within a few days. Reply to this email with any questions.
  </p>
  <div style="margin-top:40px;padding-top:22px;border-top:1px solid #1A211E;">
    <p style="margin:0;font-size:13px;color:#4A5652;">— Arshad, Velora<br>
    <a href="https://quaterback.velorallc.workers.dev" style="color:#6FBF9F;text-decoration:none;">quaterback.velorallc.workers.dev</a></p>
  </div>
</div></body></html>`;
  return resendSend(to, "You're on the Quarterback beta list", html, apiKey);
}

async function sendTelemetryLink(to, link, apiKey) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0D100F;font-family:'Helvetica Neue',Arial,sans-serif;color:#C6CFCB;">
<div style="max-width:560px;margin:0 auto;padding:40px 28px;">
  <p style="font-size:15px;line-height:1.6;">Someone asked for a Quarterback telemetry token for this email. If it was you, open this link within 30 minutes. It works once and shows your token once:</p>
  <p style="font-size:14px;word-break:break-all;"><a href="${escHtml(link)}" style="color:#6FBF9F;">${escHtml(link)}</a></p>
  <p style="font-size:13px;color:#8A948F;">If you did not ask for this, ignore this email; nothing is enabled without the link.</p>
</div></body></html>`;
  return resendSend(to, 'Your Quarterback telemetry link', html, apiKey);
}

async function sendOwnerNotify(email, agent, count, ip, referrer, apiKey) {
  const now  = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0D100F;font-family:monospace;color:#C6CFCB;">
<div style="max-width:480px;margin:0 auto;padding:40px 28px;">
  <div style="margin-bottom:24px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#E08A4C;">new beta signup · qb</div>
  <table style="width:100%;font-size:14px;border-collapse:collapse;">
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;width:90px;">Email</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#F4F1EA;">${escHtml(email)}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">Agent</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${escHtml(agent || 'not specified')}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">Time</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${now}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">IP</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${escHtml(ip || 'unknown')}</td></tr>
    <tr><td style="padding:10px 0;color:#8A948F;">Referrer</td><td style="padding:10px 0;color:#C6CFCB;">${escHtml(referrer || 'direct')}</td></tr>
  </table>
  <div style="margin-top:28px;padding:16px 20px;background:#121615;border:1px solid #262E2B;border-radius:4px;">
    <span style="color:#6FBF9F;font-size:26px;font-weight:700;">${count}</span>
    <span style="color:#8A948F;font-size:14px;margin-left:10px;">total signups</span>
  </div>
</div></body></html>`;
  return resendSend(OWNER, `QB beta signup #${count}: ${email} (${agent || 'no agent'})`, html, apiKey);
}

async function resendSend(to, subject, html, apiKey) {
  if (!apiKey) return;
  return fetch(RESEND_URL, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ from: FROM, to, subject, html }),
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsObject() },
  });
}

function cors204() {
  return new Response(null, { status: 204, headers: corsObject() });
}

function corsObject() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function checkSecret(request, env) {
  const secret = new URL(request.url).searchParams.get('secret');
  return secret && secret === env.ADMIN_SECRET;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
