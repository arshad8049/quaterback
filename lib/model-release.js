/**
 * lib/model-release.js — free the local model's memory before the sandbox is admitted (QB-31).
 *
 * The intent, context and judge stages call a local Ollama model, and Ollama keeps it resident
 * after use (default 5 minutes). On CPU deepseek-r1:7b holds about 5.6 GiB, so on a 16 GB host
 * the sandbox admission gate (per-run peak + 2 GiB ≈ 11.1 GiB free) refused every run that had
 * just used the model (Codespaces walkthrough, 2026-10-12). Nothing calls the model while the
 * sandbox runs; the judge reloads it afterwards.
 *
 * Best effort and local only: a model server on another host is never asked (unloading it frees
 * nothing here, and it may be shared), and failures are reported, never thrown — admission still
 * measures the real free memory and refuses with the numbers if it is short.
 */

const DEFAULT_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'deepseek-r1:7b';

function isLocal(url) {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '::1' || /^127\./.test(h);
  } catch { return false; }
}

const sameModel = (want, have) => have === want || have === `${want}:latest` || `${have}:latest` === want;

/**
 * @returns {Promise<{status: 'released'|'skipped_remote'|'failed', detail?: string, ms?: number}>}
 */
async function releaseLocalModel({
  url = process.env.QB_OLLAMA_URL || DEFAULT_URL,
  model = process.env.QB_MODEL || DEFAULT_MODEL,
  fetchImpl = fetch, timeoutMs = 5000, waitMs = 15000, pollMs = 250,
} = {}) {
  if (!isLocal(url)) return { status: 'skipped_remote', detail: `model server ${url} is not on this host` };
  const t0 = Date.now();
  const call = async (p, init) => {
    const res = await fetchImpl(`${url}${p}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`${p} answered ${res.status}`);
    return res.json();
  };
  try {
    // Ollama: a generate request with keep_alive 0 and no prompt unloads the model.
    await call('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }) });
    // The unload is asynchronous; wait until the model is no longer listed as loaded.
    while (Date.now() - t0 < waitMs) {
      const ps = await call('/api/ps', { method: 'GET' });
      const loaded = (Array.isArray(ps.models) ? ps.models : []).some((m) => sameModel(model, m.name || m.model));
      if (!loaded) return { status: 'released', ms: Date.now() - t0 };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { status: 'failed', detail: `${model} still loaded after ${waitMs} ms`, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 'failed', detail: e.message, ms: Date.now() - t0 };
  }
}

module.exports = { releaseLocalModel, isLocal };
