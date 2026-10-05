# Search hints for the judge (QB-12)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

## Why
The checker gave the judge "deterministic checks (computed from added lines)" built from text matches, and they were wrong as facts:
- a comment mentioning `clamp`, or a string containing it, counted as *defined*;
- a commented-out `module.exports` counted as *exported*;
- any `return` anywhere in the diff counted as *returns*;
- keyword scanning ignored whether a line was added, deleted or context;
- a name missing from added lines was shown as "NO (not found in added lines)", although unchanged code may already implement it.

## Now (`verify/checker.js` `scanDiff`, version 2)
- **Parsing.** Each hunk's post-image (context + added lines; deleted lines are never read) of a `.js/.cjs/.mjs/.jsx` file is parsed with **acorn** (pinned, `8.18.0`). Comments and strings are never code.
- **Symbol hints**, for names the contract mentions, each carrying provenance:

  | `defined` / `exported` | Meaning |
  |---|---|
  | `confirmed_added` | a real binding in added code |
  | `confirmed_unchanged` | a real binding in unchanged context (pre-existing) |
  | `hint` | heuristic only: the hunk didn't parse on its own (the name is an identifier token in added code), or the hunk alone can't establish the binding (see below) |
  | `not_in_diff` | **unknown**: not evidence of absence |

  - Understood: function / class declarations; variable-bound functions; object methods; `module.exports = { … }` (any number of lines), `= name`, `= function name`; `exports.x =`; ESM `export` forms.
  - `returns` is `yes` or `no` from **that function's own body** (nested functions excluded), else `unknown`.

### Exported name vs local binding (re-review)
`exported` is about the **public name**: `symbols.clamp.exported` means a consumer can reach `clamp` by that name. Aliases are kept apart:

| Field | On | Meaning |
|---|---|---|
| `exported_as: { other: status }` | the local binding | `export { clamp as other }`, `exports.other = clamp`, `module.exports = { other: clamp }` |
| `exported_as: { "default" \| "module.exports": status }` | the local binding | `export default clamp`, `module.exports = clamp`: the module itself, not a name |
| `local: "clamp"` | the exported name | the binding behind `other` |
| `from: "./c.js"` | the exported name | a re-export; not a local definition |

Computed keys (`exports[k] = …`, `{ [k]: … }`) are not names; only string-literal keys (`exports["clamp"]`) are resolved. A local exported under a computed name is recorded as `exported_as: { "(computed name)": "hint" }`.

### CommonJS scope (re-review)
A write to `exports.x` / `module.exports…` counts only when `exports` / `module` is the module's own binding in the parsed hunk:
- **Shadowed** by a parameter (`function wrapper(exports) { exports.clamp = … }`), a `let`/`const`/`var` (hoisting included), a catch parameter, a function or class name, or an import → **not a module export**. A function written there is only a `hint` of a definition.
- **`exports` rebound** to a fresh object (`exports = {}`, but not `exports = module.exports = …`) → not a module export.
- **Inside a function in the hunk**, the write runs only if the function is called → `hint`.
- **Hunk-only context:** the hunk is a fragment. If it starts below line 1 of the file and the statement is indented, it may sit inside a function or block the diff doesn't show → `hint`, never confirmed. Unindented top-level statements, or hunks starting at the top of the file, can be confirmed.

ESM `export` is top-level by syntax, so no scope resolution is needed (an `export` inside a function in the hunk is invalid code → `hint`).
- **Keyword hints:** contract words found in **added** lines only. Words not found are labelled "NOT evidence of absence".
- **The judge prompt** shows these under "Search hints (computed by QB from the diff — hints, not facts)". Its rules no longer allow a `false` vote just because something is absent from the diff or the hints.

## What decides what
Hints only ever reach the judge, and since QB-16 the judge decides only `non_behavioral` criteria. A **behavioural** criterion is decided only by executed checks: no check → `unresolved`. So heuristic signals alone can't satisfy a behavioural criterion (regression in `test/unit/qb12-signals.test.js`).

## Limitations
- The verifier only has the diff. A hunk is parsed in isolation, so a definition split across hunks may only produce a `hint`.
- Non-JavaScript files get token or text hints only.
- Scope is resolved within the hunk. An unindented export in a mid-file hunk inside an unseen, unindented enclosing function (unusual formatting) would still be read as top-level.
- `module.exports = { … }` after `exports.x = …` replaces the exports object. That ordering isn't modelled.
- None of these signals decide a behavioural criterion. That is the executable checks (QB-16).
