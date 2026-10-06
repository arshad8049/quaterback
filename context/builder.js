require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const { ContextPackageSchema } = require('./schema');
const { modelCall } = require('../lib/budget');
const { detectPatterns }       = require('./detector');
const { buildGitContext }      = require('./git');
const {
  extractImports,
  resolveImport,
  findTestFile,
  findAllTestFiles,
  scoreFiles,
  contractKeywords,
  readForIndex,
  MAX_FILE_BYTES,
} = require('./extractor');
const { MAX_INDEX_BYTES } = require('./symbols');
const { retrieve } = require('./retrieval');

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
  const hints = (options.fileHints || []).map(h => h.file);
  const assembled = assembleFiles(contract, absRepo, {
    ...(options.retrieval || {}),
    // Memory boost: memory-recalled files are seeds, with their reason.
    forcedSeeds: hints.filter(h => fs.existsSync(path.join(absRepo, h))).map(h => ({ path: h, reason: `[Memory] changed in similar past run — seed` })),
  });
  const { relevantFiles, symbolMap, symbolsIndex, indexLimits, retrieval } = assembled;
  const topFiles = relevantFiles.map(f => f.path);

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
      content_truncated: f.content_truncated,
      index_status: f.index_status,
      retrieval: f.retrieval,
    })),
    symbol_map: symbolMap,
    symbols_index: symbolsIndex,
    index_limits: { max_index_bytes: MAX_INDEX_BYTES, snippet_bytes: MAX_FILE_BYTES, files: indexLimits },
    retrieval,
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

/**
 * QB-18: select files by symbol/content relevance plus bounded import/caller traversal
 * (context/retrieval.js), then shape them as relevant_files with their symbols.
 */
function assembleFiles(contract, absRepo, o) {
  const { files, retrieval } = retrieve(contract, absRepo, o);
  const relevantFiles = [];
  const symbolMap     = {};    // qualified ID → "path:line" (exported symbols and their methods)
  const symbolsIndex  = [];    // every indexed symbol, with kind, span and export details
  const indexLimits   = [];    // files not fully parsed: too_large / unparsable / regex / unreadable
  for (const f of files) {
    const n = f.node;
    if (!n) continue;
    const idx = n.idx;
    if (idx.status !== 'parsed' && idx.status !== 'not_indexed') indexLimits.push({ path: f.rel, status: idx.status, bytes: n.bytes, ...(idx.unindexed ? { unindexed: idx.unindexed } : {}) });
    symbolsIndex.push(...idx.symbols);
    const exported = idx.symbols.filter(s => s.exported);
    for (const s of exported) symbolMap[s.id] = `${f.rel}:${s.span.start.line}`;
    relevantFiles.push({
      path:      f.rel,
      reason:    f.reason,
      symbols:   exported.filter(s => s.kind !== 'method').map(s => s.name),
      imports:   n.imports,
      test_file: n.source === 'checkout' ? findTestFile(f.rel, absRepo) : null,
      content:   n.snippet,
      content_truncated: n.cut,
      index_status: idx.status,
      retrieval: f.retrieval,
    });
  }
  return { relevantFiles, symbolMap, symbolsIndex, indexLimits, retrieval };
}

/** The candidate content an attempt produced for each changed file (QB-18 refresh). */
function candidateOverlay(execution) {
  const overlay = new Map();
  const deleted = new Set();
  const stale = [];
  const snap = execution?.sandbox?.snapshot;
  const snapFiles = new Map(((snap && !snap.error && snap.files) || []).map(f => [f.path, f.text]));
  // New files: the patch carries their whole content as one added hunk.
  const fromPatch = new Map();
  let cur = null;
  for (const line of String(execution?.diff || '').split('\n')) {
    const h = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (h) { cur = { file: h[2], lines: [], whole: false }; fromPatch.set(cur.file, cur); continue; }
    if (!cur) continue;
    if (/^@@ -0,0 \+1(,\d+)? @@/.test(line)) { cur.whole = true; continue; }
    if (line.startsWith('@@')) { cur.whole = false; continue; }
    if (cur.whole && line.startsWith('+') && !line.startsWith('+++')) cur.lines.push(line.slice(1));
  }
  for (const c of execution?.changes || []) {
    if (c.status === 'D') { deleted.add(c.file); continue; }
    if (snapFiles.has(c.file)) overlay.set(c.file, { content: snapFiles.get(c.file), source: 'candidate_tree' });
    else if (fromPatch.get(c.file)?.whole) overlay.set(c.file, { content: fromPatch.get(c.file).lines.join('\n') + '\n', source: 'patch' });
    else stale.push(c.file);
  }
  return { overlay, deleted, stale };
}

