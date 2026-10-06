/**
 * context/symbols.js — parser-based symbol index for JavaScript (QB-19).
 *
 * The regex extractor dropped valid exports (`module.exports = { alpha, beta }`
 * kept only alpha), located a symbol at the first substring occurrence (often a
 * comment), keyed the symbol map by bare name (a second file overwrote the first),
 * and only ever saw the first 8,000 characters of a file.
 *
 * Here every JavaScript file (CommonJS and ESM) is parsed with acorn:
 *   - every top-level declaration (function, class, variable) and every method of a
 *     top-level class is a symbol with a qualified ID — `<path>#<name>`,
 *     `<path>#<Class>.<method>` — and its real source span from the AST;
 *   - exports are enumerated from the export statements in order (a later
 *     `module.exports = …` replaces the earlier export object; `exports.x` after
 *     that replacement exports nothing), each resolved to the declaration it
 *     names (an alias keeps `local`), never to a comment or a string;
 *   - whole files are indexed up to MAX_INDEX_BYTES; a larger file is recorded as
 *     `too_large`, an unparsable one as `unparsable` (with a regex fallback whose
 *     results are marked `method: "regex"`), so nothing is silent.
 * Other languages keep the regex extractor, marked `method: "regex"`.
 */

const path = require('path');
const { parseJs } = require('../verify/evidence');

const MAX_INDEX_BYTES = 256 * 1024;
const JS_PARSED = new Set(['.js', '.cjs', '.mjs']);

const span = (node) => ({
  start: { line: node.loc.start.line, column: node.loc.start.column + 1 },
  end:   { line: node.loc.end.line,   column: node.loc.end.column + 1 },
});
const keyOf = (k) => (k && k.type === 'Identifier' ? k.name : k && k.type === 'Literal' && typeof k.value === 'string' ? k.value : null);
const isFn = (n) => n && ['FunctionExpression', 'ArrowFunctionExpression'].includes(n.type);
const isClass = (n) => n && n.type === 'ClassExpression';
const kindOfValue = (n) => (isFn(n) ? 'function' : isClass(n) ? 'class' : 'variable');
const isModuleExports = (n) => n && n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'module'
  && keyOf(n.property) === 'exports';
