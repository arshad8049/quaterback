const fs   = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', 'vendor',
]);

const CODE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs']);

// ─── Symbol extraction ────────────────────────────────────────────────────────

const SYMBOL_PATTERNS = [
  // ESM: export function foo / export const foo / export class Foo
  { lang: 'js', regex: /^export\s+(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/gm },
  // CJS: exports.foo = ...
  { lang: 'js', regex: /^exports\.(\w+)\s*=/gm },
  // CJS: module.exports = function/class Name (single named export)
  { lang: 'js', regex: /^module\.exports\s*=\s*(?:async\s+)?(?:function|class)\s+(\w+)/gm },
  // Python: def foo / class Foo
  { lang: 'py', regex: /^(?:def|class|async def)\s+(\w+)/gm },
  // Go: func FooBar / type FooBar
  { lang: 'go', regex: /^(?:func|type)\s+(\w+)/gm },
];

/**
 * Extract exported symbol names from a file.
 * Returns array of symbol names.
 */
const CJS_RESERVED = new Set(['true', 'false', 'null', 'undefined', 'require', 'function', 'class', 'const', 'let', 'var', 'async', 'return', 'new']);

function extractSymbols(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();
  const isJs = ['.js', '.ts', '.jsx', '.tsx'].includes(ext);
  const symbols = new Set();

  for (const { lang, regex } of SYMBOL_PATTERNS) {
    const isMatch =
      (lang === 'js' && isJs) ||
      (lang === 'py' && ext === '.py') ||
      (lang === 'go' && ext === '.go');

    if (!isMatch) continue;

    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const name = m[1] || m[2];
      if (name && name.length > 1 && !/^(true|false|null|undefined|require)$/.test(name)) {
        symbols.add(name);
      }
    }
  }

  // CJS: module.exports = { foo, bar } or { foo: fn } — extract object property names
  if (isJs) {
    const objMatch = content.match(/module\.exports\s*=\s*\{([^}]{1,600})\}/);
    if (objMatch) {
      const body = objMatch[1];
      const keyRe = /\b(\w+)\s*[,:{]/g;
      let km;
      while ((km = keyRe.exec(body)) !== null) {
        const name = km[1];
        if (name && name.length > 1 && !CJS_RESERVED.has(name)) {
          symbols.add(name);
        }
      }
    }
  }

  return [...symbols];
}

// ─── Import graph tracing ─────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  // ESM: import X from './foo'  |  import { X } from '../foo'
  /(?:^|\n)\s*import\s+.*?from\s+['"]([^'"]+)['"]/g,
  // CJS: require('./foo')
  /require\(['"]([^'"]+)['"]\)/g,
  // Python: from .foo import  |  import foo
  /(?:^|\n)\s*from\s+([\w.]+)\s+import/g,
  /(?:^|\n)\s*import\s+([\w.]+)/g,
];

/**
 * Extract import paths from a file's content.
 * Returns only relative imports (starts with . or /) — skips npm packages.
 */
function extractImports(content) {
  const imports = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content)) !== null) {
      const imp = m[1];
      if (imp && (imp.startsWith('.') || imp.startsWith('/'))) {
        imports.add(imp);
      }
    }
  }
  return [...imports];
}

/**
 * Resolve a relative import path to an absolute file path.
 * Tries common extensions if no extension present.
 */
function resolveImport(fromFile, importPath, repoPath) {
  const fromDir = path.dirname(fromFile);
  const candidate = path.resolve(fromDir, importPath);

  const exts = ['', '.ts', '.tsx', '.js', '.jsx', '.py', '/index.ts', '/index.js'];
  for (const ext of exts) {
    const full = candidate + ext;
    if (fs.existsSync(full)) {
      return path.relative(repoPath, full);
    }
  }
  return null;
}

// ─── Test file finder ─────────────────────────────────────────────────────────

/**
 * Given a source file path, find its associated test file.
 * Looks for __tests__/ sibling, .test.ext, .spec.ext patterns.
 */
function findTestFile(filePath, repoPath) {
  const abs    = path.join(repoPath, filePath);
  const dir    = path.dirname(abs);
  const base   = path.basename(abs);
  const ext    = path.extname(base);
  const stem   = path.basename(base, ext);

  const candidates = [
    path.join(dir, '__tests__', `${stem}.test${ext}`),
    path.join(dir, '__tests__', `${stem}.spec${ext}`),
    path.join(dir, `${stem}.test${ext}`),
    path.join(dir, `${stem}.spec${ext}`),
    path.join(dir, '__tests__', `${stem}${ext}`),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return path.relative(repoPath, c);
  }
  return null;
}

/**
 * Walk the repo and collect all test files.
 */
function findAllTestFiles(repoPath) {
  const results = [];
  walk(repoPath, repoPath, results);
  return results.filter(f =>
    /\.(test|spec)\.(js|ts|jsx|tsx|py|go)$/.test(f) ||
    f.includes('__tests__')
  );
}

// ─── Relevance scoring ────────────────────────────────────────────────────────

/**
 * Score files in the repo against keywords from the Task Contract.
 * Returns top N files sorted by relevance.
 */
function scoreFiles(repoPath, keywords, maxFiles = 20) {
  const files = [];
  walk(repoPath, repoPath, files);

  return files
    .map(rel => {
      const nameLower = path.basename(rel).toLowerCase();
      const relLower  = rel.toLowerCase();
      let score = 0;

      const ext = path.extname(rel).toLowerCase();
      if (CODE_EXTS.has(ext)) score += 2;

      for (const kw of keywords) {
        if (nameLower.includes(kw)) score += 5;
        else if (relLower.includes(kw)) score += 2;
      }

      return { rel, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxFiles)
    .map(f => f.rel);
}

/**
 * Extract keywords from a Task Contract for relevance scoring.
 */
function contractKeywords(contract) {
  const text = [
    contract.goal || '',
    ...(contract.required_behavior || []),
    ...(contract.relevant_context || []),
  ].join(' ');

  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !STOP_WORDS.has(w));
}

// ─── File reader ─────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 8000;

function readFileSafe(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > 100_000) return null;
    let content = fs.readFileSync(absPath, 'utf8');
    if (content.length > MAX_FILE_BYTES) {
      content = content.slice(0, MAX_FILE_BYTES) + '\n... [truncated]';
    }
    return content;
  } catch (_) {
    return null;
  }
}

// ─── Directory walker ─────────────────────────────────────────────────────────

function walk(base, dir, results) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs);

    if (entry.isDirectory()) {
      walk(base, abs, results);
    } else if (entry.isFile()) {
      results.push(rel);
    }
  }
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'into', 'make', 'sure',
  'also', 'when', 'them', 'then', 'than', 'been', 'were', 'will',
  'would', 'could', 'should', 'like', 'some', 'just', 'more',
  'what', 'which', 'their', 'there', 'about', 'your', 'work',
  'must', 'does', 'existing', 'users', 'user', 'code', 'file',
]);

module.exports = {
  extractSymbols,
  extractImports,
  resolveImport,
  findTestFile,
  findAllTestFiles,
  scoreFiles,
  contractKeywords,
  readFileSafe,
};
