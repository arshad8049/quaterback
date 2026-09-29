export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const secret = url.searchParams.get('secret');
  const format = url.searchParams.get('format') || 'json';

  if (!secret || secret !== env.ADMIN_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const { results } = await env.DB
    .prepare(`
      SELECT id, email, agent, created_at, ip, referrer
      FROM submissions
      ORDER BY created_at DESC
    `)
    .all();

  if (format === 'csv') {
    const header = 'id,email,agent,created_at,ip,referrer\n';
    const rows = results.map(r =>
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

  return Response.json({ count: results.length, signups: results });
}