const memberName = (m) => (m.computed ? (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : m.property.name);

/** Top-level declarations: name → { kind, node } (the statement, for its span). */
function declarations(ast) {
  const defs = new Map();
  const classes = [];
  const add = (name, kind, node) => { if (name && !defs.has(name)) defs.set(name, { kind, node }); };
  for (const st of ast.body) {
    const d = (st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration') && st.declaration ? st.declaration : st;
    if (d.type === 'FunctionDeclaration') add(d.id && d.id.name, 'function', st);
    else if (d.type === 'ClassDeclaration') { add(d.id && d.id.name, 'class', st); if (d.id) classes.push({ name: d.id.name, node: d }); }
    else if (d.type === 'VariableDeclaration') {
      for (const v of d.declarations) {
        if (v.id.type !== 'Identifier') continue;
        add(v.id.name, kindOfValue(v.init), d.declarations.length === 1 ? st : v);
        if (isClass(v.init)) classes.push({ name: v.id.name, node: v.init });
      }
    }
  }
  return { defs, classes };
}

/** Exports in statement order: [{ name, local?, kind, node }]. */
function exportsOf(ast) {
  let cjs = new Map();
  let replaced = false;
  const esm = new Map();
  const set = (map, name, rec) => { if (name) map.set(name, rec); };
  const value = (name, v, node) => (v.type === 'Identifier' ? { local: v.name, node }
    : { kind: kindOfValue(v), node, ...(isFn(v) || isClass(v) ? { valueNode: v } : {}) });
  for (const st of ast.body) {
    if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && st.expression.operator === '=') {
      const { left, right } = st.expression;
      if (isModuleExports(left)) {
        cjs = new Map();
        replaced = true;
        if (right.type === 'ObjectExpression') {
          for (const p of right.properties) {
            if (p.type !== 'Property') continue;
            const k = p.computed ? (p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null) : keyOf(p.key);
            if (!k) continue;
            set(cjs, k, p.shorthand ? { local: k, node: p } : (p.method ? { kind: 'function', node: p } : value(k, p.value, p)));
          }
        } else {
          const named = (isFn(right) || isClass(right)) && right.id ? right.id.name : null;
          set(cjs, named || 'module.exports', value('module.exports', right, st));
        }
        continue;
      }
      if (left.type === 'MemberExpression' && memberName(left) !== null && isModuleExports(left.object)) { set(cjs, memberName(left), value(memberName(left), right, st)); continue; }
      if (left.type === 'MemberExpression' && memberName(left) !== null && left.object.type === 'Identifier' && left.object.name === 'exports') {
        if (!replaced) set(cjs, memberName(left), value(memberName(left), right, st));
        continue;
      }
    } else if (st.type === 'ExportNamedDeclaration') {
      if (st.source) { for (const s of st.specifiers) set(esm, s.exported.name ?? s.exported.value, { kind: 're-export', node: st, from: st.source.value }); continue; }
      const d = st.declaration;
      if (d && d.id) set(esm, d.id.name, { local: d.id.name, node: st });
      else if (d && d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.type === 'Identifier') set(esm, v.id.name, { local: v.id.name, node: st });
      for (const s of st.specifiers || []) set(esm, s.exported.name ?? s.exported.value, { local: s.local.name, node: st });
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      set(esm, 'default', d.id ? { local: d.id.name, node: st } : d.type === 'Identifier' ? { local: d.name, node: st } : { kind: kindOfValue(d), node: st });
    }
  }
  return [...cjs, ...esm].map(([name, r]) => ({ name, ...r }));
}

/**
 * Index one JavaScript source.
 * @returns {{ status: 'parsed'|'unparsable', symbols: Array }}
 */
function indexJs(rel, content) {
  const ast = parseJs(content);
  if (!ast) return { status: 'unparsable', symbols: [] };
  const { defs, classes } = declarations(ast);
  const exported = exportsOf(ast);
  const out = new Map();
  const put = (rec) => { out.set(rec.id, rec); };

  for (const [name, d] of defs) put({ id: `${rel}#${name}`, name, kind: d.kind, exported: false, file: rel, span: span(d.node), method: 'parser' });
  const exportedClasses = new Set();
  for (const e of exported) {
    const local = e.local && defs.get(e.local);
    const rec = {
      id: `${rel}#${e.name}`, name: e.name, file: rel, exported: true, method: 'parser',
      kind: local ? local.kind : e.kind || 'variable',
      span: span(local ? local.node : (e.valueNode || e.node)),
      export_span: span(e.node),
      ...(e.local && e.local !== e.name ? { local: e.local } : {}),
      ...(e.from ? { from: e.from } : {}),
    };
    put(rec);
    if (local && local.kind === 'class') exportedClasses.add(e.local);
    if (e.local && e.local !== e.name) {   // the local declaration records the public name it is exported under
      const l = out.get(`${rel}#${e.local}`);
      if (l) l.exported_as = [...(l.exported_as || []), e.name];
    }
  }
  for (const c of classes) {
    for (const m of c.node.body.body) {
      if (m.type !== 'MethodDefinition' || m.kind === 'constructor') continue;
      const mname = keyOf(m.key);
      if (!mname || m.computed) continue;
      put({ id: `${rel}#${c.name}.${mname}`, name: `${c.name}.${mname}`, kind: 'method', exported: exportedClasses.has(c.name), file: rel, span: span(m), method: 'parser', ...(m.static ? { static: true } : {}) });
    }
  }
  return { status: 'parsed', symbols: [...out.values()] };
}

/** Regex fallback (other languages, unparsable JS): each match located at its own position. */
const REGEX_PATTERNS = [
  { langs: ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'], re: /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)/gm },
  { langs: ['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx'], re: /^(?:module\.)?exports\.(\w+)\s*=/gm },
  { langs: ['.py'], re: /^(?:def|class|async def)\s+(\w+)/gm },
  { langs: ['.go'], re: /^(?:func|type)\s+(\w+)/gm },
];
function indexRegex(rel, content) {
  const ext = path.extname(rel).toLowerCase();
  const out = new Map();
  for (const { langs, re } of REGEX_PATTERNS) {
    if (!langs.includes(ext)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      const line = content.slice(0, m.index).split('\n').length;
      const id = `${rel}#${m[1]}`;
      if (!out.has(id)) out.set(id, { id, name: m[1], kind: 'unknown', exported: !/^(def|class|async def|func|type)/.test(m[0]) || ext === '.go' || ext === '.py', file: rel, span: { start: { line, column: 1 }, end: { line, column: 1 } }, method: 'regex' });
    }
  }
  return [...out.values()];
}

/**
 * Index a file's full content.
 * @param {string} rel     repository-relative path
 * @param {string|null} content  the whole file, or null if not read
 * @param {number} bytes   the file's size
 * @returns {{ status: 'parsed'|'regex'|'unparsable'|'too_large'|'unreadable', symbols: Array }}
 */
function indexFile(rel, content, bytes) {
  if (bytes > MAX_INDEX_BYTES) return { status: 'too_large', symbols: [] };
  if (content === null) return { status: 'unreadable', symbols: [] };
  const ext = path.extname(rel).toLowerCase();
  if (JS_PARSED.has(ext)) {
    const r = indexJs(rel, content);
    if (r.status === 'parsed') return r;
    return { status: 'unparsable', symbols: indexRegex(rel, content) };
  }
  const symbols = indexRegex(rel, content);
  return { status: symbols.length || ['.py', '.go', '.ts', '.tsx', '.jsx'].includes(ext) ? 'regex' : 'not_indexed', symbols };
}

module.exports = { indexFile, indexJs, MAX_INDEX_BYTES };
