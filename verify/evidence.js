/**
 * verify/evidence.js — what the judge sees, with provenance (QB-11).
 *
 * Per acceptance criterion, QB assembles an evidence bundle from trusted sources:
 *   hunk        every changed hunk of the captured diff, whole (never cut mid-hunk)
 *   definition  the definition of each function the added lines call — in the same
 *               file or in a relatively imported one — read from the TESTED candidate
 *               tree (the trusted snapshot export, QB-22), unchanged code included
 *   file        whole candidate files (the no-change judgment: the current files)
 *   check       the criterion's executed check results (QB-16)
 *
 * Every item has an immutable, content-addressed ID (EV-<12 hex>) over its kind,
 * file, line range, git blob and the SHA-256 of its text, plus that provenance.
 *
 * Items are ranked (relevance to the criterion first) and shown whole within a
 * character budget. Nothing is presented as complete when it is not:
 *   - an item that does not fit is listed under "Evidence NOT shown";
 *   - MATERIAL evidence that is not shown — a changed hunk, the definition of a
 *     helper the change calls, a candidate file under judgment — or that could not
 *     be retrieved (file too large, missing, snapshot failed) is named in `missing`,
 *     and the criterion can then never be judged met (unresolved instead).
 */

const crypto = require('crypto');
const path = require('path');
const acorn = require('acorn');
const { parseDiffHeader } = require('./policy');

const DEFAULT_BUDGET = 24_000;   // characters of evidence text per criterion (judge context: num_ctx 12288)
const budgetChars = () => {
  const n = Number(process.env.QB_JUDGE_EVIDENCE_CHARS);
  return Number.isInteger(n) && n >= 2000 ? n : DEFAULT_BUDGET;
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const JS = /\.(c|m)?jsx?$/;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'require', 'import', 'new',
  'await', 'async', 'super', 'this', 'class', 'constructor', 'delete', 'void', 'yield', 'in', 'of', 'do', 'else']);

/** The diff as files with their hunks (new-side line ranges). Deleted files have no new side. */
function parseDiff(diff) {
  const files = [];
  let cur = null;
  let h = null;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const sides = parseDiffHeader(line);
      cur = { file: sides ? sides[1] : line.slice(11), deleted: false, hunks: [] };
      files.push(cur); h = null; continue;
    }
    if (!cur) continue;
    if (line === '+++ /dev/null') { cur.deleted = true; continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      const start = Number(m[1]);
      const len = m[2] === undefined ? 1 : Number(m[2]);
      h = { start, end: Math.max(start, start + len - 1), lines: [line] };
      cur.hunks.push(h); continue;
    }
    if (h && /^[ +\-\\]/.test(line)) h.lines.push(line);
  }
  for (const f of files) for (const x of f.hunks) x.text = x.lines.join('\n');
  return files;
}

/** JS definitions in one file: { name, range: [startLine, endLine], text } — functions, classes, methods, assigned functions. */
function definitions(text) {
  let ast;
  for (const sourceType of ['module', 'script']) {
    try {
      ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true,
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
      break;
    } catch { /* try the other source type */ }
  }
  if (!ast) return null;
  const defs = [];
  const add = (name, node) => { if (name) defs.push({ name, range: [node.loc.start.line, node.loc.end.line], text: text.slice(node.start, node.end) }); };
  const isFn = (n) => n && ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(n.type);
  const keyName = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' && typeof k.value === 'string' ? k.value : null);
  const walk = (node, parent) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') add(node.id && node.id.name, node);
    else if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isFn(node.init)) add(node.id.name, parent && parent.type === 'VariableDeclaration' ? parent : node);
    else if (node.type === 'MethodDefinition' && !node.computed) add(keyName(node.key), node);
    else if (node.type === 'Property' && !node.computed && isFn(node.value)) add(keyName(node.key), node);
    else if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && !node.left.computed && isFn(node.right)) add(keyName(node.left.property), parent && parent.type === 'ExpressionStatement' ? parent : node);
    for (const k of Object.keys(node)) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) for (const c of v) walk(c, node);
      else if (v && typeof v.type === 'string') walk(v, node);
    }
  };
  walk(ast, null);
  return defs;
}

