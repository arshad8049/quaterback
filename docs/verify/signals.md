# Search hints for the judge (QB-12)

**Status:** implemented on `phase-0-1-hardening`, in review.

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
  | `hint` | the hunk didn't parse on its own; the name appears as an identifier token in added code. Heuristic only. |
  | `not_in_diff` | **unknown**: not evidence of absence |

  - Understood: function / class declarations; variable-bound functions; object methods; `module.exports = { … }` (any number of lines), `= name`, `= function name`; `exports.x =`; ESM `export` forms.
  - `returns` is `yes` or `no` from **that function's own body** (nested functions excluded), else `unknown`.
- **Keyword hints:** contract words found in **added** lines only. Words not found are labelled "NOT evidence of absence".
- **The judge prompt** shows these under "Search hints (computed by QB from the diff — hints, not facts)". Its rules no longer allow a `false` vote just because something is absent from the diff or the hints.

## What decides what
Hints only ever reach the judge, and since QB-16 the judge decides only `non_behavioral` criteria. A **behavioural** criterion is decided only by executed checks: no check → `unresolved`. So heuristic signals alone can't satisfy a behavioural criterion (regression in `test/unit/qb12-signals.test.js`).

## Limitations
- The verifier only has the diff. A hunk is parsed in isolation, so a definition split across hunks may only produce a `hint`.
- Non-JavaScript files get token or text hints only.
