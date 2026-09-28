/**
 * baseline.js — raw coding agent run with no QB pipeline
 *
 * Sends the raw task description directly to claude-code.
 * No contract, no context package, no repair loop.
 * Returns the git diff and execution time for fair comparison.
 */

const { spawnSync, execSync } = require('child_process');

/**
 * Run the task description directly through claude-code, no QB layers.
 * @param {string} description  - raw task string
 * @param {string} repoPath     - absolute repo path
 * @returns {{ diff, status, duration_ms, error }}
 */
function runBaseline(description, repoPath) {
  const t0 = Date.now();

  const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
    input:     description,
    cwd:       repoPath,
    encoding:  'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout:   8 * 60 * 1000,
  });

  const duration_ms = Date.now() - t0;

  if (result.error) {
    return { diff: null, status: 'failed', duration_ms, error: result.error.message };
  }
  if (result.status !== 0) {
    return { diff: null, status: 'failed', duration_ms, error: result.stderr || `exit ${result.status}` };
  }

  let diff = null;
  try {
    diff = execSync('git diff', { cwd: repoPath, encoding: 'utf8' });
    if (!diff.trim()) diff = null;
  } catch (_) {}

  return { diff, status: 'completed', duration_ms, error: null };
}

module.exports = { runBaseline };
