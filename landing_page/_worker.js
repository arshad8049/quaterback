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
const FROM       = 'Quarterback Beta <beta@velorallc.com>';
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

// ─── POST /api/metrics ────────────────────────────────────────────────────────

async function handleMetrics(request, env) {
  if (request.method === 'OPTIONS') return cors204();
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) return json({ error: 'email required' }, 400);

  const registered = await env.DB
    .prepare('SELECT id FROM submissions WHERE email = ?')
    .bind(email).first();
  if (!registered) return json({ error: 'Unrecognized email' }, 403);

  await env.DB
    .prepare(`INSERT INTO metrics
      (email, task_hash, passed, attempts, duration_ms, tokens_used, repair_count, layers_used, qb_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      email,
      body.task_hash    || null,
      body.passed       ? 1 : 0,
      body.attempts     || 1,
      body.duration_ms  || null,
      body.tokens_used  || null,
      body.repair_count || 0,
      body.layers_used  || null,
      body.qb_version   || null,
    ).run();

  return json({ ok: true });
}

// ─── GET /api/report ─────────────────────────────────────────────────────────

async function handleReport(request, env) {
  if (!checkSecret(request, env)) return json({ error: 'Unauthorized' }, 403);

  const [signups, runs, summary] = await Promise.all([
    env.DB.prepare(
      'SELECT id, email, agent, created_at, ip, referrer FROM submissions ORDER BY created_at DESC'
    ).all(),
    env.DB.prepare(
      'SELECT email, passed, attempts, duration_ms, repair_count, layers_used, qb_version, created_at FROM metrics ORDER BY created_at DESC LIMIT 500'
    ).all(),
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM submissions)                             AS total_signups,
        COUNT(*)                                                       AS total_runs,
        ROUND(100.0 * SUM(passed) / NULLIF(COUNT(*), 0), 1)           AS pass_rate_pct,
        ROUND(AVG(attempts), 2)                                        AS avg_attempts,
        ROUND(AVG(duration_ms))                                        AS avg_duration_ms,
        ROUND(AVG(repair_count), 2)                                    AS avg_repairs
      FROM metrics
    `).first(),
  ]);

  return json({ summary, signups: signups.results, metrics: runs.results });
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
      Add <code style="font-family:monospace;background:#121615;padding:2px 5px;border-radius:3px;color:#C6CFCB;">--telemetry --beta-email ${escHtml(to)}</code> to share anonymous run metrics. No task descriptions ever leave your machine — only outcome data.
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
    'Access-Control-Allow-Headers': 'Content-Type',
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
