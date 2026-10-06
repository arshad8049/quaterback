/**
 * context/retrieval.js — what the context package contains, and why (QB-18).
 *
 * One language family is supported well: JavaScript (.js/.cjs/.mjs), indexed with the
 * QB-19 parser. Other code files are scanned for content and path matches only.
 *
 *   1. Scan     every code file in the repository (bounded by `scanLimit`): index its
 *               symbols, read its content, resolve its relative imports → an import graph
 *               and its reverse (callers).
 *   2. Score    each file against the contract's terms: identifiers named in the contract
 *               (parseDuration, getVADStats…) and keywords. Symbol-name matches weigh most,
 *               then content matches, then path/name matches.
 *   3. Seed     files whose score clears a relevance cut relative to the best file
 *               (`relativeCut` of the top score, and at least `minScore`). Below the cut is
 *               recorded as omitted, never silently dropped.
 *   4. Traverse a bounded BFS from the seeds with a visited set and an explicit `depth`
 *               (default 2), over import edges AND caller edges. Each file records its
 *               reason: seed (what matched), import of X at depth d, caller of X at depth d.
 *   5. Budget   files in priority order (a neighbour inherits its parent's priority,
 *               decayed per hop) until `maxFiles` / `maxBytes`; the rest is omitted with
 *               `dropped: "max_files" | "max_bytes"`. Files only reachable beyond the depth
 *               are omitted with `dropped: "depth_limit"`.
 *
 * A candidate `overlay` (path → content, and deleted paths) lets the same retrieval run on
 * an attempt's candidate state: refreshContext() re-retrieves after each patch, seeding
 * the changed files, so new repair files and their neighbours reach the next attempt.
 */

const fs = require('fs');
const path = require('path');
const { indexFile, MAX_INDEX_BYTES } = require('./symbols');
const { extractImports, readForIndex, MAX_FILE_BYTES } = require('./extractor');

const DEFAULTS = Object.freeze({ depth: 2, maxFiles: 25, maxBytes: 250_000, scanLimit: 5_000, maxSeeds: 10, relativeCut: 0.25, minScore: 3, decay: 0.7 });
const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', 'vendor']);
const CODE_EXTS = new Set(['.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs']);
const JS = /\.(c|m)?js$/;
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'into', 'make', 'sure', 'also', 'when', 'them', 'then', 'than', 'been',
  'were', 'will', 'would', 'could', 'should', 'like', 'some', 'just', 'more', 'what', 'which', 'their', 'there', 'about', 'your',
  'work', 'must', 'does', 'existing', 'users', 'user', 'code', 'file', 'returns', 'return', 'function', 'value']);

const splitCamel = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().split(/\s+/).filter(Boolean);

/** Terms from the contract: identifiers (camelCase / snake_case / called `name(`) and plain keywords. */
function contractTerms(contract) {
  const text = [contract.goal, ...(contract.required_behavior || []), ...(contract.relevant_context || []),
    ...(contract.acceptance_criteria || []).map((a) => (a && a.criterion) || '')].filter(Boolean).join(' \n ');
  const identifiers = new Set();
  for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+/g)) {
    if (m[0].length > 2) identifiers.add(m[0].toLowerCase());
  }
  const keywords = new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w) && !identifiers.has(w)));
  // The words inside identifiers (parseDuration → parse, duration) are weak keywords.
  for (const m of text.matchAll(/[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+/g)) {
    for (const w of splitCamel(m[0])) if (w.length > 3 && !STOP.has(w)) keywords.add(w);
  }
  return { identifiers: [...identifiers], keywords: [...keywords] };
}

function walk(base, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    if (e.name.startsWith('.') || IGNORE_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(base, abs, out);
    else if (e.isFile()) out.push(path.relative(base, abs).split(path.sep).join('/'));
  }
}

/** Resolve a relative import from `fromRel` against the candidate file set. */
function resolveIn(fromRel, spec, exists) {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (p.startsWith('..')) return null;
  for (const c of [p, `${p}.js`, `${p}.cjs`, `${p}.mjs`, `${p}.ts`, `${p}.jsx`, `${p}.tsx`, `${p}/index.js`, `${p}/index.ts`]) if (exists(c)) return c;
  return null;
}

