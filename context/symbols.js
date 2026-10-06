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
const isFn = (n) => n && ['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration'].includes(n.type);
const isClass = (n) => n && ['ClassExpression', 'ClassDeclaration'].includes(n.type);
const kindOfValue = (n) => (isFn(n) ? 'function' : isClass(n) ? 'class' : 'variable');
const isModuleExports = (n) => n && n.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'module'
  && keyOf(n.property) === 'exports';
/** `require('…')` or `require('…').x` — a CommonJS import. */
const isRequireCall = (n) => Boolean(n) && ((n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'require')
  || (n.type === 'MemberExpression' && isRequireCall(n.object)));
const memberName = (m) => (m.computed ? (m.property.type === 'Literal' && typeof m.property.value === 'string' ? m.property.value : null) : m.property.name);

/**
 * Every name a binding pattern declares (re-review 1): identifiers, object patterns
 * (aliases `{ a: b }` bind b), defaults (`{ a = 1 }`), rest (`...r`), arrays (holes
 * skipped) and any nesting. Returns [{ name, node }] with each identifier's own node.
 */
function bindingNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier': return [{ name: pattern.name, node: pattern }];
    case 'ObjectPattern': return pattern.properties.flatMap((p) => (p.type === 'RestElement' ? bindingNames(p.argument) : bindingNames(p.value)));
    case 'ArrayPattern': return pattern.elements.flatMap((e) => bindingNames(e));
    case 'AssignmentPattern': return bindingNames(pattern.left);
    case 'RestElement': return bindingNames(pattern.argument);
    default: return [];
  }
}

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
        if (v.id.type !== 'Identifier') {   // destructuring: every bound name, at its own identifier
          // `const { x } = require('./m')` is an import of m's x, not a declaration of x here
          // (indexing it would make an importer look like the definer).
          if (isRequireCall(v.init)) continue;
          for (const b of bindingNames(v.id)) add(b.name, 'variable', b.node);
          continue;
        }
        add(v.id.name, kindOfValue(v.init), d.declarations.length === 1 ? st : v);
        if (isClass(v.init)) classes.push({ name: v.id.name, node: v.init });
      }
    }
  }
  return { defs, classes };
}

/** Exports in statement order: [{ name, local?, kind, node }]. */
function exportsOf(ast, unindexed) {
  let cjs = new Map();
  let replaced = false;
  let anonymousDefaultClass = null;
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
            if (p.type !== 'Property') { unindexed.push({ line: p.loc.start.line, reason: 'spread in the module.exports object: its names are not known statically' }); continue; }
            const k = p.computed ? (p.key.type === 'Literal' && typeof p.key.value === 'string' ? p.key.value : null) : keyOf(p.key);
            if (!k) { unindexed.push({ line: p.loc.start.line, reason: 'computed key in the module.exports object' }); continue; }
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
      else if (d && d.type === 'VariableDeclaration') for (const v of d.declarations) for (const b of bindingNames(v.id)) set(esm, b.name, { local: b.name, node: st });
      for (const s of st.specifiers || []) set(esm, s.exported.name ?? s.exported.value, { local: s.local.name, node: st });
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      set(esm, 'default', d.id ? { local: d.id.name, node: st } : d.type === 'Identifier' ? { local: d.name, node: st } : { kind: kindOfValue(d), node: st });
      if (isClass(d) && !d.id) anonymousDefaultClass = d;
    }
  }
  return { list: [...cjs, ...esm].map(([name, r]) => ({ name, ...r })), anonymousDefaultClass };
}

/**
 * Index one JavaScript source.
 * @returns {{ status: 'parsed'|'partial'|'unparsable', symbols: Array, unindexed?: Array<{ line, reason }> }}
 */
function indexJs(rel, content) {
  const ast = parseJs(content);
  if (!ast) return { status: 'unparsable', symbols: [] };
  const unindexed = [];   // visited but not nameable statically: reported, never a silent success
  const { defs, classes } = declarations(ast);
  const { list: exported, anonymousDefaultClass } = exportsOf(ast, unindexed);
  if (anonymousDefaultClass) classes.push({ name: 'default', node: anonymousDefaultClass, exported: true });
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
  // Class members (re-review 1). IDs keep every distinct callable distinct:
  //   instance  <path>#<Class>.<name>            static  <path>#<Class>.static.<name>
  //   accessors <path>#<Class>.<name>[get|set]   (static ones under .static.)
  //   private   <path>#<Class>.#<name>           fields  <path>#<Class>.<field>
  for (const c of classes) {
    for (const m of c.node.body.body) {
      if (m.type === 'StaticBlock' || (m.type === 'MethodDefinition' && m.kind === 'constructor')) continue;
      if (m.type !== 'MethodDefinition' && m.type !== 'PropertyDefinition') continue;
      const priv = m.key.type === 'PrivateIdentifier';
      const mname = priv ? `#${m.key.name}` : m.computed ? (m.key.type === 'Literal' && typeof m.key.value === 'string' ? m.key.value : null) : keyOf(m.key);
      if (!mname) { unindexed.push({ line: m.loc.start.line, reason: `computed member name in class ${c.name}` }); continue; }
      const role = m.type === 'PropertyDefinition' ? 'field' : m.kind === 'get' ? 'getter' : m.kind === 'set' ? 'setter' : 'method';
      const suffix = role === 'getter' ? '[get]' : role === 'setter' ? '[set]' : '';
      const id = `${rel}#${c.name}.${m.static ? 'static.' : ''}${mname}${suffix}`;
      put({ id, name: `${c.name}.${mname}`, kind: role === 'field' && !isFn(m.value) ? 'field' : 'method', role,
        exported: Boolean(c.exported) || exportedClasses.has(c.name), file: rel, span: span(m), method: 'parser',
        ...(m.static ? { static: true } : {}), ...(priv ? { private: true } : {}) });
    }
  }
  return { status: unindexed.length ? 'partial' : 'parsed', symbols: [...out.values()], ...(unindexed.length ? { unindexed } : {}) };
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
 * @returns {{ status: 'parsed'|'partial'|'regex'|'unparsable'|'too_large'|'unreadable', symbols: Array, unindexed?: Array }}
 */
function indexFile(rel, content, bytes) {
  if (bytes > MAX_INDEX_BYTES) return { status: 'too_large', symbols: [] };
  if (content === null) return { status: 'unreadable', symbols: [] };
  const ext = path.extname(rel).toLowerCase();
  if (JS_PARSED.has(ext)) {
    const r = indexJs(rel, content);
    if (r.status === 'parsed' || r.status === 'partial') return r;
    return { status: 'unparsable', symbols: indexRegex(rel, content) };
  }
  const symbols = indexRegex(rel, content);
  return { status: symbols.length || ['.py', '.go', '.ts', '.tsx', '.jsx'].includes(ext) ? 'regex' : 'not_indexed', symbols };
}

module.exports = { indexFile, indexJs, MAX_INDEX_BYTES };
