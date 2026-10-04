/**
 * intent/survey.js — the lightweight repository survey every compilation is
 * grounded in (QB-17). Root (qb.js) and standalone (intent/cli.js) compilation
 * use this same function, so the compiler sees the same grounding for the same
 * repository and request.
 *
 * Contents (intent/context.js): the directory tree (up to 200 files; dot-dirs,
 * node_modules, build output and binaries skipped) and the first 2,000 bytes of
 * the files most relevant to the request, within an 8,000-character budget.
 * It is read-only grounding: the request decides what to do.
 */

const crypto = require('crypto');
const path = require('path');
const { surveyDetails } = require('./context');

/** @returns {{ repo_path, text, files_total, tree_files, snippet_files: string[], digest }} */
function surveyRepository(repoPath, request) {
  const d = surveyDetails(repoPath, request);
  return { repo_path: path.resolve(repoPath), ...d, digest: crypto.createHash('sha256').update(d.text).digest('hex') };
}

/** What the survey covered, for records and handoff state (no file contents). */
const surveySummary = (s) => (s ? { repo_path: s.repo_path, files_total: s.files_total, tree_files: s.tree_files, snippet_files: s.snippet_files, digest: s.digest } : null);

module.exports = { surveyRepository, surveySummary };
