/**
 * context/coverage.js — real coverage data, only when the repository has it (QB-20).
 *
 * A test file existing is an ASSOCIATION, never coverage. Coverage is reported only
 * from a coverage report already present in the checkout:
 *   coverage/lcov.info            (lcov: LF/LH per SF)          → lines_pct
 *   coverage/coverage-final.json  (istanbul: statement counts)  → statements_pct
 * Only the given files are reported. No report → null. Reports are size-bounded.
 */

const fs = require('fs');
const path = require('path');

const MAX_REPORT_BYTES = 5 * 1024 * 1024;

function readBounded(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_REPORT_BYTES) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}

/** The repo-relative file among `files` that a report path refers to, or null. */
function match(repoPath, reportPath, files) {
  const p = String(reportPath).replace(/\\/g, '/');
  const rel = path.isAbsolute(p) ? path.relative(repoPath, p).replace(/\\/g, '/') : p.replace(/^\.\//, '');
  if (files.includes(rel)) return rel;
  return files.find((f) => p === f || p.endsWith(`/${f}`)) || null;
}

const pct = (hit, total) => (total > 0 ? Math.round((hit / total) * 1000) / 10 : null);

function readLcov(repoPath, files) {
  const text = readBounded(path.join(repoPath, 'coverage', 'lcov.info'));
  if (text === null) return null;
  const out = {};
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) cur = { file: match(repoPath, line.slice(3).trim(), files), lf: null, lh: null };
    else if (cur && line.startsWith('LF:')) cur.lf = Number(line.slice(3));
    else if (cur && line.startsWith('LH:')) cur.lh = Number(line.slice(3));
    else if (cur && line.trim() === 'end_of_record') {
      if (cur.file && Number.isFinite(cur.lf) && Number.isFinite(cur.lh)) out[cur.file] = { lines_pct: pct(cur.lh, cur.lf) };
      cur = null;
    }
  }
  return { source: 'lcov', path: 'coverage/lcov.info', files: out };
}

function readIstanbul(repoPath, files) {
  const text = readBounded(path.join(repoPath, 'coverage', 'coverage-final.json'));
  if (text === null) return null;
  let data;
  try { data = JSON.parse(text); } catch { return { source: 'istanbul', path: 'coverage/coverage-final.json', files: {}, error: 'unparsable' }; }
  const out = {};
  for (const [key, entry] of Object.entries(data || {})) {
    const file = match(repoPath, (entry && entry.path) || key, files);
    if (!file || !entry || typeof entry.s !== 'object') continue;
    const counts = Object.values(entry.s).filter((n) => Number.isFinite(n));
    out[file] = { statements_pct: pct(counts.filter((n) => n > 0).length, counts.length) };
  }
  return { source: 'istanbul', path: 'coverage/coverage-final.json', files: out };
}

/** @returns {null | { source: 'lcov'|'istanbul', path, files: Record<string, object>, error? }} */
function readCoverage(repoPath, files) {
  return readLcov(repoPath, files) || readIstanbul(repoPath, files);
}

module.exports = { readCoverage };
