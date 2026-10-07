/**
 * context/coverage.js — real coverage data, only when the repository has it (QB-20).
 *
 * A test file existing is an ASSOCIATION, never coverage. Coverage is reported only
 * from a coverage report already present in the checkout:
 *   coverage/lcov.info            (lcov: LF/LH per SF)          → lines_pct
 *   coverage/coverage-final.json  (istanbul: statement counts)  → statements_pct
 * Only the given files are reported. No report → null.
 *
 * Re-review 1 — a report is optional, UNTRUSTED input:
 *   - it never aborts L2: a bad report is `status: 'unavailable'` with diagnostics, and
 *     one bad entry is dropped (with a diagnostic) while valid entries are kept;
 *   - counts are validated, never clamped: nonnegative integers, hits <= total, and for
 *     lcov the DA lines (when present) must agree with LF/LH; istanbul `s` must be a map of
 *     nonnegative integers whose keys are exactly the `statementMap` keys;
 *   - file identity is EXACT: a report path is attributed only if it normalizes to a
 *     repo-relative path inside this checkout (relative, or absolute under the checkout's
 *     path or real path), or under an explicit `.quarterback.json` `coverage.source_root`
 *     for reports generated elsewhere. Anything else is `unmapped` — never a suffix match;
 *   - two entries for the same file are ambiguous: neither is reported.
 */

const fs = require('fs');
const path = require('path');
const { CONFIG_FILE } = require('./test-plan');

const MAX_REPORT_BYTES = 5 * 1024 * 1024;
const MAX_LISTED = 20;
const LCOV = 'coverage/lcov.info';
const ISTANBUL = 'coverage/coverage-final.json';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const INT = /^\d+$/;
const pct = (hit, total) => (total > 0 ? Math.round((hit / total) * 1000) / 10 : null);

/** Reads a report: { text } | { missing } | { error: code, detail }. */
function readBounded(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return { missing: true }; }
  if (!st.isFile()) return { error: 'not_a_file', detail: 'not a regular file' };
  if (st.size > MAX_REPORT_BYTES) return { error: 'too_large', detail: `${st.size} bytes exceeds the ${MAX_REPORT_BYTES}-byte limit` };
  try { return { text: fs.readFileSync(abs, 'utf8') }; } catch (e) { return { error: 'unreadable', detail: e.code || e.message }; }
}

/** Optional explicit mapping for reports generated in another directory. */
function sourceRoot(repoPath, diagnostics) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(repoPath, CONFIG_FILE), 'utf8')); } catch { return null; }
  if (!isPlainObject(cfg) || cfg.coverage === undefined) return null;
  const root = isPlainObject(cfg.coverage) ? cfg.coverage.source_root : undefined;
  if (typeof root === 'string' && path.posix.isAbsolute(root.replace(/\\/g, '/'))) return root.replace(/\\/g, '/');
  diagnostics.push({ code: 'invalid_coverage_config', detail: `${CONFIG_FILE}: expected { "coverage": { "source_root": "<absolute path>" } }; no mapping applied` });
  return null;
}

/**
 * The exact repo-relative path a report path names, or null (not inside this checkout).
 * No suffix matching: `/another-project/src/a.js` is not `src/a.js`.
 */