/** Scan the repository (with an optional candidate overlay) into nodes and a graph. */
function scan(absRepo, { overlay = new Map(), deleted = new Set(), scanLimit }) {
  const all = [];
  walk(absRepo, absRepo, all);
  const seen = new Set(all);
  for (const p of overlay.keys()) if (!seen.has(p)) all.push(p);
  const present = all.filter((p) => !deleted.has(p) && CODE_EXTS.has(path.extname(p).toLowerCase()));
  const scanned = present.slice(0, scanLimit);
  const presentSet = new Set(present);
  const exists = (p) => (overlay.has(p) || presentSet.has(p)) && !deleted.has(p);
  const nodes = new Map();
  for (const rel of scanned) {
    let full, bytes, snippet, cut;
    if (overlay.has(rel)) {
      full = overlay.get(rel).content;
      bytes = Buffer.byteLength(full);
      cut = full.length > MAX_FILE_BYTES;
      snippet = cut ? full.slice(0, MAX_FILE_BYTES) : full;
    } else {
      const r = readForIndex(path.join(absRepo, rel), MAX_INDEX_BYTES);
      if (!r) continue;
      ({ full, bytes, snippet } = r);
      cut = r.snippet_truncated;
    }
    const idx = indexFile(rel, full, bytes);
    const imports = JS.test(rel) || /\.(ts|tsx|jsx)$/.test(rel)
      ? [...new Set(extractImports(full ?? snippet).map((s) => resolveIn(rel, s, exists)).filter(Boolean))] : [];
    nodes.set(rel, { rel, full: full ?? '', snippet: snippet ?? '', cut: Boolean(cut), bytes, idx, imports, source: overlay.has(rel) ? overlay.get(rel).source : 'checkout' });
  }
  const callers = new Map();
  for (const n of nodes.values()) for (const t of n.imports) { if (!callers.has(t)) callers.set(t, []); callers.get(t).push(n.rel); }
  return { nodes, callers, scanned: scanned.length, total: present.length };
}

/** Score one file against the terms; returns { score, why[] }. */
function scoreNode(n, terms) {
  let score = 0;
  const why = [];
  const symNames = n.idx.symbols.map((s) => s.name);
  for (const id of terms.identifiers) {
    const hit = symNames.find((s) => s.toLowerCase() === id);
    if (hit) { score += 20; why.push(`symbol ${hit}`); continue; }
    if (new RegExp(`\\b${id.replace(/[$]/g, '\\$')}\\b`, 'i').test(n.full)) { score += 4; why.push(`mentions ${id}`); }
  }
  const tokens = new Set(symNames.flatMap(splitCamel));
  let kwSym = 0, kwContent = 0;
  for (const kw of terms.keywords) {
    if (tokens.has(kw) && kwSym < 3) { score += 2; kwSym++; why.push(`symbol word ${kw}`); }
    else if (kwContent < 5 && new RegExp(`\\b${kw}`, 'i').test(n.full)) { score += 1; kwContent++; }
  }
  const name = path.posix.basename(n.rel).toLowerCase();
  for (const t of [...terms.identifiers, ...terms.keywords]) {
    if (name.includes(t)) { score += 3; why.push(`name ${t}`); } else if (n.rel.toLowerCase().includes(t)) score += 1;
  }
  return { score, why };
}

/**
 * @param {object} contract
 * @param {string} absRepo
 * @param {object} [o] - { depth, maxFiles, maxBytes, scanLimit, maxSeeds, relativeCut, minScore,
 *                        overlay: Map(path → { content, source }), deleted: Set,
 *                        forcedSeeds: [{ path, reason }] }
 * @returns {{ files: Array<{ rel, reason, retrieval, node }>, retrieval: object }}
 */
