/**
 * mocks.js — controlled stand-ins for external services.
 *
 * mockFetch() replaces global.fetch with a scripted responder and records
 * every call, so tests can assert both what a module returned and whether
 * it reached an upstream service at all.
 */

const path = require('path');

/**
 * @param {Function|object} responder - (url, init) => body object, or a fixed body
 * @returns {{ calls: Array, restore: Function }}
 */
function mockFetch(responder) {
  const original = global.fetch;
  const calls = [];

  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const body = typeof responder === 'function' ? await responder(String(url), init) : responder;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  return { calls, restore: () => { global.fetch = original; } };
}

/** Ollama /api/chat response wrapping `content`. */
function ollamaReply(content) {
  return { message: { content: typeof content === 'string' ? content : JSON.stringify(content) } };
}

/** Absolute path to the scripted fake coding agent. */
const FAKE_AGENT = path.join(__dirname, 'fake-agent.js');

module.exports = { mockFetch, ollamaReply, FAKE_AGENT };
