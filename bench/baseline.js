/**
 * baseline.js — raw coding agent run with no QB pipeline
 *
 * Sends the raw task description directly to the coding agent.
 * No contract, no context package, no repair loop.
 * Uses the same sandboxed invocation and capture as the QB arm (agent/runner.js,
 * QB-02) so both arms are measured the same way and neither runs on the host.
 */

const { runAgentSandboxed, executionGate } = require('../agent/runner');

/**
 * @param {string} description  - raw task string
 * @param {string} repoPath     - absolute path of the disposable workspace (read-only to the sandbox)
 * @param {object} o
 * @param {object} o.contract   - the contract both arms are graded against; the baseline
 *                                runs only through the same execution gate (QB-13) and is
 *                                checked with the same approved executable checks (QB-16)
 * @param {boolean} [o.exploration] - the explicit unapproved mode (never PASS)
 * @returns {Promise<{ diff, changes, status, duration_ms, error, ... }>}
 */
async function runBaseline(description, repoPath, { contract, exploration = false, runSandboxed } = {}) {
  const t0 = Date.now();
  const gate = executionGate(contract, { agent: 'claude-code', exploration });
  if (gate) {
    return { status: 'blocked', error: gate, diff: null, changes: [], unsupported_changes: [], duration_ms: Date.now() - t0 };
  }
  const r = await runAgentSandboxed(description, repoPath, { timeoutMs: 8 * 60 * 1000, runSandboxed,
    checks: Array.isArray(contract?.checks) ? contract.checks : [] });
  return { ...r, duration_ms: Date.now() - t0 };
}

module.exports = { runBaseline };
