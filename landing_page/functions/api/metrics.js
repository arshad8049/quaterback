export async function onRequestPost({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) {
    return Response.json({ error: 'email required' }, { status: 400 });
  }

  // Only registered beta testers may submit metrics
  const registered = await env.DB
    .prepare('SELECT id FROM submissions WHERE email = ?')
    .bind(email)
    .first();

  if (!registered) {
    return Response.json({ error: 'Unrecognized email' }, { status: 403 });
  }

  await env.DB
    .prepare(`
      INSERT INTO metrics
        (email, task_hash, passed, attempts, duration_ms, tokens_used, repair_count, layers_used, qb_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
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
    )
    .run();

  return Response.json({ ok: true });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
