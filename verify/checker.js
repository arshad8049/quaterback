/**
 * checker.js — DSA Stage 1 of Layer 4
 *
 * Deterministic evidence collection. No LLM. Runs before the judge.
 * Three passes:
 *   1. Test results — taken from the sandbox verification stage (never run on the host)
 *   2. (scope is enforced policy: verify/policy.js, QB-09)
 *   3. Search hints — symbols and keywords in the diff, for the judge (QB-12: hints
 *      with provenance, never facts)
 */

const acorn = require('acorn');
const { classifyTestRun } = require('./tests');

/**
 * Run all deterministic checks. Nothing here executes repository code: test
 * results come from the sandbox's verification stage (QB-02, agent-sandbox.md
 * §3.5), which ran the base test command on a disposable copy of the candidate.
 *
 * @param {object} contract  - TaskContract
 * @param {object|null} context  - ContextPackage (for test files + relevant files)
 * @param {string|null} diff     - Raw git diff string from ExecutionResult
 * @param {string} _repoPath     - unused (kept for call compatibility)
 * @param {object|null} execution - ExecutionResult (sandbox.verification carries the test output)
 * @returns {{ testResults, diffSignals }}
 */
function runChecks(contract, context, diff, _repoPath, execution = null) {
  const testResults     = testsFromSandbox(execution);
  const diffSignals     = scanDiff(diff, contract);

  return { testResults, diffSignals };
}

// ─── 1. Test results (from the sandbox) ───────────────────────────────────────

function testsFromSandbox(execution) {
  const v = execution?.sandbox?.verification;
  if (!v || v.status !== 'ran' || typeof v.output !== 'string') return null;
  // Counts come from the classified run (verify/tests.js, QB-06); the verdict uses
  // its outcome, so an unparsed or broken run is never read as "0 failed".
  const c = classifyTestRun(v);
  const n = c.counts || { passed: 0, failed: 0, skipped: 0 };
  return { passed: n.passed, failed: c.outcome === 'failed' ? Math.max(1, n.failed) : n.failed, skipped: n.skipped,
    output: v.output.slice(0, 2000) };
}

// (QB-09: scope is enforced policy in verify/policy.js, from the approved contract —
//  retrieval relevance is never an allowlist.)

// ─── 3. Search hints (QB-12) ──────────────────────────────────────────────────

/*
 * The judge gets hints about the symbols and words the contract names. They are
 * hints with provenance, never facts, and they never decide a behavioural
 * criterion (that is the executable checks, QB-16):
 *
 *   symbols[name].defined / .exported
 *     confirmed_added      a real binding in ADDED code (JS parsed with acorn)
 *     confirmed_unchanged  a real binding in unchanged code shown as diff context
 *                          (pre-existing)
 *     hint                 heuristic: the hunk did not parse on its own (the name is an
 *                          identifier token in added code; comments/strings skipped
 *                          where tokenizable), or the hunk alone cannot establish the
 *                          binding (an export inside a function, or an indented one in
 *                          a hunk that may sit inside an unseen scope)
 *     not_in_diff          not seen in the changed hunks: UNKNOWN. Unchanged code may
 *                          already implement it; absence from the diff is never
 *                          evidence of absence.
 *   symbols[name].exported is about the PUBLIC name; aliases are kept apart:
 *     exported_as { publicName: status }  this LOCAL binding exported under another
 *                          name ("module.exports" / "default" = the module itself)
 *     local                the local binding behind this exported name, if different
 *     from                 the source module of a re-export
 *   symbols[name].returns  yes | no — from that function's OWN parsed body (a
 *                          return in another function does not count) | unknown
 *   keywords.found / not_found  contract words in ADDED lines only (search hints)
 *
 * Deleted lines are never read. Comments and strings never count as code.
 */

