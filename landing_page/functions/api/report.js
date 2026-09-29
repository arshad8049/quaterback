export async function onRequestGet({ request, env }) {
  const url    = new URL(request.url);
  const secret = url.searchParams.get('secret');

  if (!secret || secret !== env.ADMIN_SECRET) {
    return Response.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const [signups, runs, summary] = await Promise.all([
    env.DB.prepare(`
      SELECT id, email, agent, created_at, ip, referrer
      FROM submissions
      ORDER BY created_at DESC
    `).all(),

    env.DB.prepare(`
      SELECT email, passed, attempts, duration_ms, repair_count, layers_used, qb_version, created_at
      FROM metrics
      ORDER BY created_at DESC
      LIMIT 500
    `).all(),

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

  return Response.json({
    summary,
    signups:  signups.results,
    metrics:  runs.results,
  }, {
    headers: { 'Content-Type': 'application/json' },
  });
}