/** Relative imports of a file: local name → { spec, imported } ('*' = the module itself). */
function relativeImports(text) {
  const out = new Map();
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
    bind(out, m[1], m[2]);
  }
  for (const m of text.matchAll(/import\s+([^'"]+?)\s+from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const braces = /\{[^}]*\}/.exec(clause);
    if (braces) bind(out, braces[0].replace(/\bas\b/g, ':'), m[2]);
    const def = /^([A-Za-z_$][\w$]*)/.exec(clause.replace(/^\*\s+as\s+/, ''));
    if (def && !clause.startsWith('{')) out.set(def[1], { spec: m[2], imported: clause.startsWith('*') ? '*' : 'default' });
  }
  return out;
}
function bind(out, pattern, spec) {
  if (!pattern.startsWith('{')) { out.set(pattern, { spec, imported: '*' }); return; }
  for (const part of pattern.slice(1, -1).split(',')) {
    const [imported, local] = part.split(':').map((s) => s.trim());
    if (/^[A-Za-z_$][\w$]*$/.test(imported)) out.set(local && /^[A-Za-z_$][\w$]*$/.test(local) ? local : imported, { spec, imported });
  }
}

/** Candidate repository paths for a relative module specifier imported from `fromFile`. */
function importCandidates(fromFile, spec) {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  if (p.startsWith('..')) return [];
  return /\.(c|m)?js$|\.json$/.test(p) ? [p] : [`${p}.js`, `${p}/index.js`, `${p}.cjs`, `${p}.mjs`];
}

/** Functions called in added lines: bare calls `f(` and member calls on a namespace import `ns.f(`. */
function calledNames(addedText) {
  const bare = new Set();
  const member = [];
  for (const m of addedText.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) if (!KEYWORDS.has(m[2])) bare.add(m[2]);
  for (const m of addedText.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) member.push([m[1], m[2]]);
  return { bare, member };
}

/** Ranking: how many of the criterion's words / file names appear in the item. */
function relevance(criterion, item) {
  const words = new Set((String(criterion).toLowerCase().match(/[a-z0-9_$]{3,}/g) || []));
  const hay = `${item.file || ''}\n${item.text}`.toLowerCase();
  let n = 0;
  for (const w of words) if (hay.includes(w)) n++;
  return n;
}

function item(kind, fields) {
  const it = { kind, file: null, range: null, source: null, tree: null, blob: null, material: false, ...fields };
  it.sha256 = sha256(it.text);
  it.id = `EV-${sha256(JSON.stringify([it.kind, it.file, it.range, it.blob, it.sha256])).slice(0, 12)}`;
  return it;
}
const label = (it) => it.kind === 'check' ? `check results (${it.source})`
  : `${it.kind} ${it.file} ${it.kind === 'hunk' ? '+' : ''}${it.range[0]}..${it.range[1]}${it.blob ? ` (candidate tree, blob ${it.blob.slice(0, 12)})` : ` (${it.source})`}`;

/**
 * @param {object} a
 * @param {string}  a.criterion
 * @param {string|null} a.diff         the captured diff (null for a no-change judgment)
 * @param {Array}   a.files            candidate files [{ path, oid, text }] from the tested tree
 * @param {string|null} a.tree         that tree
 * @param {Array}   [a.unavailable]    [{ path, reason }] requested but not exported
 * @param {Array}   [a.missing]        material evidence already known to be missing [{ what, reason }]
 * @param {Array}   [a.checks]         this criterion's check results [{ id, status, detail }]
 * @param {boolean} [a.wholeFiles]     no-change mode: the candidate files themselves are under judgment
 * @returns {{ shown: Array, omitted: Array, missing: Array<{ what, reason }> }}
 */
function buildEvidence({ criterion, diff = null, files = [], tree = null, unavailable = [], missing = [], checks = [], wholeFiles = false, budget = budgetChars() }) {
  const items = [];
  const miss = [...missing];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const defsCache = new Map();
  const defsOf = (f) => { if (!defsCache.has(f.path)) defsCache.set(f.path, JS.test(f.path) ? definitions(f.text) : null); return defsCache.get(f.path); };
  const unavailableReason = (p) => (unavailable.find((u) => u.path === p) || {}).reason;

  if (checks.length) {
    items.push(item('check', { source: 'check_run', text: checks.map((c) => `${c.id}: ${c.status}${c.detail ? ` — ${c.detail}` : ''}`).join('\n'), material: true, rank: 1e6 }));
  }
  if (wholeFiles) {
    for (const f of files) items.push(item('file', { file: f.path, range: [1, f.text.split('\n').length], source: 'candidate_tree', tree, blob: f.oid, text: f.text, material: true }));
  }

  // Changed hunks (all material) and the definitions their added lines call.
  const shownDefs = new Set();
  const addDef = (f, d, material) => {
    const key = `${f.path}:${d.range[0]}:${d.name}`;
    if (shownDefs.has(key)) return;
    shownDefs.add(key);
    items.push(item('definition', { file: f.path, range: d.range, source: 'candidate_tree', tree, blob: f.oid, text: d.text, material, name: d.name }));
  };
  for (const fd of parseDiff(diff)) {
    for (const h of fd.hunks) items.push(item('hunk', { file: fd.file, range: [h.start, h.end], source: 'diff', text: h.text, material: true }));
    if (fd.deleted || !JS.test(fd.file)) continue;
    const added = fd.hunks.flatMap((h) => h.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1))).join('\n');
    const { bare, member } = calledNames(added);
    const own = byPath.get(fd.file);
    const imports = relativeImports(own ? own.text : fd.hunks.map((h) => h.lines.map((l) => l.slice(1)).join('\n')).join('\n'));
    // same-file helpers (unchanged code outside the hunks included)
    for (const d of (own && defsOf(own)) || []) if (bare.has(d.name) && !imports.has(d.name)) addDef(own, d, true);
    // imported helpers: the definition must come from the candidate tree, or be named as missing
    const wanted = [...[...bare].filter((n) => imports.has(n)).map((n) => [n, imports.get(n), imports.get(n).imported === '*' || imports.get(n).imported === 'default' ? null : imports.get(n).imported]),
      ...member.filter(([ns]) => imports.has(ns) && imports.get(ns).imported === '*').map(([ns, fn]) => [`${ns}.${fn}`, imports.get(ns), fn])];
    for (const [shown, imp, name] of wanted) {
      const cands = importCandidates(fd.file, imp.spec);
      const target = cands.map((p) => byPath.get(p)).find(Boolean);
      const what = `definition of ${shown} (imported from ${imp.spec})`;
      if (!target) {
        const why = cands.map((p) => [p, unavailableReason(p)]).filter(([, r]) => r && r !== 'missing');
        miss.push({ what, reason: why.length ? why.map(([p, r]) => `${p} ${r}`).join(', ')
          : cands.length && cands.every((p) => unavailableReason(p) === 'missing') ? `not found in the candidate tree (${cands.join(', ')})` : 'not retrieved' });
        continue;
      }
      const defs = defsOf(target);
      const d = defs && (name ? defs.filter((x) => x.name === name) : defs.slice(0, 1));
      if (!d || !d.length) { miss.push({ what, reason: `${target.path}: definition not found${defs ? '' : ' (unparsable)'}` }); continue; }
      for (const x of d) addDef(target, x, true);
    }
  }
  // Definitions named in the criterion itself (context; not material).
  for (const n of new Set([...String(criterion).matchAll(/([A-Za-z_$][\w$]*)\(\)/g)].map((m) => m[1]))) {
    for (const f of files) for (const d of defsOf(f) || []) if (d.name === n) addDef(f, d, false);
  }

  // Rank and fit the budget, whole items only.
  for (const [i, it] of items.entries()) { it.order = i; if (it.rank === undefined) it.rank = relevance(criterion, it) + (it.material ? 0.5 : 0); }
  items.sort((a, b) => b.rank - a.rank || a.order - b.order);
  const shown = [];
  const omitted = [];
  let used = 0;
  for (const it of items) {
    const cost = it.text.length + 120;
    if (used + cost <= budget) { shown.push(it); used += cost; } else omitted.push(it);
  }
  for (const it of omitted) if (it.material) miss.push({ what: it.kind === 'hunk' ? `hunk ${it.file} +${it.range[0]}..${it.range[1]}` : label(it), reason: 'not shown: evidence budget' });
  return { shown, omitted, missing: miss };
}

