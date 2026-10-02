/**
 * preload-ollama.js — `node --require` hook that replaces global.fetch for a
 * whole qb.js process, so the CLI can be driven end-to-end without Ollama
 * or network access.
 *
 *   QB_TEST_OLLAMA_REPLY  JSON string returned as the model's message content
 *   QB_TEST_HANG=1        every fetch never resolves (for interruption tests)
 *   QB_TEST_FETCH_LOG     file to append one line per fetched URL
 */

const fs = require('fs');

global.fetch = async (url) => {
  if (process.env.QB_TEST_FETCH_LOG) fs.appendFileSync(process.env.QB_TEST_FETCH_LOG, String(url) + '\n');
  if (process.env.QB_TEST_HANG) {
    process.stdout.write('QB_TEST_HANGING\n');
    setInterval(() => {}, 1000);           // a real socket would keep the loop alive
    return new Promise(() => {});
  }
  if (!String(url).includes('/api/chat')) throw new Error(`unexpected network call: ${url}`);
  const content = process.env.QB_TEST_OLLAMA_REPLY || '{}';
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ message: { content } }),
    text: async () => JSON.stringify({ message: { content } }),
  };
};
