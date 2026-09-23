require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { ContextPackageSchema } = require('./schema');
const { detectPatterns }       = require('./detector');
const { buildGitContext }      = require('./git');
const {
  extractSymbols,
  extractImports,
  resolveImport,
  findTestFile,
  findAllTestFiles,
  scoreFiles,
  contractKeywords,
  readFileSafe,
} = require('./extractor');

const OLLAMA_URL    = process.env.QB_OLLAMA_URL || 'http://127.0.0.1:11434';
const MODEL         = process.env.QB_MODEL      || 'deepseek-r1:7b';
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'prompts/system.md'), 'utf8');

/**
 * Build a ContextPackage for a given TaskContract and repo path.
 *
 * @param {object} contract   - TaskContract from Layer 1
 * @param {string} repoPath   - Absolute path to the repository
 * @param {object} options    - { noLlm: boolean }
 * @returns {object}          - Validated ContextPackage
 */
async function buildContext(contract, repoPath, options = {}) {
  const absRepo = path.resolve(repoPath);

  if (!fs.existsSync(absRepo)) {
    throw new Error(`Repo path does not exist: ${absRepo}`);
  }

  // ── Stage 1: DSA passes (all deterministic) ───────────────────────────────

  const patterns  = detectPatterns(absRepo);
  const keywords  = contractKeywords(contract);
  const topFiles  = scoreFiles(absRepo, keywords, 25);

  // Read each relevant file and extract symbols + imports
  const relevantFiles = [];
  const symbolMap     = {};

  for (const rel of topFiles) {
    const abs     = path.join(absRepo, rel);
    const content = readFileSafe(abs);
    if (!content) continue;

    const symbols = extractSymbols(rel, content);
    const rawImports = extractImports(content);
    const imports = rawImports
      .map(imp => resolveImport(abs, imp, absRepo))
      .filter(Boolean);

    const testFile = findTestFile(rel, absRepo);

    // Populate symbol map with file:line location
    for (const sym of symbols) {
      const lines = content.split('\n');
      const lineNum = lines.findIndex(l => l.includes(sym)) + 1;
      if (lineNum > 0) {
        symbolMap[sym] = `${rel}:${lineNum}`;
      }
    }

    relevantFiles.push({
      path:      rel,
      reason:    buildReason(rel, keywords),
      symbols,
      imports,
      test_file: testFile,
      content,
    });
  }

  // Test coverage
  const allTestFiles     = findAllTestFiles(absRepo);
  const coveredFiles     = relevantFiles.filter(f => f.test_file).map(f => f.path);
  const uncoveredFiles   = relevantFiles.filter(f => !f.test_file).map(f => f.path);
  const relevantTestFiles = [
    ...new Set([
      ...relevantFiles.map(f => f.test_file).filter(Boolean),
      ...allTestFiles.filter(t => keywords.some(kw => t.toLowerCase().includes(kw))),
    ])
  ];

  // Git context for relevant files
  const gitContext = buildGitContext(absRepo, topFiles);

  // ── Stage 2: LLM enrichment (optional) ───────────────────────────────────

  let agentBrief     = null;
  let rankedFiles    = null;

  if (!options.noLlm) {
    const enrichment = await callLlm(contract, {
      patterns,
      relevant_files: relevantFiles.map(f => ({
        path: f.path, symbols: f.symbols, imports: f.imports, test_file: f.test_file
      })),
      symbol_map:  symbolMap,
      test_coverage: { covered_files: coveredFiles, test_files: relevantTestFiles, uncovered_files: uncoveredFiles },
      git_context: gitContext,
    });

    agentBrief  = enrichment?.agent_brief  || null;
    rankedFiles = enrichment?.ranked_files || null;

    // Re-order relevantFiles to match LLM ranking if provided
    if (rankedFiles) {
      const rankOrder = Object.fromEntries(rankedFiles.map((f, i) => [f.path, i]));
      relevantFiles.sort((a, b) => {
        const ra = rankOrder[a.path] ?? 999;
        const rb = rankOrder[b.path] ?? 999;
        return ra - rb;
      });
      // Attach priority from LLM ranking
      for (const rf of rankedFiles) {
        const match = relevantFiles.find(f => f.path === rf.path);
        if (match) match.reason = rf.reason;
      }
    }
  }

  // ── Assemble and validate ─────────────────────────────────────────────────

  const pkg = {
    id:           randomUUID(),
    contract_id:  contract.id || 'unknown',
    repo_path:    absRepo,
    generated_at: new Date().toISOString(),
    patterns,
    relevant_files: relevantFiles.map(f => ({
      path:      f.path,
      reason:    f.reason,
      symbols:   f.symbols,
      imports:   f.imports,
      test_file: f.test_file,
      content:   f.content,
    })),
    symbol_map: symbolMap,
    test_coverage: {
      covered_files:   coveredFiles,
      test_files:      relevantTestFiles,
      uncovered_files: uncoveredFiles,
    },
    git_context: gitContext,
    agent_brief: agentBrief,
  };

  return ContextPackageSchema.parse(pkg);
}

// ─── LLM enrichment ──────────────────────────────────────────────────────────

async function callLlm(contract, extractedData) {
  const userContent = [
    '## TASK CONTRACT',
    JSON.stringify({
      goal:              contract.goal,
      required_behavior: contract.required_behavior,
      constraints:       contract.constraints,
      acceptance_criteria: contract.acceptance_criteria,
    }, null, 2),
    '',
    '## EXTRACTED CODEBASE DATA',
    JSON.stringify(extractedData, null, 2),
  ].join('\n');

  try {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
        stream: false,
        options: { temperature: 0.1, num_ctx: 16384 },
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const raw  = data.message?.content;
    if (!raw) return null;

    return parseJSON(raw);
  } catch (_) {
    return null;
  }
}

function parseJSON(text) {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
  try {
    return JSON.parse(s);
  } catch (_) {
    const match = s.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    return null;
  }
}

function buildReason(filePath, keywords) {
  const name    = path.basename(filePath, path.extname(filePath));
  const matched = keywords.filter(kw => filePath.toLowerCase().includes(kw));
  if (matched.length > 0) {
    return `Matches keywords: ${matched.join(', ')}`;
  }
  return `Included by relevance scoring (${name})`;
}

module.exports = { buildContext };