/** One missing item as text: hunks "(not shown: …)", everything else "— reason". */
const missingText = (m) => (m.reason.startsWith('not shown') ? `${m.what} (${m.reason})` : `${m.what} — ${m.reason}`);

/**
 * The tested candidate files for evidence (QB-11), from the trusted snapshot export.
 * A failed export or a tree mismatch is missing material evidence, named.
 */
function candidateFiles(execution) {
  const snap = execution?.sandbox?.snapshot;
  const tested = execution?.sandbox?.verification?.tree;
  if (!snap) return { files: [], tree: null, unavailable: [], missing: [] };   // no export in this record (older runs, unit fixtures)
  if (snap.error) return { files: [], tree: null, unavailable: [], missing: [{ what: `candidate source files (${snap.error})`, reason: 'snapshot failed' }] };
  if (!snap.tree || snap.tree !== execution?.candidate_tree || (tested && tested !== snap.tree)) {
    return { files: [], tree: null, unavailable: [], missing: [{ what: 'candidate source files (snapshot_tree_mismatch)', reason: 'not the tested tree' }] };
  }
  return { files: snap.files || [], tree: snap.tree, unavailable: snap.skipped || [], missing: [] };
}

/** The evidence manifest for the report: provenance only, no contents. */
const manifestEntry = (it) => ({ id: it.id, kind: it.kind, file: it.file, range: it.range, source: it.source, tree: it.tree, blob: it.blob, sha256: it.sha256, material: it.material });

module.exports = { buildEvidence, parseDiff, definitions, relativeImports, importCandidates, candidateFiles, manifestEntry, missingText, label, budgetChars };
