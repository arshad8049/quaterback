const { randomUUID } = require('crypto');
const proc    = require('../lib/proc');
const capture = require('./capture');
const { ExecutionResultSchema } = require('./schema');

const DEFAULT_AGENT_COMMAND = ['claude', '--print', '--dangerously-skip-permissions'];
const DEFAULT_TIMEOUT_MS    = 10 * 60 * 1000;

/**
 * Execute the briefing against a coding agent (or dry-run).
 *
 * @param {string} briefing    - Markdown Agent Briefing from briefing.js
 * @param {object} contract    - TaskContract (for IDs)
 * @param {object|null} context - ContextPackage (for IDs + repo path)
 * @param {object} options     - { agent: 'dry-run'|'claude-code'|'manual', repoPath: string, timeoutMs?: number }
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
    outcome = runAgentCaptured(briefing, repo, { timeoutMs: options.timeoutMs });
  } else if (agent === 'manual') {
    // Print briefing and wait for the dev to run their agent
    process.stdout.write('\n' + briefing + '\n');
  }
  // dry-run: no invocation, just return the briefing

  return ExecutionResultSchema.parse({
    id:           randomUUID(),
    contract_id:  contract.id  || 'unknown',
    context_id:   context?.id  || null,
    agent_used:   agent,
    duration_ms:  Date.now() - t0,
    generated_at: new Date().toISOString(),
    briefing,
    ...outcome,
  });
}

/** The agent argv. QB_AGENT_COMMAND (JSON array) replaces it for tests/adapters. */
function agentCommand() {
  if (!process.env.QB_AGENT_COMMAND) return DEFAULT_AGENT_COMMAND;
  const argv = JSON.parse(process.env.QB_AGENT_COMMAND);
  if (!Array.isArray(argv) || !argv.length || !argv.every(a => typeof a === 'string')) {
    throw new Error('QB_AGENT_COMMAND must be a JSON array of strings');
  }
  return argv;
}

/**
 * Run the coding agent in `cwd` with `input` on stdin and capture everything
 * it changed relative to the tree that existed before it started. Changes are
 * captured on every path — including timeouts and crashes — so partial edits
 * stay inspectable (QB-22).
 */
function runAgentCaptured(input, cwd, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base_tree = capture.snapshot(cwd);
  const [cmd, ...args] = agentCommand();

  const r = proc.run(cmd, args, { cwd, input, timeout: timeoutMs });

  const candidate_tree = capture.snapshot(cwd);
  const { patch, changes, unsupported } = capture.diffTrees(cwd, base_tree, candidate_tree);

  let status, error = null;
  if (r.timedOut) {
    status = 'timeout';
    error  = `agent exceeded ${timeoutMs}ms`;
  } else if (r.error) {
    status = 'execution_error';
    error  = r.error.message;
  } else if (r.signal) {
    status = 'cancelled';
    error  = `agent terminated by ${r.signal}`;
  } else if (r.status !== 0) {
    status = 'execution_error';
    error  = `agent exited with code ${r.status}`;
  } else {
    status = changes.length ? 'completed' : 'no_change';
  }

  return {
    status,
    diff: patch || null,
    changes,
    unsupported_changes: unsupported,
    base_tree,
    candidate_tree,
    exit_code:   r.status,
    signal:      r.signal,
    stderr_tail: r.stderr ? String(r.stderr).slice(-2000) : null,
    error,
  };
}

module.exports = { execute, runAgentCaptured };
