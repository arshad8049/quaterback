/**
 * baseline.js — raw coding agent run with no QB pipeline
 *
 * Sends the raw task description directly to the coding agent.
 * No contract, no context package, no repair loop.
 * Uses the same sandboxed invocation and capture as the QB arm (agent/runner.js,
 * QB-02) so both arms are measured the same way and neither runs on the host.
 */

const { runAgentSandboxed } = require('../agent/runner');

/**
 * @param {string} description  - raw task string
 * @param {string} repoPath     - absolute path of the disposable workspace (read-only to the sandbox)
 * @returns {Promise<{ diff, changes, status, duration_ms, error, ... }>}
 */
async function runBaseline(description, repoPath) {
  const t0 = Date.now();
  const r = await runAgentSandboxed(description, repoPath, { timeoutMs: 8 * 60 * 1000 });
  return { ...r, duration_ms: Date.now() - t0 };
}

module.exports = { runBaseline };
