# Symbol extraction by parser (QB-19)

**Status:** implemented on `phase-3-context-memory`, in review.

## Why
The context engine extracted symbols with regular expressions:
- `module.exports = { alpha, beta }` returned only **alpha**;
- a symbol's location was the **first line containing the name**, which was often a comment;
- the symbol map was keyed by bare name, so a second file **overwrote** the first;
- files were read only up to **8,000 characters**, so later definitions and exports were invisible, and files over 100 KB were skipped silently.

Pre-fix (`7433d8c`): `test/unit/qb19-symbols.test.js` fails **11 of 11** through the real context builder.

## Design (`context/symbols.js`)
- **Parser:** every JavaScript file (`.js`, `.cjs`, `.mjs`; CommonJS and ESM) is parsed with acorn, using `parseJs` from `verify/evidence.js`.
- **Qualified IDs and real spans:**
  - top-level declarations are `<path>#<name>`;
  - methods of top-level classes are `<path>#<Class>.<method>`;
  - each carries its AST source span (1-based line and column), so a comment is never the location.
- **Exports, in statement order:**
  - CommonJS: `module.exports = { … }` (shorthand, aliases, methods, string keys), `module.exports = X`, `module.exports.x`, `exports.x`;
  - ESM: `export function / class / const`, `export { a as b }`, `export default`, re-exports;
  - a later `module.exports = …` replaces the export object, and `exports.x` written after it exports nothing;
  - an alias keeps `local` and resolves to the declaration it names; that declaration records `exported_as`.
- **Whole files are indexed** up to `MAX_INDEX_BYTES` (256 KiB). Only the prompt snippet is bounded (8,000 characters), and it is flagged `content_truncated`.
- **Nothing is silent.** Files not fully parsed are listed in `index_limits.files`, and each file's `index_status` says how it was indexed:
  - `too_large`: over the size cap;
  - `unparsable`: JavaScript that failed to parse; a regex fallback still runs, with `method: "regex"`;
  - `regex`: other languages;
  - `unreadable`: the file could not be read.

## Context package
| Field | Meaning |
| --- | --- |
| `symbol_map` | **qualified ID** → `path:line` for exported symbols and their methods. It was bare name → first occurrence. |
| `symbols_index` | Every indexed symbol: `{ id, name, kind, exported, file, span, method, export_span?, local?, exported_as?, from?, static? }` |
| `index_limits` | `{ max_index_bytes, snippet_bytes, files: [{ path, status, bytes }] }` |
| `relevant_files[].symbols` | Exported names, methods excluded (unchanged shape) |
| `relevant_files[].content_truncated`, `index_status` | Whether the prompt snippet was cut, and how the file was indexed |

The agent briefing's symbol table lists qualified IDs, so `src/a.js#parse` and `src/b.js#parse` both appear.

## Done-when
Each case below is a regression test through the real builder:
- single and trailing CJS exports;
- aliases, resolved to the local declaration;
- class methods, qualified by their class;
- ESM named, const, aliased and default exports;
- duplicate names in two files, as two distinct IDs;
- a name mentioned in a comment, located at its declaration instead;
- an export after byte 8,000, with its real line;
- a file over the cap, recorded as `too_large`;
- a bounded snippet, flagged as cut;
- the package passes schema validation, and the briefing renders it.

## Limitations
- Only JavaScript is parsed. TypeScript, JSX, Python and Go keep regex extraction, marked `method: "regex"` and located at the match.
- Only top-level declarations and methods of top-level classes are indexed.
- Exports changed dynamically (inside functions, via `Object.assign`) are not followed here.
