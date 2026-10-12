/**
 * lib/telemetry.js — opt-in run metrics, bounded and non-blocking (QB-21).
 *
 * One POST with a hard deadline (default 3 s): a slow or stalled endpoint is
 * abandoned, never awaited indefinitely, and never fails the user's run.
 */

const DEFAULT_URL = 'https://quaterback.velorallc.workers.dev/api/metrics';

/**
 * QB-33: the endpoint authorizes a verified, revocable telemetry token (Authorization: Bearer),
 * never an email. Without a token nothing is sent.
 * @returns {Promise<{ sent: true } | { sent: false, reason: 'timeout' | 'error' | 'no_token' }>}
 */
async function sendMetrics(data, { url = DEFAULT_URL, timeoutMs = 3000, token } = {}) {
  if (!token) return { sent: false, reason: 'no_token' };
  const ctl = new AbortController();
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { ctl.abort(); resolve({ sent: false, reason: 'timeout' }); }, timeoutMs); });
  try {
    return await Promise.race([
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data), signal: ctl.signal })
        .then((res) => (res.ok ? { sent: true } : { sent: false, reason: 'error' }), () => ({ sent: false, reason: ctl.signal.aborted ? 'timeout' : 'error' })),
      deadline,
    ]);
  } finally { clearTimeout(timer); }
}

module.exports = { sendMetrics, DEFAULT_URL };