const PARSE_OPTS = {
  ecmaVersion: 'latest', locations: true, allowReturnOutsideFunction: true, allowHashBang: true,
  allowImportExportEverywhere: true, allowAwaitOutsideFunction: true,
};
const RANK = { not_in_diff: 0, hint: 1, confirmed_unchanged: 2, confirmed_added: 3 };
const better = (a, b) => (RANK[b] > RANK[a] ? b : a);

/** The diff as files → hunks → post-image lines ({ text, added }). Deleted lines are dropped. */
function parseDiff(diff) {
  const files = [];
  let file = null, hunk = null;
  for (const line of String(diff).split('\n')) {
    const g = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (g) { file = { path: g[1], hunks: [] }; files.push(file); hunk = null; continue; }
    if (!file) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      hunk = { start: m ? Number(m[1]) : 0, lines: [] }; file.hunks.push(hunk); continue;
    }
    if (!hunk || line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) hunk.lines.push({ text: line.slice(1), added: true });
    else if (line.startsWith(' ')) hunk.lines.push({ text: line.slice(1), added: false });
    // '-' (deleted) and '\ No newline' lines are not part of the post-image
  }
  return files;
}

function tryParse(code) {
  for (const sourceType of ['module', 'script']) {
    try { return acorn.parse(code, { ...PARSE_OPTS, sourceType }); } catch { /* next */ }
  }
  return null;
}

/** Depth-first walk over an acorn AST. visit(node, ancestors) — ancestors outermost first. */
function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const inner = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, inner));
    else if (v && typeof v.type === 'string') walk(v, visit, inner);
  }
}

const isFn = (n) => n && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration|ClassExpression|ClassDeclaration)$/.test(n.type);
const isFunction = (n) => n && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration)$/.test(n.type);
/**
 * A property / member key as a literal name. A computed key is a name only when it
 * is a string literal (`exports["clamp"]`); `exports[k]` / `{ [k]: … }` name
 * whatever k holds at run time, which is not resolved here → null.
 */
function keyName(key, computed) {
  if (!key) return null;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'TemplateLiteral' && !key.expressions.length) return key.quasis[0].value.cooked;
  if (computed) return null;
  return key.type === 'Identifier' ? key.name : key.type === 'Literal' ? String(key.value) : null;
}
const memberName = (m) => keyName(m.property, m.computed);
const exportName = (n) => (n ? (n.type === 'Identifier' ? n.name : n.type === 'Literal' ? String(n.value) : null) : null);

// ─── Scope (QB-12 re-review): is `module` / `exports` the CommonJS one here? ──

/** Names bound by a pattern (params, declarators, catch params). */
function patternNames(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((e) => patternNames(e, out));
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  return out;
}

/** `var` names and function declarations hoisted to `root`'s function scope (nested functions not entered). */
function hoisted(root, out) {
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n !== root && isFunction(n)) { if (n.type === 'FunctionDeclaration' && n.id) out.add(n.id.name); return; }
    if (n.type === 'VariableDeclaration' && n.kind === 'var') n.declarations.forEach((d) => patternNames(d.id).forEach((x) => out.add(x)));
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(root);
}

/** Lexical (let/const/class/function-in-block) names declared directly in a statement list. */
function lexical(stmts, out) {
  for (const s of stmts || []) {
    const d = s && (s.type === 'ExportNamedDeclaration' ? s.declaration : s);
    if (!d) continue;
    if (d.type === 'VariableDeclaration' && d.kind !== 'var') d.declarations.forEach((v) => patternNames(v.id).forEach((x) => out.add(x)));
    else if ((d.type === 'ClassDeclaration' || d.type === 'FunctionDeclaration') && d.id) out.add(d.id.name);
    else if (d.type === 'ImportDeclaration') d.specifiers.forEach((sp) => out.add(sp.local.name));
  }
}

