# Context retrieval: ranking, graph depth, refresh (QB-18)

**Status:** implemented on `phase-3-context-memory`, in review.

## Why
- **Ranking was by path and filename.** `scoreFiles` gave every code file +2, and added more only when a keyword appeared in its path. A large repository therefore filled the 25-file package with arbitrary or name-matching files.
- **The claimed two-level traversal was absent.** Direct imports were recorded but never followed.
- **Retries reused the original context**, even after the patch added files or changed symbols.

Pre-fix (`03ab9b0`), `test/unit/qb18-retrieval.test.js` fails **7 of 7**:
- In a 224-file fixture, `parseDuration` lives in the generically named `src/utils/helpers.js`. The package was led by `src/cli/main.js` and twenty `src/legacy/duration_report_*.js` files, and `helpers.js` was not ranked first.
- There was no two-hop dependency, no caller edge, no budget or omission record, and no depth control.
- Through `qb.js`, a file created by attempt 1 never appeared in attempt 2's briefing.

## Design (`context/retrieval.js`)
One language family is supported well: JavaScript, indexed by the QB-19 parser. Other code files get content and path matches only.

| Step | What happens |
|---|---|
| **Scan** | Every code file, bounded by `scanLimit` (default 5,000; the excess is counted in `scan_truncated`). Each file's symbols are indexed, its content read, and its relative imports resolved. That gives an import graph and its reverse, the callers. |
| **Score** | Against the contract's terms: **identifiers** (`parseDuration`, `name(`, snake_case), weighted +20 for a matching symbol name and +4 for a content mention. Then **keywords**, including the words inside identifiers: +2 for a symbol-word match, +1 for a content match (capped), +3 / +1 for a name / path match. |
| **Seed** | Files at or above a **relevance cut**, 25% of the top score and at least 3, up to `maxSeeds` (10). Anything that scored but fell below the cut is recorded as omitted (`below_relevance_cut`). |
| **Traverse** | A bounded BFS from the seeds, with a **visited set** and an explicit **`depth`** (default 2, configurable), over **import edges and caller edges**. Each file records its reason: `seed: symbol parseDuration … (score 26)`, `import of src/utils/time/units.js (depth 2)`, `caller of src/utils/helpers.js (depth 1)`. Files reachable only beyond the depth are omitted (`depth_limit`). |
| **Budget** | Files in priority order (a neighbour inherits its parent's priority × 0.7 per hop) until `maxFiles` (25) / `maxBytes` (250 KB of snippets). The rest is omitted (`max_files` / `max_bytes`). A repository small enough to fit is included whole (`fill`). |

**In the package:**
- each `relevant_files[]` entry has `retrieval: { edge: seed|changed|import|caller|fill, depth, via, priority, source: checkout|candidate_tree|patch }`;
- `retrieval` records `{ depth, max_files, max_bytes, used_files, used_bytes, scanned_files, scan_limit, scan_truncated, relevance_cut, terms, seeds, omitted (first 100), omitted_total, refreshes }`.

Memory-recalled files (L5) are forced seeds with a `[Memory]` reason.

## Refresh after each patch (`refreshContext`, `qb.js` repair loop)
After attempt N is verified and a repair follows, `qb.js` calls `refreshContext(context, contract, repoPath, execution, { attempt: N })` and records a `context.refreshed` event.
- **Candidate overlay:**
  - changed files are read from the **candidate tree** (the QB-11 trusted snapshot export) when available;
  - **new** files are read from the patch, whose single `@@ -0,0` hunk carries the whole file;
  - other changed files without candidate content are listed as `stale`;
  - deleted files leave the package.
- **Re-retrieval:** retrieval runs again on that overlay, with the changed files as **forced seeds** (`changed by attempt N (candidate_tree|patch)`). Their imports and callers follow to the same depth.
- **The record:** `{ attempt, changed, stale, added, removed, deleted }` is appended to `retrieval.refreshes`. The LLM brief and git context are kept.

## Re-review 1
### Shortest depth across seeds, with ranking kept separate from reachability
- **Before:** the traversal was a priority queue with a visited set. A file reached first through a high-priority seed at depth 2 refused a later, shallower path from a weaker seed. Its own imports then fell outside the depth bound.
  - Repro: `a.js` (score 88) → `mid.js` → `shared.js`; `b.js` (score 24) → `shared.js`; `shared.js` → `leaf.js`. `leaf.js` was omitted as depth 3, although `b.js → shared.js → leaf.js` is depth 2.
- **Now:**
  - **Reachability:** a level-by-level **multi-source BFS** gives every file its **shortest** depth from any seed. Among equally short paths, the one from the higher-priority parent wins: that path sets `via` and the priority.
  - **Ranking:** priority (seed score × 0.7 per hop) and the file/byte budget are applied **afterwards** and never decide reachability.
  - Files one hop past the bound are recorded as `depth_limit`.

### Stale refreshed files are dropped and flagged in the briefing
- **Before:** a changed file whose candidate bytes could not be read (no sandbox file export, no whole-file patch) was listed in `refresh.stale`. But its **old** symbols stayed in `symbol_map`, `symbols_index` and `relevant_files`, and the agent was briefed with them as current.
- **Now:**
  - The stale file is a forced seed, so it stays in the package as a file to work in.
  - Its symbols are **removed** from `symbol_map` and `symbols_index`. Its entry has **no content, symbols or imports**, `index_status: "stale"`, and `stale: { attempt, reason }`.
  - **The agent briefing renders the limitation:** "⚠ \`a.js\` changed in attempt 1; its current content could not be read — do not rely on earlier context for it."
  - This is tested through `buildBriefing` and through the real `qb.js` loop: attempt 2's briefing carries the warning and not the old symbol.

## Done-when
- **A generically named file is retrieved in a 200+ file repository:** `src/utils/helpers.js` ranks **first** among 224 files, as `seed: symbol parseDuration …`.
- **A two-hop dependency and a new repair file are present:**
  - `units.js` is an import at depth 1, `constants.js` an import at depth 2, and `cli/main.js` a caller at depth 1;
  - through `qb.js`, the file attempt 1 created (`src/utils/durationParser.js`) is in attempt 2's briefing, and the run record's `context.refreshed` event lists it as added.
- **Irrelevant files do not dominate:**
  - the four relevant files take the top four places;
  - none of the 200 generic noise modules is in the package;
  - the 20 name-matching distractors are omitted with `below_relevance_cut`.
- **Depth and budget are enforced and explicit:** depth 1 omits the two-hop file as `depth_limit`; `maxFiles: 2` omits the rest as `max_files`.
- **On this repository:** a contract naming `judgmentKey` ranks `verify/judge-cache.js` first, then its callers. 170 files are scanned in about 2 s.

## Limitations
- **Relevance is lexical** (identifiers, words and paths), not semantic. A request that names nothing from the code relies on keywords and the optional LLM ranking.
- **The import graph covers relative imports only** (`require`/`import`, resolved within the repository). Package imports and dynamic requires are not edges.
- **Only JavaScript symbols are parsed.** Other languages contribute content and path matches only.
- **Candidate content for a *modified* file needs the sandbox's snapshot export.** Without it the file is listed as `stale` rather than guessed: its facts are dropped from the context and the briefing warns.
- **A stale file's old content may still affect other files' scores,** and its old imports are not followed. Only facts presented about that file itself are removed.
