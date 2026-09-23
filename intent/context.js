const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache',
  'coverage', '__pycache__', '.venv', 'venv', '.env', 'vendor'
]);

const IGNORE_EXTS = new Set([
  '.lock', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.eot', '.mp4', '.webm', '.pdf',
  '.zip', '.tar', '.gz', '.map'
]);

const MAX_TREE_FILES = 200;
const MAX_FILE_BYTES = 2000;   // per file snippet — keep intent compiler prompt lean for 7B model
const MAX_CONTEXT_CHARS = 8000; // total context budget — ~2k tokens, leaves room for system prompt + response

/**
 * Build a context string for the given repo path.
 * Returns the directory tree + content of the most relevant files.
 *
 * @param {string} repoPath - Absolute path to the repository
 * @param {string} request - The developer's request (used for relevance scoring)
 * @returns {string} Context string to inject into the compiler prompt
 */
function buildContext(repoPath, request) {
  const absRepo = path.resolve(repoPath);

  if (!fs.existsSync(absRepo)) {
    throw new Error(`Repo path does not exist: ${absRepo}`);
  }

  // 1. Walk the tree
  const files = [];
  walk(absRepo, absRepo, files);

  // 2. Build tree string
  const treeLines = files.slice(0, MAX_TREE_FILES).map(f => f.rel);
  const tree = treeLines.join('\n');

  // 3. Score files by relevance to the request
  const keywords = extractKeywords(request);
  const scored = files.map(f => ({
    ...f,
    score: scoreFile(f, keywords)
  })).sort((a, b) => b.score - a.score);

  // 4. Read top-scoring files up to context budget
  let contextParts = [`## Directory tree\n\`\`\`\n${tree}\n\`\`\``];
  let usedChars = contextParts[0].length;

  const snippets = [];
  for (const file of scored) {
    if (file.score === 0) break;
    if (usedChars >= MAX_CONTEXT_CHARS) break;

    try {
      const stat = fs.statSync(file.abs);
      if (stat.size > 80_000) continue; // skip huge files

      let content = fs.readFileSync(file.abs, 'utf8');
      if (content.length > MAX_FILE_BYTES) {
        content = content.slice(0, MAX_FILE_BYTES) + '\n... [truncated]';
      }

      const snippet = `## ${file.rel}\n\`\`\`\n${content}\n\`\`\``;
      if (usedChars + snippet.length > MAX_CONTEXT_CHARS) break;

      snippets.push(snippet);
      usedChars += snippet.length;
    } catch (_) {
      // Skip unreadable files
    }
  }

  if (snippets.length > 0) {
    contextParts.push('## Relevant file contents', ...snippets);
  }

  return contextParts.join('\n\n');
}

function walk(base, dir, results) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const abs = path.join(dir, entry.name);
    const rel = path.relative(base, abs);

    if (entry.isDirectory()) {
      walk(base, abs, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!IGNORE_EXTS.has(ext)) {
        results.push({ abs, rel, name: entry.name, ext });
      }
    }
  }
}

function extractKeywords(request) {
  // Pull meaningful words from the request for relevance scoring
  return request
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !STOP_WORDS.has(w));
}

function scoreFile(file, keywords) {
  const nameLower = file.name.toLowerCase();
  const relLower = file.rel.toLowerCase();
  let score = 0;

  // High-value file types
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(file.ext)) score += 2;
  if (['.json', '.yaml', '.yml', '.toml', '.env.example'].includes(file.ext)) score += 1;

  // Keyword matches in filename or path
  for (const kw of keywords) {
    if (nameLower.includes(kw)) score += 4;
    else if (relLower.includes(kw)) score += 2;
  }

  return score;
}

const STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'into', 'make', 'sure',
  'also', 'when', 'them', 'then', 'than', 'been', 'were', 'will',
  'would', 'could', 'should', 'like', 'some', 'just', 'more',
  'what', 'which', 'their', 'there', 'about', 'your', 'work'
]);

module.exports = { buildContext };
