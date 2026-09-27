/**
 * store.js — disk I/O for memory layer
 *
 * Each repo gets its own directory under QB_MEMORY_DIR (default: ~/.quarterback/memory/).
 * Directory name = sanitized repo path (slashes → underscores).
 *
 * Files:
 *   outcomes.jsonl   — one JSON line per completed pipeline run
 *   repairs.jsonl    — one JSON line per repair hint that fired
 *   file_stats.json  — aggregated file hit counts { "path": { hits, keywords[] } }
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const MEMORY_ROOT = process.env.QB_MEMORY_DIR
  || path.join(os.homedir(), '.quarterback', 'memory');

function repoDir(repoPath) {
  const sanitized = repoPath.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+/, '');
  return path.join(MEMORY_ROOT, sanitized);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── JSONL helpers ──────────────────────────────────────────────────────────────

function appendLine(filePath, record) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch (_) { return null; } })
    .filter(Boolean);
}

// ── JSON helpers ───────────────────────────────────────────────────────────────

function readJson(filePath, fallback = {}) {
  if (!fs.existsSync(filePath)) return fallback;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

// ── Public store interface ─────────────────────────────────────────────────────

function appendOutcome(repoPath, record) {
  appendLine(path.join(repoDir(repoPath), 'outcomes.jsonl'), record);
}

function appendRepair(repoPath, record) {
  appendLine(path.join(repoDir(repoPath), 'repairs.jsonl'), record);
}

function readOutcomes(repoPath) {
  return readLines(path.join(repoDir(repoPath), 'outcomes.jsonl'));
}

function readRepairs(repoPath) {
  return readLines(path.join(repoDir(repoPath), 'repairs.jsonl'));
}

function updateFileStats(repoPath, changedFiles, keywords) {
  const p     = path.join(repoDir(repoPath), 'file_stats.json');
  const stats = readJson(p, {});
  for (const file of changedFiles) {
    if (!stats[file]) stats[file] = { hits: 0, keywords: [] };
    stats[file].hits++;
    // Merge unique keywords
    const kw = new Set([...stats[file].keywords, ...keywords]);
    stats[file].keywords = [...kw].slice(0, 30);
  }
  writeJson(p, stats);
}

function readFileStats(repoPath) {
  return readJson(path.join(repoDir(repoPath), 'file_stats.json'), {});
}

function repoMemoryPath(repoPath) {
  return repoDir(repoPath);
}

module.exports = {
  appendOutcome,
  appendRepair,
  readOutcomes,
  readRepairs,
  updateFileStats,
  readFileStats,
  repoMemoryPath,
};