const scopeCache = new WeakMap();
/** The names a scope-creating node declares (memoized per node). */
function declaredBy(node) {
  if (scopeCache.has(node)) return scopeCache.get(node);
  const out = new Set();
  if (isFunction(node)) {
    node.params.forEach((p) => patternNames(p).forEach((x) => out.add(x)));
    if (node.type === 'FunctionExpression' && node.id) out.add(node.id.name);
    hoisted(node, out);
    if (node.body?.type === 'BlockStatement') lexical(node.body.body, out);
  } else if (node.type === 'Program') {
    hoisted(node, out);
    lexical(node.body, out);
  } else if (node.type === 'BlockStatement' || node.type === 'StaticBlock') lexical(node.body, out);
  else if (node.type === 'SwitchStatement') node.cases.forEach((c) => lexical(c.consequent, out));
  else if (node.type === 'CatchClause') patternNames(node.param).forEach((x) => out.add(x));
  else if (/^For(In|Of)?Statement$/.test(node.type)) {
    const d = node.init || node.left;
    if (d?.type === 'VariableDeclaration' && d.kind !== 'var') d.declarations.forEach((v) => patternNames(v.id).forEach((x) => out.add(x)));
  } else if (node.type === 'ClassExpression' && node.id) out.add(node.id.name);
  scopeCache.set(node, out);
  return out;
}
const shadowed = (name, ancestors) => ancestors.some((a) => declaredBy(a).has(name));

/**
 * Which CommonJS export object a member target writes to: the root identifier
 * ('exports' for exports.x, 'module' for module.exports.x), or null.
 */
function cjsRoot(target) {
  if (!target || target.type !== 'MemberExpression') return null;
  const o = target.object;
  if (o?.type === 'Identifier' && o.name === 'exports') return 'exports';
  if (isModuleExports(o)) return 'module';
  return null;
}
const isModuleExports = (n) => n && n.type === 'MemberExpression' && n.object?.type === 'Identifier' && n.object.name === 'module' && memberName(n) === 'exports';

/** Whether a function's OWN body returns a value (nested functions don't count). */
function ownReturn(fn) {
  if (!fn) return 'unknown';
  if (fn.type === 'ArrowFunctionExpression' && fn.expression) return 'yes';
  if (/^Class/.test(fn.type)) return 'unknown';
  let found = false;
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return;
    if (n !== fn.body && isFn(n)) return;                         // a nested function's return is not this one's
    if (n.type === 'ReturnStatement' && n.argument) { found = true; return; }
    for (const key of Object.keys(n)) {
      if (key === 'loc') continue;
      const v = n[key];
      if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v.type === 'string') visit(v);
    }
  };
  visit(fn.body);
  return found ? 'yes' : 'no';
}

/**
 * Bindings and exports for `names` in one parsed hunk.
 *
 * `exported` is about the PUBLIC name: symbols.clamp.exported means a consumer can
 * reach `clamp` by that name. A local binding exported under another name is
 * recorded on the local as `exported_as: { other: status }` and on the public
 * name as `local: "clamp"`; `module.exports = clamp` / `export default clamp`
 * export the module itself (`exported_as: { "module.exports" | "default": … }`).
 * Re-exports carry `from`.
 *
 * CommonJS writes count only when `module` / `exports` is the module's own
 * binding: shadowed by a parameter, local, catch parameter or hoisted var, or
 * `exports` rebound to a fresh object → not a module export (a function written
 * there is only a hint of a definition). A write inside a function in the hunk
 * runs only if that function is called → hint. The hunk is a fragment: when it
 * starts below the top of the file and the statement is indented, it may sit
 * inside a function the diff does not show → hint, never confirmed.
 */
