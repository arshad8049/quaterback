const { execSync, spawnSync } = require('child_process');
const { randomUUID } = require('crypto');
const path = require('path');
const { ExecutionResultSchema } = require('./schema');

/**
 * Execute the briefing against a coding agent (or dry-run).
 *
 * @param {string} briefing    - Markdown Agent Briefing from briefing.js
 * @param {object} contract    - TaskContract (for IDs)
 * @param {object|null} context - ContextPackage (for IDs + repo path)
 * @param {object} options     - { agent: 'dry-run'|'claude-code'|'manual', repoPath: string }
 * @returns {object}           - Validated ExecutionResult
 */
async function execute(briefing, contract, context, options = {}) {
  const agent  = options.agent    || 'dry-run';
  const repo   = options.repoPath || (context?.repo_path) || process.cwd();

  const t0 = Date.now();
  let diff    = null;
  let status  = 'dry-run';
  let error   = null;

  if (agent === 'claude-code') {
    ({ diff, status, error } = runClaudeCode(briefing, repo));
  } else if (agent === 'manual') {
    // Print briefing and wait for the dev to run their agent
    process.stdout.write('\n' + briefing + '\n');
    status = 'dry-run';
  }
  // dry-run: no invocation, just return the briefing

  const changes = diff ? parseDiff(diff) : [];

  const result = {
    id:           randomUUID(),
    contract_id:  contract.id  || 'unknown',
    context_id:   context?.id  || null,
    agent_used:   agent,
    status,
    duration_ms:  Date.now() - t0,
    generated_at: new Date().toISOString(),
    briefing,
    changes,
    diff:  diff  || null,
    error: error || null,
  };

  return ExecutionResultSchema.parse(result);
}

// ─── Claude Code invocation ───────────────────────────────────────────────────

function runClaudeCode(briefing, repoPath) {
  // claude --print runs non-interactively: reads from stdin, prints output
  // We pass the briefing as stdin input and capture stdout
  const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
    input:  briefing,
    cwd:    repoPath,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 10 * 60 * 1000, // 10 min max
  });

  if (result.error) {
    return { diff: null, status: 'failed', error: result.error.message };
  }
  if (result.status !== 0) {
    const msg = result.stderr || `claude exited with code ${result.status}`;
    return { diff: null, status: 'failed', error: msg };
  }

  // Capture git diff of unstaged changes after agent ran
  let diff = null;
  try {
    diff = execSync('git diff', { cwd: repoPath, encoding: 'utf8' });
    if (!diff.trim()) diff = null;
  } catch (_) {}

  return { diff, status: 'completed', error: null };
}

// ─── Diff parser ─────────────────────────────────────────────────────────────

function parseDiff(rawDiff) {
  const changes = {};
  let currentFile = null;

  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) {
        currentFile = match[1];
        changes[currentFile] = { file: currentFile, additions: 0, deletions: 0 };
      }
    } else if (currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) changes[currentFile].additions++;
      else if (line.startsWith('-') && !line.startsWith('---')) changes[currentFile].deletions++;
    }
  }

  return Object.values(changes);
}

module.exports = { execute };