/**
 * QB-18: refresh the context after an attempt's patch. The candidate's changed files are
 * seeds (with their imports and callers, to the same bounded depth); deleted files leave
 * the package; files whose candidate content is unavailable are reported as stale. The
 * LLM brief and git context are kept. Returns { context, refresh }.
 */
function refreshContext(context, contract, repoPath, execution, { attempt } = {}) {
  const absRepo = path.resolve(repoPath);
  const { overlay, deleted, stale } = candidateOverlay(execution);
  const changed = (execution?.changes || []).filter(c => c.status !== 'D').map(c => c.file);
  const assembled = assembleFiles(contract, absRepo, {
    depth: context.retrieval?.depth, maxFiles: context.retrieval?.max_files, maxBytes: context.retrieval?.max_bytes,
    overlay, deleted,
    forcedSeeds: [
      ...changed.filter(f => overlay.has(f)).map(f => ({ path: f, reason: `changed by attempt ${attempt} (${overlay.get(f).source})` })),
      ...stale.map(f => ({ path: f, reason: `changed by attempt ${attempt} (current content unavailable)` })),
    ],
  });
  // Re-review 1: a changed file whose candidate bytes could not be read must not be briefed
  // from its OLD checkout content. Its symbols leave the symbol map and index, and its entry
  // keeps the path but no content or symbols, marked stale (the briefing renders a warning).
  for (const f of stale) {
    for (const k of Object.keys(assembled.symbolMap)) if (k.startsWith(`${f}#`)) delete assembled.symbolMap[k];
    assembled.symbolsIndex = assembled.symbolsIndex.filter(s => s.file !== f);
    let entry = assembled.relevantFiles.find(e => e.path === f);
    if (!entry) { entry = { path: f, reason: `changed by attempt ${attempt} (current content unavailable)`, imports: [], test_file: null }; assembled.relevantFiles.unshift(entry); }
    entry.symbols = [];
    entry.imports = [];
    delete entry.content;
    delete entry.content_truncated;
    entry.index_status = 'stale';
    entry.stale = { attempt: attempt ?? null, reason: 'changed by the attempt; the candidate content was not captured (no sandbox file export, no whole-file patch)' };
  }
  const before = new Set((context.relevant_files || []).map(f => f.path));
  const after = new Set(assembled.relevantFiles.map(f => f.path));
  const refresh = {
    attempt, changed, stale,
    added: [...after].filter(p => !before.has(p)).sort(),
    removed: [...before].filter(p => !after.has(p)).sort(),
    deleted: [...deleted].sort(),
  };
  const next = {
    ...context,
    generated_at: new Date().toISOString(),
    relevant_files: assembled.relevantFiles,
    symbol_map: assembled.symbolMap,
    symbols_index: assembled.symbolsIndex,
    index_limits: { max_index_bytes: MAX_INDEX_BYTES, snippet_bytes: MAX_FILE_BYTES, files: assembled.indexLimits },
    retrieval: { ...assembled.retrieval, refreshes: [...(context.retrieval?.refreshes || []), refresh] },
  };
  return { context: ContextPackageSchema.parse(next), refresh };
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
    // QB-21: deadline-bound, cancellable, concurrency-bounded (lib/budget.js)
    const data = await modelCall(`${OLLAMA_URL}/api/chat`, {
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
      stream: false,
      options: { temperature: 0.1, num_ctx: 16384 },
    });
    const raw  = data.message?.content;
    if (!raw) return null;

    return parseJSON(raw);
  } catch (e) {
    if (e && e.code === 'DEADLINE' && e.kind === 'run') throw e;   // QB-21: a run deadline stops the run (enrichment is optional otherwise)
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

module.exports = { buildContext, refreshContext };
