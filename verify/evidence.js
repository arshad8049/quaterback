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

function parseJs(text) {
  for (const sourceType of ['module', 'script']) {
    try {
      return acorn.parse(text, { ecmaVersion: 'latest', sourceType, locations: true, allowHashBang: true,
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
    } catch { /* try the other source type */ }
  }
  return null;
}
const isFnNode = (n) => n && ['FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression'].includes(n.type);
const defOf = (name, node, text) => ({ name, range: [node.loc.start.line, node.loc.end.line], text: text.slice(node.start, node.end) });
const keyOf = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' && typeof k.value === 'string' ? k.value : null);

/** Module-scope definitions only (QB-11 re-review): name → [definition]. Nested functions never bind a module name. */
function topLevelDefs(ast, text) {
  const out = new Map();
  const add = (name, node) => { if (name) out.set(name, [...(out.get(name) || []), defOf(name, node, text)]); };
  for (const st of ast.body) {
    const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (!d) continue;
    if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') add(d.id && d.id.name, st);
    else if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier' && isFnNode(v.init)) add(v.id.name, st);
  }
  return out;
}

/**
 * What a module exports, as bindings (QB-11 re-review): `module` is the module
 * itself (module.exports = X / export default X), `named` its named exports.
 * A binding is { local: name } (a module-scope definition), { node } (defined
 * inline) or { unresolved: why } — never a guess.
 *
 * CommonJS is replayed in statement order (re-review 2), as Node runs it:
 * `module.exports = …` starts a NEW export object (earlier named exports are gone)
 * and detaches the `exports` alias, so a later `exports.x = …` exports nothing;
 * `module.exports.x = …` adds to the current object; the last assignment wins.
 * Re-review 3: every reference to module / module.exports / exports must be an
 * export statement QB interpreted (marked only AFTER interpreting it) or a plain
 * property read; any other write, delete, update, compound or destructuring
 * assignment, or the export object escaping as a value, makes every binding
 * unresolved (a systematic audit, not a list of spellings).
 */
function exportBindings(ast) {
  // ── what counts as the export object ──
  const propName = (m) => (!m.computed ? m.property.name : m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null);
  const isId = (n, name) => n && n.type === 'Identifier' && n.name === name;
  const isModuleExports = (n) => n && n.type === 'MemberExpression' && isId(n.object, 'module') && propName(n) === 'exports';
  const isExportObj = (n) => isModuleExports(n) || isId(n, 'exports');
  const val = (n, stmt) => (n.type === 'Identifier' ? { local: n.name } : isFnNode(n) ? { node: stmt } : { unresolved: `the exported value is a ${n.type === 'Literal' ? `literal ${JSON.stringify(n.value)}` : n.type}` });
  const line = (n) => n.loc.start.line;

  let cjsModule = null;               // the current module.exports value, if replaced
  let cjsNamed = new Map();           // named exports on the CURRENT export object
  let replacedAt = null;              // line of the last module.exports replacement
  let opaqueNamed = null;             // module.exports is a value whose properties QB cannot see
  const detachedWrites = new Map();   // exports.x written after the alias was detached
  const deletedAt = new Map();        // named exports removed by a top-level delete
  let opaque = null;                  // an export mutation QB did not interpret
  const interpreted = new Set();      // write targets QB actually interpreted (marked only after interpreting)

  const esmNamed = new Map();
  const esmDefault = [];
  const addEsm = (k, b) => esmNamed.set(k, esmNamed.has(k) ? { unresolved: `${k} is exported more than once` } : b);

  // ── 1. interpret the supported top-level forms, in statement order ──
  for (const st of ast.body) {
    if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && st.expression.operator === '=') {
      const { left, right } = st.expression;
      if (isModuleExports(left)) {
        replacedAt = line(st);
        cjsNamed = new Map();
        opaqueNamed = null;
        deletedAt.clear();
        if (right.type === 'ObjectExpression') {
          cjsModule = { unresolved: 'module.exports is an object, not a function' };
          let ok = true;
          for (const p of right.properties) {
            const k = p.type === 'Property' ? (p.computed ? (p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null) : keyOf(p.key)) : null;
            if (!k) { ok = false; break; }
            cjsNamed.set(k, p.shorthand ? { local: k } : val(p.value, p));
          }
          if (!ok) continue;                 // a spread / computed key: not interpreted — the audit below fails it closed
        } else {
          cjsModule = val(right, st);
          if (!isFnNode(right)) opaqueNamed = `module.exports was replaced at line ${line(st)} by a value whose properties QB cannot see`;
        }
        interpreted.add(left);
        continue;
      }
      if (left.type === 'MemberExpression' && propName(left) !== null && isModuleExports(left.object)) {
        cjsNamed.set(propName(left), val(right, st)); deletedAt.delete(propName(left)); interpreted.add(left); continue;
      }
      if (left.type === 'MemberExpression' && propName(left) !== null && isId(left.object, 'exports')) {
        if (replacedAt) detachedWrites.set(propName(left), line(st)); else { cjsNamed.set(propName(left), val(right, st)); deletedAt.delete(propName(left)); }
        interpreted.add(left); continue;
      }
    } else if (st.type === 'ExpressionStatement' && st.expression.type === 'UnaryExpression' && st.expression.operator === 'delete') {
      const a = st.expression.argument;
      if (a.type === 'MemberExpression' && propName(a) !== null && (isModuleExports(a.object) || (isId(a.object, 'exports') && !replacedAt))) {
        cjsNamed.delete(propName(a)); deletedAt.set(propName(a), line(st)); interpreted.add(a); continue;
      }
      if (a.type === 'MemberExpression' && propName(a) !== null && isId(a.object, 'exports')) { interpreted.add(a); continue; }   // detached alias: no effect
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      esmDefault.push(d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration' ? { node: st } : val(d, st));
    } else if (st.type === 'ExportNamedDeclaration') {
      const name = (sp) => sp.exported.name ?? sp.exported.value;
      if (st.source) { for (const sp of st.specifiers) addEsm(name(sp), { unresolved: 're-exported from another module' }); continue; }
      const d = st.declaration;
      if (d && d.id) addEsm(d.id.name, { node: st });
      else if (d && d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier') addEsm(v.id.name, isFnNode(v.init) ? { node: st } : { unresolved: `${v.id.name} is not a function` });
      for (const sp of st.specifiers || []) addEsm(name(sp), { local: sp.local.name });
    }
  }

  // ── 2. audit every other reference to module / module.exports / exports ──
  // Allowed: an interpreted write target, or a plain READ of a property of the export
  // object. Anything else — any other write (=, compound, ??=, ++/--, delete,
  // destructuring or for-in/of target), or the export object (or `module`) escaping as
  // a value (passed to a call, aliased, returned, spread) — is a mutation QB did not
  // interpret: every binding becomes unresolved.
  const parent = new Map();
  const index = (n) => {
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') { parent.set(c, n); index(c); }
    }
  };
  index(ast);
  const isWriteTarget = (n) => {
    const p = parent.get(n);
    if (!p) return false;
    if (p.type === 'AssignmentExpression' && p.left === n) return true;
    if (p.type === 'UpdateExpression' || (p.type === 'UnaryExpression' && p.operator === 'delete')) return true;
    if ((p.type === 'ForInStatement' || p.type === 'ForOfStatement') && p.left === n) return true;
    if (p.type === 'ArrayPattern' || p.type === 'RestElement' || (p.type === 'AssignmentPattern' && p.left === n)) return true;
    if (p.type === 'Property' && p.value === n && parent.get(p) && parent.get(p).type === 'ObjectPattern') return true;
    return false;
  };
  const isReference = (n) => {   // an Identifier used as a variable (not a property name or key)
    const p = parent.get(n);
    if (!p) return true;
    if (p.type === 'MemberExpression' && p.property === n && !p.computed) return false;
    if ((p.type === 'Property' || p.type === 'MethodDefinition' || p.type === 'PropertyDefinition') && p.key === n && !p.computed) return false;
    return true;
  };
  const why = (n, what) => `${what} at line ${line(n)} is not a form QB interprets`;
  const audit = (n) => {
    if (opaque || !n || typeof n.type !== 'string') return;
    if (isModuleExports(n) || (isId(n, 'exports') && isReference(n))) {
      const p = parent.get(n);
      if (interpreted.has(n)) return;                                         // an interpreted replacement
      if (p && p.type === 'MemberExpression' && p.object === n) {             // a property of the export object
        if (isWriteTarget(p) && !interpreted.has(p)) opaque = why(p, 'a change to an exported property');
        return;
      }
      opaque = isWriteTarget(n) ? why(n, 'a change to the export object') : `the export object is used as a value at line ${line(n)} (aliased, passed or returned), so later changes cannot be followed`;
      return;
    }
    if (isId(n, 'module') && isReference(n)) {
      const p = parent.get(n);
      // reads: a property access, a comparison (require.main === module), typeof module
      const read = p && ((p.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(p.operator)) || (p.type === 'UnaryExpression' && p.operator === 'typeof'));
      if (read) return;
      if (!(p && p.type === 'MemberExpression' && p.object === n)) { opaque = `\`module\` is used as a value at line ${line(n)}`; return; }
      if (propName(p) === null && isWriteTarget(p)) { opaque = why(p, 'a computed write to module'); return; }
    }
    for (const k of Object.keys(n)) {
      if (k === 'loc') continue;
      const v = n[k];
      for (const c of Array.isArray(v) ? v : [v]) if (c && typeof c.type === 'string') audit(c);
    }
  };
  audit(ast);

  const cjsTouched = replacedAt !== null || cjsNamed.size > 0 || detachedWrites.size > 0 || deletedAt.size > 0;
  const named = new Map([...esmNamed]);
  for (const [k, b] of cjsNamed) named.set(k, esmNamed.has(k) ? { unresolved: `${k} is exported by both CommonJS and ESM` } : b);
  const lookup = (k) => {
    if (opaque) return { unresolved: opaque };
    if (named.has(k)) return named.get(k);
    if (deletedAt.has(k)) return { unresolved: `${k} was deleted from the exports at line ${deletedAt.get(k)}` };
    if (opaqueNamed) return { unresolved: opaqueNamed };
    if (detachedWrites.has(k)) return { unresolved: `exports.${k} was assigned after module.exports was replaced (the exports alias is detached)` };
    return { unresolved: replacedAt ? `${k} is not exported: module.exports was replaced at line ${replacedAt}` : `${k} is not exported` };
  };
  let moduleBinding;
  if (opaque) moduleBinding = { unresolved: opaque };
  else if (esmDefault.length + (cjsModule ? 1 : 0) > 1) moduleBinding = { unresolved: 'the module export is defined more than once (CommonJS and/or ESM default)' };
  else moduleBinding = esmDefault[0] || cjsModule || { unresolved: cjsTouched ? 'module.exports is the default object, not a function' : 'no module export' };
  return { module: moduleBinding, named: { get: lookup, has: (k) => !lookup(k).unresolved } };
}

/** JS definitions in one file: { name, range: [startLine, endLine], text } — functions, classes, methods, assigned functions. */
function definitions(text) {
  const ast = parseJs(text);
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

// Names a call needs no source for: language and runtime globals.
const GLOBALS = new Set(['parseInt', 'parseFloat', 'Number', 'String', 'Boolean', 'Array', 'Object', 'Symbol', 'BigInt', 'Date', 'Error',
  'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'RegExp', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'queueMicrotask', 'structuredClone', 'require', 'fetch', 'URL', 'Buffer', 'describe', 'test', 'it', 'expect',
  'before', 'after', 'beforeEach', 'afterEach']);
/** Names the added code defines itself (visible in the hunk). */
const definedIn = (code) => new Set([...code.matchAll(/(?:function\s*\*?\s*|class\s+|(?:const|let|var)\s+)([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));

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
 * @param {string}  [a.sourceUnavailable] why there are no candidate files at all (no snapshot / failed / mismatch)
 * @returns {{ shown: Array, omitted: Array, missing: Array<{ what, reason }> }}
 */
function buildEvidence({ criterion, diff = null, files = [], tree = null, unavailable = [], missing = [], checks = [], wholeFiles = false, sourceUnavailable = null, budget = budgetChars() }) {
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
    const local = definedIn(added);
    const own = byPath.get(fd.file);
    const ownAst = own ? parseJs(own.text) : null;
    const imports = relativeImports(own ? own.text : fd.hunks.map((h) => h.lines.map((l) => l.slice(1)).join('\n')).join('\n'));
    // Same-file helpers: resolved in the candidate file's module scope. Without that
    // source (too large, not exported, unparsable, no snapshot) the calls cannot be
    // resolved — that is named as missing material, never skipped (QB-11 re-review).
    const needSource = [...bare].filter((n) => !imports.has(n) && !local.has(n) && !GLOBALS.has(n));
    if (needSource.length) {
      if (!own || !ownAst) {
        miss.push({ what: `source of ${fd.file} (to resolve calls to ${needSource.join(', ')})`,
          reason: own ? 'unparsable' : unavailableReason(fd.file) || sourceUnavailable || 'not exported' });
      } else {
        const top = topLevelDefs(ownAst, own.text);
        for (const n of needSource) {
          const d = top.get(n) || [];
          if (d.length === 1) addDef(own, d[0], true);
          else if (d.length > 1) miss.push({ what: `definition of ${n} (in ${fd.file})`, reason: `${d.length} module-scope definitions: ambiguous` });
        }
      }
    }
    // Imported helpers: the EXPORTED binding of the target module, from the candidate
    // tree — never the first declaration in the file; unresolvable → named as missing.
    const wanted = [...[...bare].filter((n) => imports.has(n)).map((n) => [n, imports.get(n), imports.get(n).imported === '*' || imports.get(n).imported === 'default' ? null : imports.get(n).imported]),
      ...member.filter(([ns]) => imports.has(ns) && imports.get(ns).imported === '*').map(([ns, fn]) => [`${ns}.${fn}`, imports.get(ns), fn])];
    for (const [shown, imp, name] of wanted) {
      const cands = importCandidates(fd.file, imp.spec);
      const target = cands.map((p) => byPath.get(p)).find(Boolean);
      const what = `definition of ${shown} (imported from ${imp.spec})`;
      if (!target) {
        const why = cands.map((p) => [p, unavailableReason(p)]).filter(([, r]) => r && r !== 'missing');
        miss.push({ what, reason: why.length ? why.map(([p, r]) => `${p} ${r}`).join(', ')
          : cands.length && cands.every((p) => unavailableReason(p) === 'missing') ? `not found in the candidate tree (${cands.join(', ')})`
            : sourceUnavailable || 'not retrieved' });
        continue;
      }
      const ast = parseJs(target.text);
      if (!ast) { miss.push({ what, reason: `${target.path}: unparsable` }); continue; }
      const eb = exportBindings(ast);
      const binding = { ...(name === null ? eb.module : eb.named.get(name)) };
      let def = null;
      if (binding.node) def = defOf(name || shown, binding.node, target.text);
      else if (binding.local) {
        const d = topLevelDefs(ast, target.text).get(binding.local) || [];
        if (d.length === 1) def = d[0];
        else binding.unresolved = d.length ? `${binding.local} has ${d.length} module-scope definitions` : `${binding.local} has no module-scope function definition`;
      }
      if (!def) { miss.push({ what, reason: `${target.path}: export binding not resolved (${binding.unresolved})` }); continue; }
      addDef(target, def, true);
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
  // No export: nothing is assumed complete — any call that needs candidate source is
  // named as missing (sourceUnavailable), so older records cannot authorize a judgment.
  if (!snap) return { files: [], tree: null, unavailable: [], missing: [], sourceUnavailable: 'no candidate snapshot' };
  if (snap.error) return { files: [], tree: null, unavailable: [], missing: [{ what: `candidate source files (${snap.error})`, reason: 'snapshot failed' }], sourceUnavailable: 'snapshot failed' };
  if (!snap.tree || snap.tree !== execution?.candidate_tree || (tested && tested !== snap.tree)) {
    return { files: [], tree: null, unavailable: [], missing: [{ what: 'candidate source files (snapshot_tree_mismatch)', reason: 'not the tested tree' }], sourceUnavailable: 'snapshot tree mismatch' };
  }
  return { files: snap.files || [], tree: snap.tree, unavailable: snap.skipped || [], missing: [], sourceUnavailable: null };
}

/** The evidence manifest for the report: provenance only, no contents. */
const manifestEntry = (it) => ({ id: it.id, kind: it.kind, file: it.file, range: it.range, source: it.source, tree: it.tree, blob: it.blob, sha256: it.sha256, material: it.material });

module.exports = { buildEvidence, parseDiff, definitions, exportBindings, topLevelDefs, parseJs, relativeImports, importCandidates, candidateFiles, manifestEntry, missingText, label, budgetChars };
