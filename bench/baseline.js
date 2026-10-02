/**
 * baseline.js — raw coding agent run with no QB pipeline
 *
 * Sends the raw task description directly to the coding agent.
 * No contract, no context package, no repair loop.
 * Uses the same invocation and change capture as the QB arm (agent/runner.js)
 * so both arms are measured the same way.
 */

const { runAgentCaptured } = require('../agent/runner');

/**
 * @param {string} description  - raw task string
 * @param {string} repoPath     - absolute path of the disposable workspace
 * @returns {{ diff, changes, status, duration_ms, error, ... }}
 */
function runBaseline(description, repoPath) {
  const t0 = Date.now();
  const r = runAgentCaptured(description, repoPath, { timeoutMs: 8 * 60 * 1000 });
  return { ...r, duration_ms: Date.now() - t0 };
}

module.exports = { runBaseline };