function analyzeAst(ast, addedLine, names, out, filePath, hunkStart) {
  const where = (node) => (addedLine(node.loc.start.line) ? 'confirmed_added' : 'confirmed_unchanged');
  const define = (name, node, fn, status = where(node)) => {
    if (!names.has(name)) return;
    const s = out[name];
    if (RANK[status] > RANK[s.defined]) { s.defined = status; s.returns = ownReturn(fn); s.file = filePath; }
  };
  const exportOf = (pub, local, status, from = null) => {
    if (pub !== null && names.has(pub)) {
      const s = out[pub];
      s.exported = better(s.exported, status);
      if (local && local !== pub) s.local = local;
      if (from) s.from = from;
    }
    if (!from && local && local !== pub && names.has(local)) {
      const ex = (out[local].exported_as ||= {});
      const key = pub === null ? '(computed name)' : pub;
      ex[key] = better(ex[key] || 'not_in_diff', pub === null ? 'hint' : status);
    }
  };

  // `exports = {…}` (not `exports = module.exports = …`) detaches exports from the module.
  let exportsRebound = false;
  walk(ast, (n, anc) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === 'exports' && !shadowed('exports', anc)) {
      const r = n.right;
      if (!(isModuleExports(r) || (r.type === 'AssignmentExpression' && isModuleExports(r.left)))) exportsRebound = true;
    }
  });

  const cjsStatus = (n, anc, root) => {
    if (shadowed(root, anc) || (root === 'exports' && exportsRebound)) return null;   // not the module's binding
    if (anc.some(isFunction)) return 'hint';                                           // runs only if called
    const stmt = anc[1] || n;
    if (hunkStart > 1 && stmt.loc.start.column > 0) return 'hint';                     // maybe in an unseen scope
    return where(n);
  };
  const localOf = (v) => (v?.type === 'Identifier' ? v.name : isFn(v) && v.id ? v.id.name : null);

  walk(ast, (n, anc) => {
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) define(n.id.name, n, n); }
    else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isFn(n.init)) define(n.id.name, n, n.init);
    else if ((n.type === 'Property' || n.type === 'MethodDefinition') && isFn(n.value)) define(keyName(n.key, n.computed), n, n.value);
    else if (n.type === 'AssignmentExpression') {
      if (isModuleExports(n.left)) {                                       // module.exports = …
        const status = cjsStatus(n, anc, 'module');
        if (!status) return;
        const r = n.right;
        if (r.type === 'ObjectExpression') {
          for (const p of r.properties) if (p.type === 'Property') exportOf(keyName(p.key, p.computed), localOf(p.value), status);
        } else if (r.type === 'Identifier') exportOf('module.exports', r.name, status);
        else if (isFn(r) && r.id) { define(r.id.name, n, r, status); exportOf('module.exports', r.id.name, status); }
      } else {
        const root = cjsRoot(n.left);                                      // exports.x = … / module.exports.x = …
        if (!root) return;
        const pub = memberName(n.left);
        const status = cjsStatus(n, anc, root);
        if (!status) { if (pub && isFn(n.right)) define(pub, n, n.right, 'hint'); return; }
        exportOf(pub, localOf(n.right) || (pub && isFn(n.right) ? pub : null), status);
        if (pub && isFn(n.right)) define(pub, n, n.right, status);
      }
    } else if (n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration' || n.type === 'ExportAllDeclaration') {
      const status = anc.some(isFunction) ? 'hint' : where(n);             // ESM exports are top-level by syntax
      const from = n.source ? String(n.source.value) : null;
      if (n.type === 'ExportDefaultDeclaration') {
        const d = n.declaration;
        exportOf('default', d?.type === 'Identifier' ? d.name : d?.id?.name || null, status);
      } else if (n.type === 'ExportAllDeclaration') {
        if (n.exported) exportOf(exportName(n.exported), null, status, from);
      } else {
        const d = n.declaration;
        if (d?.id) exportOf(d.id.name, d.id.name, status);
        if (d?.type === 'VariableDeclaration') d.declarations.forEach((v) => patternNames(v.id).forEach((x) => exportOf(x, x, status)));
        for (const s of n.specifiers || []) {
          const pub = exportName(s.exported), local = exportName(s.local);
          if (from) { exportOf(pub, null, status, from); if (pub !== null && names.has(pub) && local !== pub) out[pub].local = local; }
          else exportOf(pub, local, status);
        }
      }
    }
  });
}