function retrieve(contract, absRepo, o = {}) {
  const cfg = { ...DEFAULTS, ...Object.fromEntries(Object.entries(o).filter(([k, v]) => k in DEFAULTS && v !== undefined)) };
  const terms = contractTerms(contract);
  const { nodes, callers, scanned, total } = scan(absRepo, { overlay: o.overlay, deleted: o.deleted, scanLimit: cfg.scanLimit });

  const scored = [...nodes.values()].map((n) => ({ n, ...scoreNode(n, terms) })).sort((a, b) => b.score - a.score || a.n.rel.localeCompare(b.n.rel));
  const top = scored.length ? scored[0].score : 0;
  const cut = Math.max(cfg.minScore, top * cfg.relativeCut);
  const forced = (o.forcedSeeds || []).filter((f) => nodes.has(f.path));
  const seeds = [
    ...forced.map((f) => ({ rel: f.path, priority: Math.max(top, 1) + 1, reason: f.reason, why: [] })),
    ...scored.filter((s) => s.score >= cut && !forced.some((f) => f.path === s.n.rel)).slice(0, cfg.maxSeeds)
      .map((s) => ({ rel: s.n.rel, priority: s.score, reason: `seed: ${s.why.slice(0, 4).join(', ') || 'content match'} (score ${s.score})`, why: s.why, score: s.score })),
  ];
  const omitted = [];
  const seedSet = new Set(seeds.map((s) => s.rel));
  for (const s of scored) {
    if (seedSet.has(s.n.rel) || s.score <= 0) continue;
    omitted.push({ path: s.n.rel, reason: `score ${s.score} (${s.why.slice(0, 2).join(', ') || 'weak match'})`,
      dropped: s.score < cut ? 'below_relevance_cut' : 'seed_limit' });
  }

  // Bounded BFS over import and caller edges, with a visited set and explicit depth.
  const picked = new Map();   // rel → { rel, priority, reason, retrieval }
  const queue = seeds.map((s) => ({ rel: s.rel, depth: 0, priority: s.priority, reason: s.reason, edge: s.reason.startsWith('seed') ? 'seed' : 'changed', via: null }));
  const visited = new Set(queue.map((q) => q.rel));
  const beyond = new Map();
  while (queue.length) {
    queue.sort((a, b) => b.priority - a.priority);
    const cur = queue.shift();
    picked.set(cur.rel, cur);
    const n = nodes.get(cur.rel);
    const next = [...(n ? n.imports.map((t) => [t, 'import']) : []), ...(callers.get(cur.rel) || []).map((t) => [t, 'caller'])];
    for (const [t, edge] of next) {
      if (visited.has(t)) continue;
      if (cur.depth + 1 > cfg.depth) { if (!beyond.has(t)) beyond.set(t, `${edge} of ${cur.rel} (would be depth ${cur.depth + 1})`); continue; }
      visited.add(t);
      queue.push({ rel: t, depth: cur.depth + 1, priority: cur.priority * cfg.decay, edge, via: cur.rel, reason: `${edge} of ${cur.rel} (depth ${cur.depth + 1})` });
    }
  }
  for (const [rel, why] of beyond) if (!picked.has(rel)) omitted.push({ path: rel, reason: why, dropped: 'depth_limit' });

  // Budget, in priority order.
  const ordered = [...picked.values()].sort((a, b) => b.priority - a.priority || a.depth - b.depth || a.rel.localeCompare(b.rel));
  const files = [];
  let used = 0;
  for (const p of ordered) {
    const n = nodes.get(p.rel);
    const bytes = n ? Buffer.byteLength(n.snippet) : 0;
    if (files.length >= cfg.maxFiles) { omitted.push({ path: p.rel, reason: p.reason, dropped: 'max_files' }); continue; }
    if (used + bytes > cfg.maxBytes) { omitted.push({ path: p.rel, reason: p.reason, dropped: 'max_bytes' }); continue; }
    used += bytes;
    files.push({ rel: p.rel, reason: p.reason, node: n,
      retrieval: { edge: p.edge, depth: p.depth, via: p.via, priority: Math.round(p.priority * 100) / 100, source: n ? n.source : 'checkout' } });
  }
  // A small repository is included whole (nothing can dominate a package it fits in).
  if (total <= cfg.maxFiles && scanned === total) {
    for (const n of nodes.values()) {
      if (files.some((f) => f.rel === n.rel)) continue;
      const bytes = Buffer.byteLength(n.snippet);
      if (used + bytes > cfg.maxBytes) continue;
      used += bytes;
      files.push({ rel: n.rel, reason: 'small repository: included in full', node: n, retrieval: { edge: 'fill', depth: null, via: null, priority: 0, source: n.source } });
      const i = omitted.findIndex((x) => x.path === n.rel);
      if (i >= 0) omitted.splice(i, 1);
    }
  }
  const MAX_OMITTED = 100;
  return {
    files,
    retrieval: {
      version: 1, language: 'javascript', depth: cfg.depth, max_files: cfg.maxFiles, max_bytes: cfg.maxBytes,
      used_files: files.length, used_bytes: used, scanned_files: scanned, scan_limit: cfg.scanLimit,
      scan_truncated: total > scanned ? total - scanned : 0, relevance_cut: Math.round(cut * 100) / 100,
      terms, seeds: seeds.map((s) => ({ path: s.rel, reason: s.reason })),
      omitted: omitted.slice(0, MAX_OMITTED), omitted_total: omitted.length,
    },
  };
}

module.exports = { retrieve, contractTerms, DEFAULTS };
