/**
 * preload-ollama.js — `node --require` hook that replaces global.fetch for a
 * whole qb.js process, so the CLI can be driven end-to-end without Ollama
 * or network access.
 *
 *   QB_TEST_OLLAMA_REPLY  JSON string returned as the model's message content
 *   QB_TEST_OLLAMA_SEQUENCE  JSON array of contents, one per /api/chat call in order
 *                         (the last one repeats); takes precedence over QB_TEST_OLLAMA_REPLY
 *   QB_TEST_HANG=1        every fetch never resolves (for interruption tests)
 *   QB_TEST_FETCH_LOG     file to append one line per fetched URL
 *   QB_TEST_PROMPT_LOG    file to append one JSON line per request body (the messages sent)
 */

const fs = require('fs');

let callIndex = 0;
global.fetch = async (url, init = {}) => {
  if (process.env.QB_TEST_FETCH_LOG) fs.appendFileSync(process.env.QB_TEST_FETCH_LOG, String(url) + '\n');
  if (process.env.QB_TEST_PROMPT_LOG && init.body) fs.appendFileSync(process.env.QB_TEST_PROMPT_LOG, String(init.body) + '\n');   // JSON: one line
  if (process.env.QB_TEST_HANG) {
    process.stdout.write('QB_TEST_HANGING\n');
    setInterval(() => {}, 1000);           // a real socket would keep the loop alive
    return new Promise(() => {});
  }
  if (!String(url).includes('/api/chat')) throw new Error(`unexpected network call: ${url}`);
  let content = process.env.QB_TEST_OLLAMA_REPLY || '{}';
  if (process.env.QB_TEST_OLLAMA_SEQUENCE) {
    const seq = JSON.parse(process.env.QB_TEST_OLLAMA_SEQUENCE);
    content = seq[Math.min(callIndex++, seq.length - 1)];
  }
  return {
    ok: true, status: 200, statusText: 'OK',
    json: async () => ({ message: { content } }),
    text: async () => JSON.stringify({ message: { content } }),
  };
};