/** Unparseable hunk: identifier tokens on added lines (comments/strings skipped) → hint. */
function hintFromTokens(code, addedLine, names, out) {
  const seen = new Set();
  try {
    for (const t of acorn.tokenizer(code, { ...PARSE_OPTS })) {
      if (t.type.label === 'name' && names.has(t.value) && addedLine(t.loc.start.line)) seen.add(t.value);
    }
  } catch {
    // Not even tokenizable (e.g. a hunk starting inside a comment or template):
    // fall back to added text with line comments removed. Still only a hint.
    for (const [i, l] of code.split('\n').entries()) {
      if (!addedLine(i + 1)) continue;
      const text = l.replace(/\/\/.*$/, '');
      for (const n of names) if (new RegExp(`\\b${n}\\b`).test(text)) seen.add(n);
    }
  }
  for (const n of seen) {
    out[n].defined = better(out[n].defined, 'hint');
    out[n].exported = better(out[n].exported, 'hint');
  }
}

/** Symbol names the contract talks about (camelCase, snake_case, explicit name()). */
function contractNames(contract) {
  const allText = [
    contract.goal || '',
    ...(contract.acceptance_criteria || []).map(ac => ac.criterion),
    ...(contract.required_behavior   || []),
  ].join(' ');
  return [...new Set(
    (allText.match(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:[A-Z][a-zA-Z0-9_]*)+)\b/g) || [])            // camelCase
      .concat(allText.match(/\b([a-z][a-z0-9_]*_[a-z][a-z0-9_]*)\b/g) || [])                  // snake_case
      .concat(allText.match(/\b([a-zA-Z_]\w+\(\))/g)?.map(s => s.replace('()', '')) || []),  // explicit fn()
  )].filter(n => n.length > 3);
}

/**
 * @returns {{ version: 2, symbols: Object<string, { defined, exported, returns, file? }>,
 *             keywords: { found: string[], not_found: string[] } }}
 */
function scanDiff(diff, contract) {
  if (!diff) return {};
  const names = new Set(contractNames(contract));
  const symbols = {};
  for (const n of names) symbols[n] = { defined: 'not_in_diff', exported: 'not_in_diff', returns: 'unknown' };

  const files = parseDiff(diff);
  const addedText = [];
  for (const f of files) {
    for (const h of f.hunks) {
      const code = h.lines.map((l) => l.text).join('\n');
      const addedLine = (n) => Boolean(h.lines[n - 1] && h.lines[n - 1].added);
      h.lines.filter((l) => l.added).forEach((l) => addedText.push(l.text));
      if (!names.size) continue;
      const ast = /\.(c|m)?jsx?$/.test(f.path) ? tryParse(code) : null;
      if (ast) analyzeAst(ast, addedLine, names, symbols, f.path, h.start);
      else hintFromTokens(code, addedLine, names, symbols);
    }
  }

  // Keyword search hints: contract words found in ADDED lines only.
  const added = addedText.join('\n').toLowerCase();
  const terms = [...new Set([
    ...(contract.acceptance_criteria || []).map(ac => ac.criterion),
    ...(contract.required_behavior   || []),
  ].join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 4)
    .filter(w => !STOP_WORDS.has(w)))];
  const keywords = { found: terms.filter((t) => added.includes(t)), not_found: terms.filter((t) => !added.includes(t)) };

  return { version: 2, symbols, keywords };
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'into', 'make', 'sure', 'also',
  'when', 'them', 'then', 'than', 'been', 'were', 'will', 'would', 'could',
  'should', 'like', 'some', 'just', 'more', 'what', 'which', 'their',
  'there', 'about', 'your', 'work', 'must', 'does', 'ensure', 'existing',
  'users', 'user', 'code', 'file', 'without', 'properly', 'correctly',
]);

module.exports = { runChecks, scanDiff };