function makeResolver(repoPath, mappedRoot) {
  const roots = [...new Set([repoPath, safeRealpath(repoPath)].map((r) => r.replace(/\\/g, '/')))];
  if (mappedRoot) roots.push(mappedRoot);
  const inside = (rel) => rel !== '' && rel !== '.' && !rel.startsWith('../') && rel !== '..' && !path.posix.isAbsolute(rel);
  return (reportPath) => {
    if (typeof reportPath !== 'string' || !reportPath || reportPath.includes('\0')) return null;
    const p = reportPath.replace(/\\/g, '/');
    if (path.posix.isAbsolute(p)) {
      for (const root of roots) {
        const rel = path.posix.relative(root, path.posix.normalize(p));
        if (inside(rel)) return rel;
      }
      return null;
    }
    if (/^[A-Za-z]:\//.test(p)) return null;            // a Windows absolute path from another machine
    const rel = path.posix.normalize(p);
    return inside(rel) ? rel : null;
  };
}

function safeRealpath(p) { try { return fs.realpathSync(p); } catch { return p; } }

/** Collects per-entry results, then attributes them (exact identity, duplicates dropped). */
function attribute(repoPath, files, entries, diagnostics, resolve) {
  const out = {};
  const unmapped = [];
  const seen = new Map();   // repo-relative → count
  for (const e of entries) {
    const rel = resolve(e.reportPath);
    if (rel === null) { unmapped.push(e.reportPath); continue; }
    if (!fs.existsSync(path.join(repoPath, rel))) { unmapped.push(e.reportPath); continue; }   // names no file in this checkout
    seen.set(rel, (seen.get(rel) || 0) + 1);
    if (seen.get(rel) > 1) continue;
    if (files.includes(rel)) out[rel] = e.value;
  }
  for (const [rel, n] of seen) {
    if (n > 1) {
      delete out[rel];
      diagnostics.push({ code: 'duplicate_entry', entry: rel, detail: `${n} report entries name ${rel}; neither is used` });
    }
  }
  return { files: out, unmapped };
}

function parseLcov(text, diagnostics) {
  const entries = [];
  let cur = null;
  const reject = (code, detail) => { diagnostics.push({ code, entry: cur.sf, detail }); cur.bad = true; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      if (cur) diagnostics.push({ code: 'truncated_record', entry: cur.sf, detail: 'record has no end_of_record' });
      cur = { sf: line.slice(3), lf: [], lh: [], da: [], bad: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('LF:')) cur.lf.push(line.slice(3));
    else if (line.startsWith('LH:')) cur.lh.push(line.slice(3));
    else if (line.startsWith('DA:')) cur.da.push(line.slice(3));
    else if (line === 'end_of_record') {
      const rec = cur;
      if (rec.lf.length !== 1 || rec.lh.length !== 1) reject('invalid_counts', `expected exactly one LF and one LH (got ${rec.lf.length} LF, ${rec.lh.length} LH)`);
      else if (!INT.test(rec.lf[0]) || !INT.test(rec.lh[0])) reject('invalid_counts', `LF/LH must be nonnegative integers (LF:${rec.lf[0]} LH:${rec.lh[0]})`);
      else {
        const lf = Number(rec.lf[0]); const lh = Number(rec.lh[0]);
        if (!isCount(lf) || !isCount(lh)) reject('invalid_counts', 'LF/LH out of range');
        else if (lh > lf) reject('inconsistent_counts', `LH:${lh} exceeds LF:${lf}`);
        else if (rec.da.length) {
          const hits = rec.da.map((d) => d.split(','));
          if (hits.some((h) => h.length < 2 || !INT.test(h[0]) || !INT.test(h[1]))) reject('invalid_counts', 'DA entries must be <line>,<nonnegative hits>');
          else if (hits.length !== lf || hits.filter((h) => Number(h[1]) > 0).length !== lh) {
            reject('inconsistent_counts', `LF:${lf} LH:${lh} disagree with ${hits.length} DA lines (${hits.filter((h) => Number(h[1]) > 0).length} hit)`);
          }
        }
        if (!rec.bad) entries.push({ reportPath: rec.sf, value: { lines_pct: pct(lh, lf) } });
      }
      cur = null;
    }
  }
  if (cur) diagnostics.push({ code: 'truncated_record', entry: cur.sf, detail: 'record has no end_of_record' });
  return entries;
}

function parseIstanbul(text, diagnostics) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { fatal: { code: 'unparsable', detail: e.message } }; }
  if (!isPlainObject(data)) return { fatal: { code: 'invalid_report_shape', detail: 'top level must be an object of file entries' } };
  const entries = [];
  for (const [key, entry] of Object.entries(data)) {
    const bad = (detail) => diagnostics.push({ code: 'invalid_entry', entry: key, detail });
    if (!isPlainObject(entry)) { bad('entry is not an object'); continue; }
    if (entry.path !== undefined && (typeof entry.path !== 'string' || entry.path !== key)) { bad('entry path differs from its key'); continue; }
    if (!isPlainObject(entry.statementMap)) { bad('statementMap missing or not an object'); continue; }
    if (!isPlainObject(entry.s)) { bad('s (statement counters) missing or not an object'); continue; }
    const mapKeys = Object.keys(entry.statementMap).sort();
    const sKeys = Object.keys(entry.s).sort();
    if (mapKeys.length !== sKeys.length || mapKeys.some((k, i) => k !== sKeys[i])) { bad('s keys do not match statementMap keys'); continue; }
    if (Object.values(entry.statementMap).some((loc) => !isPlainObject(loc) || !isPlainObject(loc.start) || !isPlainObject(loc.end))) { bad('statementMap location without start/end'); continue; }
    const counts = Object.values(entry.s);
    if (!counts.every(isCount)) { bad('statement counters must be nonnegative integers'); continue; }
    entries.push({ reportPath: key, value: { statements_pct: pct(counts.filter((n) => n > 0).length, counts.length) } });
  }
  return { entries };
}

const cap = (list) => list.slice(0, MAX_LISTED);

function readOne(repoPath, files, kind) {
  const rel = kind === 'lcov' ? LCOV : ISTANBUL;
  const r = readBounded(path.join(repoPath, rel));
  if (r.missing) return null;
  const diagnostics = [];
  const base = { source: kind, path: rel };
  if (r.error) return { ...base, status: 'unavailable', files: {}, unmapped: [], diagnostics: [{ code: r.error, detail: r.detail }], error: r.error };
  let entries;
  if (kind === 'lcov') entries = parseLcov(r.text, diagnostics);
  else {
    const parsed = parseIstanbul(r.text, diagnostics);
    if (parsed.fatal) return { ...base, status: 'unavailable', files: {}, unmapped: [], diagnostics: [parsed.fatal], error: parsed.fatal.code };
    entries = parsed.entries;
  }
  const resolve = makeResolver(repoPath, sourceRoot(repoPath, diagnostics));
  const { files: out, unmapped } = attribute(repoPath, files, entries, diagnostics, resolve);
  return { ...base, status: 'available', files: out, unmapped: cap(unmapped), unmapped_count: unmapped.length,
    diagnostics: cap(diagnostics), diagnostic_count: diagnostics.length };
}

/**
 * @returns {null | { source: 'lcov'|'istanbul', path, status: 'available'|'unavailable',
 *   files: Record<string, object>, unmapped: string[], diagnostics: object[], error? }}
 * Never throws: an internal failure is an unavailable report, not an aborted L2.
 */
function readCoverage(repoPath, files) {
  const attempt = (kind) => {
    try { return readOne(repoPath, files, kind); } catch (e) {
      return { source: kind, path: kind === 'lcov' ? LCOV : ISTANBUL, status: 'unavailable', files: {}, unmapped: [],
        diagnostics: [{ code: 'reader_error', detail: e.message }], error: 'reader_error' };
    }
  };
  const lcov = attempt('lcov');
  if (lcov && lcov.status === 'available') return lcov;
  return attempt('istanbul') || lcov;
}

module.exports = { readCoverage };
