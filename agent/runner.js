const { randomUUID } = require('crypto');
const { ExecutionResultSchema } = require('./schema');
const { runSandboxed } = require('../lib/sandbox/pipeline');

/**
 * Execute the briefing against a coding agent (or dry-run).
 *
 * The coding agent runs only inside the QB sandbox (QB-02, docs/security/
 * agent-sandbox.md): a disposable workspace seeded from a read-only copy of the
 * checkout, no network except the inference proxy, changes captured by trusted
 * code. There is no host-execution path and no environment variable or flag
 * that selects one.
 *
 * @param {string} briefing    - Markdown Agent Briefing from briefing.js
 * @param {object} contract    - TaskContract (for IDs)
 * @param {object|null} context - ContextPackage (for IDs + repo path)
 * @param {object} options     - { agent: 'dry-run'|'claude-code'|'manual', repoPath: string, timeoutMs?: number,
 *                                runSandboxed?: Function (injected by tests only) }
 * @returns {object}           - Validated ExecutionResult
 */
async function execute(briefing, contract, context, options = {}) {
  const agent  = options.agent    || 'dry-run';
  const repo   = options.repoPath || (context?.repo_path) || process.cwd();

  const t0 = Date.now();
  let outcome = {
    status: 'dry_run', diff: null, changes: [], unsupported_changes: [],
    base_tree: null, candidate_tree: null,
    exit_code: null, signal: null, stderr_tail: null, error: null,
  };

  if (agent === 'claude-code') {
    outcome = await runAgentSandboxed(briefing, repo, options);
  } else if (agent === 'manual') {
    // Print briefing and wait for the dev to run their agent
    process.stdout.write('\n' + briefing + '\n');
  }
  // dry-run: no invocation, just return the briefing

  const result = ExecutionResultSchema.parse({
    id:           randomUUID(),
    contract_id:  contract.id  || 'unknown',
    context_id:   context?.id  || null,
    agent_used:   agent,
    duration_ms:  Date.now() - t0,
    generated_at: new Date().toISOString(),
    briefing,
    ...outcome,
  });
  // Raw patch bytes and the base listing travel alongside the record, not in it
  // (not JSON, and never redacted): qb.js stores them as binary artifacts for `qb patch`.
  for (const k of ['patch_raw', 'base_listing']) {
    if (outcome[k]) Object.defineProperty(result, k, { value: outcome[k], enumerable: false });
  }
  return result;
}

/**
 * Run the coding agent in the sandbox against `repoPath` (read-only) and return
 * the ExecutionResult fields. `options.runSandboxed` is a test seam only.
 */
async function runAgentSandboxed(briefing, repoPath, options = {}) {
  const run = options.runSandboxed || runSandboxed;
  const r = await run({
    repoPath, briefing,
    deadlines: options.timeoutMs ? { agent: options.timeoutMs } : undefined,
  });
  const { status, diff = null, changes = [], unsupported_changes = [], base_tree = null, candidate_tree = null,
    exit_code = null, signal = null, stderr_tail = null, sandbox = null, patch_raw = null, base_listing = null } = r;
  return {
    status, diff, changes, unsupported_changes, base_tree, candidate_tree, exit_code, signal, stderr_tail,
    patch_raw, base_listing,
    error: ['completed', 'no_change'].includes(status) ? null : (r.reason || r.error || status),
    sandbox,
  };
}

module.exports = { execute, runAgentSandboxed };
