const RESEND_URL = 'https://api.resend.com/emails';
const FROM       = 'Quarterback Beta <beta@velorallc.com>';
const OWNER      = 'ashaik8.us@gmail.com';

export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  const agent = (body.agent || '').trim() || null;

  if (!email || !email.includes('@') || !email.includes('.')) {
    return Response.json({ error: 'Invalid email' }, { status: 400 });
  }

  // Deduplicate — already signed up
  const existing = await env.DB
    .prepare('SELECT id FROM submissions WHERE email = ?')
    .bind(email)
    .first();

  if (existing) {
    return Response.json({ ok: true, duplicate: true });
  }

  const ip       = request.headers.get('CF-Connecting-IP') || null;
  const referrer = request.headers.get('Referer') || null;

  // Persist signup
  await env.DB
    .prepare('INSERT INTO submissions (email, agent, ip, referrer) VALUES (?, ?, ?, ?)')
    .bind(email, agent, ip, referrer)
    .run();

  // Total count for owner email
  const { count } = await env.DB
    .prepare('SELECT COUNT(*) as count FROM submissions')
    .first();

  // Fire both emails in parallel, never block the response on failure
  await Promise.allSettled([
    sendWelcome(email, env.RESEND_API_KEY),
    sendOwnerNotify(email, agent, count, ip, referrer, env.RESEND_API_KEY),
  ]);

  return Response.json({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

// Catch-all for wrong methods
export async function onRequest({ request }) {
  if (request.method !== 'POST' && request.method !== 'OPTIONS') {
    return Response.json({ error: 'Method not allowed' }, {
      status: 405,
      headers: corsHeaders(),
    });
  }
}

// ─── Email senders ────────────────────────────────────────────────────────────

async function sendWelcome(to, apiKey) {
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0D100F;font-family:'Helvetica Neue',Arial,sans-serif;color:#C6CFCB;">
<div style="max-width:580px;margin:0 auto;padding:48px 32px;">

  <div style="margin-bottom:32px;">
    <span style="font-family:monospace;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#6FBF9F;">Quarterback</span>
    <span style="font-size:13px;color:#4A5652;margin-left:8px;">· by Velora</span>
  </div>

  <h1 style="margin:0 0 20px 0;font-size:28px;font-weight:400;color:#F4F1EA;line-height:1.3;">
    You're on the beta list.
  </h1>

  <p style="margin:0 0 24px 0;font-size:16px;line-height:1.65;color:#9AA5A0;">
    Quarterback is a control loop that runs around your coding agent. You write the intent — it compiles it, supplies your codebase context, watches execution, verifies the result, and repairs failures automatically. You stop correcting. You start accepting.
  </p>

  <div style="margin:32px 0;padding:24px 28px;background:#121615;border:1px solid #262E2B;border-radius:8px;">
    <div style="font-family:monospace;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#E08A4C;margin-bottom:16px;">Early access — try it now</div>
    <p style="margin:0 0 14px 0;font-size:14px;color:#C6CFCB;line-height:1.6;"><strong style="color:#F4F1EA;">1.</strong> Install Ollama + pull the local model</p>
    <pre style="margin:0 0 20px 0;padding:12px 16px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;overflow-x:auto;">brew install ollama
ollama pull deepseek-r1:7b</pre>
    <p style="margin:0 0 14px 0;font-size:14px;color:#C6CFCB;line-height:1.6;"><strong style="color:#F4F1EA;">2.</strong> Clone Quarterback</p>
    <pre style="margin:0 0 20px 0;padding:12px 16px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;overflow-x:auto;">git clone https://github.com/arshad8049/quaterback
cd quaterback &amp;&amp; npm install</pre>
    <p style="margin:0 0 14px 0;font-size:14px;color:#C6CFCB;line-height:1.6;"><strong style="color:#F4F1EA;">3.</strong> Run your first task</p>
    <pre style="margin:0 0 20px 0;padding:12px 16px;background:#0D100F;border:1px solid #1A211E;border-radius:4px;font-size:13px;color:#6FBF9F;overflow-x:auto;">node qb.js "add a getVersion() to src/utils.js" \\
  --repo /path/to/your/repo \\
  --agent claude-code</pre>
    <p style="margin:0 0 0 0;font-size:13px;color:#8A948F;line-height:1.6;">
      No API keys needed. L1–L5 all run locally via Ollama.
    </p>
  </div>

  <div style="margin:28px 0;padding:18px 22px;border:1px solid #2E4F44;border-radius:6px;background:#0A0D0C;">
    <div style="font-family:monospace;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:#6FBF9F;margin-bottom:8px;">Help us improve QB</div>
    <p style="margin:0;font-size:14px;line-height:1.65;color:#8A948F;">
      Add <code style="font-family:monospace;font-size:13px;background:#121615;padding:2px 6px;border-radius:3px;color:#C6CFCB;">--telemetry --beta-email ${escHtml(to)}</code> to share anonymous run metrics (pass rate, attempts, duration). Or set <code style="font-family:monospace;font-size:13px;background:#121615;padding:2px 6px;border-radius:3px;color:#C6CFCB;">QB_BETA_EMAIL=${escHtml(to)}</code> in your environment to make it automatic. No task descriptions are ever sent — only outcome data.
    </p>
  </div>

  <p style="margin:28px 0 0 0;font-size:15px;line-height:1.65;color:#9AA5A0;">
    We'll send cohort onboarding details within a few days. Questions? Reply directly to this email.
  </p>

  <div style="margin-top:48px;padding-top:24px;border-top:1px solid #1A211E;">
    <p style="margin:0;font-size:13px;color:#4A5652;">— Arshad, Velora<br>
    <a href="https://quaterback.velorallc.workers.dev" style="color:#6FBF9F;text-decoration:none;">quaterback.velorallc.workers.dev</a></p>
  </div>

</div>
</body>
</html>`;

  return resend(to, "You're on the Quarterback beta list", html, apiKey);
}

async function sendOwnerNotify(email, agent, count, ip, referrer, apiKey) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0D100F;font-family:monospace;color:#C6CFCB;">
<div style="max-width:500px;margin:0 auto;padding:40px 28px;">
  <div style="margin-bottom:24px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#E08A4C;">new beta signup · qb</div>
  <table style="width:100%;font-size:14px;border-collapse:collapse;">
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;width:100px;">Email</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#F4F1EA;">${escHtml(email)}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">Agent</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${escHtml(agent || 'not specified')}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">Time</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${now}</td></tr>
    <tr><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#8A948F;">IP</td><td style="padding:10px 0;border-bottom:1px solid #1A211E;color:#C6CFCB;">${escHtml(ip || 'unknown')}</td></tr>
    <tr><td style="padding:10px 0;color:#8A948F;">Referrer</td><td style="padding:10px 0;color:#C6CFCB;">${escHtml(referrer || 'direct')}</td></tr>
  </table>
  <div style="margin-top:28px;padding:16px 20px;background:#121615;border:1px solid #262E2B;border-radius:4px;">
    <span style="color:#6FBF9F;font-size:26px;font-weight:700;">${count}</span>
    <span style="color:#8A948F;font-size:14px;margin-left:10px;">total signups</span>
  </div>
</div>
</body>
</html>`;

  return resend(OWNER, `QB beta signup #${count}: ${email} (${agent || 'no agent'})`, html, apiKey);
}

async function resend(to, subject, html, apiKey) {
  if (!apiKey) return; // silently skip if key not configured
  return fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM, to, subject, html }),
  });
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
