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
 *     hint                 the hunk did not parse on its own; the name appears as an
 *                          identifier token in added code (comments/strings skipped
 *                          where tokenizable) — heuristic
 *     not_in_diff          not seen in the changed hunks: UNKNOWN. Unchanged code may
 *                          already implement it; absence from the diff is never
 *                          evidence of absence.
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
    if (line.startsWith('@@')) { hunk = { lines: [] }; file.hunks.push(hunk); continue; }
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

/** Depth-first walk over an acorn AST. visit(node, parent) */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, node));
    else if (v && typeof v.type === 'string') walk(v, visit, node);
  }
}

const isFn = (n) => n && /^(FunctionExpression|ArrowFunctionExpression|FunctionDeclaration|ClassExpression|ClassDeclaration)$/.test(n.type);
const propName = (k) => (k ? (k.type === 'Identifier' ? k.name : k.type === 'Literal' ? String(k.value) : null) : null);
const isModuleExports = (n) => n && n.type === 'MemberExpression' && n.object?.name === 'module' && propName(n.property) === 'exports';
const isExportsTarget = (n) => n && n.type === 'MemberExpression' && (n.object?.name === 'exports' || isModuleExports(n.object));

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

/** Bindings and exports for `names` in one parsed hunk. */
function analyzeAst(ast, addedLine, names, out, filePath) {
  const where = (node) => (addedLine(node.loc.start.line) ? 'confirmed_added' : 'confirmed_unchanged');
  const define = (name, node, fn) => {
    if (!names.has(name)) return;
    const s = out[name];
    const w = where(node);
    if (RANK[w] > RANK[s.defined]) { s.defined = w; s.returns = ownReturn(fn); s.file = filePath; }
  };
  const exportOf = (name, node) => { if (names.has(name)) out[name].exported = better(out[name].exported, where(node)); };

  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') { if (n.id) define(n.id.name, n, n); }
    else if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && isFn(n.init)) define(n.id.name, n, n.init);
    else if ((n.type === 'Property' || n.type === 'MethodDefinition') && isFn(n.value)) define(propName(n.key), n, n.value);
    else if (n.type === 'AssignmentExpression') {
      if (isModuleExports(n.left)) {
        if (n.right.type === 'ObjectExpression') {
          for (const p of n.right.properties) if (p.type === 'Property') exportOf(propName(p.key), p);
        } else if (n.right.type === 'Identifier') exportOf(n.right.name, n);
        else if (isFn(n.right) && n.right.id) { define(n.right.id.name, n, n.right); exportOf(n.right.id.name, n); }
      } else if (isExportsTarget(n.left)) {
        const name = propName(n.left.property);
        exportOf(name, n);
        if (isFn(n.right)) define(name, n, n.right);
      }
    } else if (n.type === 'ExportNamedDeclaration') {
      const d = n.declaration;
      if (d?.id) exportOf(d.id.name, n);
      if (d?.type === 'VariableDeclaration') d.declarations.forEach((v) => v.id?.type === 'Identifier' && exportOf(v.id.name, n));
      for (const s of n.specifiers || []) exportOf(s.local?.name, n);
    } else if (n.type === 'ExportDefaultDeclaration' && n.declaration?.id) exportOf(n.declaration.id.name, n);
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
      if (ast) analyzeAst(ast, addedLine, names, symbols, f.path);
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
