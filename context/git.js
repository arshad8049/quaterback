const { execSync } = require('child_process');
const path = require('path');

/**
 * Extract git context for a set of file paths within a repo.
 * Returns recent commit activity per file. Fails gracefully if git unavailable.
 */
function buildGitContext(repoPath, filePaths) {
  if (!isGitRepo(repoPath)) return { recent_changes: [] };

  const recent_changes = filePaths
    .map(f => getFileActivity(repoPath, f))
    .filter(Boolean);

  return { recent_changes };
}

function getFileActivity(repoPath, filePath) {
  try {
    // Count commits touching this file in the last 30 days
    const log = run(
      `git log --oneline --since="30 days ago" -- "${filePath}"`,
      repoPath
    );
    const lines = log.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    // Get the most recent commit date
    const lastLog = run(
      `git log -1 --format="%ar" -- "${filePath}"`,
      repoPath
    ).trim();

    return {
      file:         filePath,
      commits:      lines.length,
      last_changed: lastLog || 'unknown',
    };
  } catch (_) {
    return null;
  }
}

function isGitRepo(repoPath) {
  try {
    run('git rev-parse --git-dir', repoPath);
    return true;
  } catch (_) {
    return false;
  }
}

function run(cmd, cwd) {
  return execSync(cmd, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }).toString();
}

module.exports = { buildGitContext };
