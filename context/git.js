const proc = require('../lib/proc');

/**
 * Extract git context for a set of file paths within a repo.
 * Returns recent commit activity per file. Fails gracefully if git unavailable.
 *
 * Paths come from the repository and from model output, so they are passed
 * to git as argv after `--` and never through a shell (QB-01).
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
    const rel = proc.containedPath(repoPath, filePath);
    if (!rel) return null;

    // Count commits touching this file in the last 30 days.
    // -z keeps filenames with newlines from splitting a record.
    const log = proc.git(
      ['log', '-z', '--format=%H', '--since=30 days ago', '--', `:(literal)${rel}`],
      repoPath
    );
    const commits = log.split('\0').filter(s => s.trim()).length;
    if (commits === 0) return null;

    // Get the most recent commit date
    const lastLog = proc.git(
      ['log', '-1', '--format=%ar', '--', `:(literal)${rel}`],
      repoPath
    ).trim();

    return {
      file:         filePath,
      commits,
      last_changed: lastLog || 'unknown',
    };
  } catch (_) {
    return null;
  }
}

function isGitRepo(repoPath) {
  try {
    proc.git(['rev-parse', '--git-dir'], repoPath);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { buildGitContext };
