# Judge evidence with provenance (QB-11)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
The judge saw one acceptance criterion and the **first 6,000 characters of the diff**. It got none of the unchanged code the change relies on, and no runtime evidence. As a result:
- a defect after character 6,000 was invisible;
- so was a defect inside an unchanged helper the new code calls;
- the cut was silent, so partial input looked complete.

Pre-fix (`477a7f0`) results, with a scripted judge that votes "not met" only when it can see the defect:
- a README defect after a 7,000-character hunk → **PASS**;
- an unchanged `fmt()` returning `'Hi ' + n` called by the new `greet()` → **PASS**.

## Evidence bundle (`verify/evidence.js`)
For each criterion the judge decides (`kind: "non_behavioral"`, plus the no-change judgment), QB assembles:

| Kind | Source | Material |
|---|---|---|
| `hunk` | every changed hunk of the captured diff, **whole** (never cut mid-hunk) | yes |
| `definition` | the definition of each function the **added lines call**, from the **tested candidate tree**, unchanged code included. Covers the same file, a relatively imported module (`require('./x')`, `import … from './x'`), and namespace calls (`ns.f()`). | yes |
| `definition` | functions the criterion names (`name()`) | no (context) |
| `file` | whole candidate files (no-change judgment: the files under judgment) | yes |
| `check` | this criterion's executed check results (QB-16) | yes |

- **Provenance.** Each item records `file`, line `range` (new side), `source` (`diff` / `candidate_tree` / `check_run`), `tree`, git `blob`, and `sha256` of its text.
- **Immutable ID.** `EV-<12 hex>` = SHA-256 over (kind, file, range, blob, text hash). The same evidence always gets the same ID, and changed evidence gets a new one.
- **Where the candidate files come from.** The sandbox exports them with the trusted QB-22 snapshot (stage `snapshot`, after the tests and checks). It runs in two passes:
  1. the changed files;
  2. the relative modules they import.

  Both must be the tested tree (`snapshot.tree == candidate_tree == verification.tree`). A file over 64 KiB, a symlink or a missing file is recorded as `skipped` with its reason.
- **Ranking and budget.** Items are ranked by relevance to the criterion: words of the criterion found in the file name and text, with material items first on ties. They are shown **whole** within `QB_JUDGE_EVIDENCE_CHARS` (default 24,000), and the judge context is `num_ctx` 12288.

## Binding resolution (re-review 1)
- **An imported helper is the module's EXPORTED binding, never the first declaration in the file.**
  - QB resolves:
    - `module.exports = X`;
    - `module.exports = function …` (inline);
    - `module.exports = { a, b: c }`;
    - `exports.a = …`;
    - `export default X` / `export default function …`;
    - `export function a`;
    - `export { x as a }`.
  - A `local` binding must have exactly one **module-scope** definition.
  - Anything else is named as missing material evidence (`src/fmt.js: export binding not resolved (…)`). This covers a call result, `require(...)`, an object where a function is called, a re-export, an ambiguous or absent definition, or a name that isn't exported.
  - Pre-fix, `module.exports = actual` with a `decoy` declared first showed the **decoy**, and nothing was missing.
- **CommonJS is replayed in statement order (re-review 2)**, as Node runs it:
  - `module.exports = …` starts a **new** export object, so earlier named exports are gone, and detaches the `exports` alias. A later `exports.x = …` therefore exports nothing (`exports.x was assigned after module.exports was replaced`).
  - `module.exports.x = …` adds to the current object, and the last assignment wins.
  - Any export change QB cannot follow statically makes every binding unresolved. That includes a change inside a function or block, one through a call (`Object.assign(module.exports, …)`), and reassigning `exports` or `module`.
  - Pre-fix: `module.exports = {fmt}; module.exports = {};` still showed `fmt`, which is undefined at runtime.
- **Every export mutation is interpreted or fails closed (re-review 3).**
  - A write is marked handled only **after** QB interprets it. Interpreted forms:
    - top-level `=` to `module.exports`, `module['exports']` and `module.exports.x` / `['x']`;
    - `exports.x` / `['x']`;
    - top-level `delete module.exports.x`, which is reported as `x was deleted from the exports at line N`.
  - Every other reference to `module`, `module.exports` or `exports` must be a plain **read**: a property access, `require.main === module`, `typeof module`.
  - **Anything else makes every binding unresolved:**
    - other writes: computed non-literal keys, compound `+=` / `??=`, `++` / `--`, unhandled `delete`, destructuring or `for-in`/`for-of` targets, and writes inside functions or blocks;
    - the export object or `module` escaping as a value: aliased (`const e = module.exports`), passed to a call (`Object.assign`, `Object.defineProperty(module, 'exports', …)`) or returned.
  - Pre-fix: `module.exports['fmt'] = null` and `delete module.exports.fmt` still showed `fmt`.
  - Of this repository's own 148 JavaScript modules, none is flagged.
- **Same-file helpers** resolve in the candidate file's module scope. Calls to names defined in the hunk itself, or to language/runtime globals, need no source.
- **When the changed file's own source is unavailable, the calls are named as missing:** `source of src/greet.js (to resolve calls to fmt) — too_large` (or `not_requested`, `unparsable`, `no candidate snapshot`, `snapshot failed`).
  - Pre-fix, an oversized changed file silently erased the same-file helper evidence.
  - An execution record with **no snapshot** gets no exemption.

## Nothing partial is presented as complete
- The prompt lists every block as `### [EV-…] hunk README.md +10..10 (diff)` or `definition src/fmt.js 1..3 (candidate tree, blob …)`.
- It then has an **"Evidence NOT shown"** section: everything omitted, with each material item marked `[MATERIAL]`.
- **Missing material evidence** makes the criterion **never met**: `met: null`, with the evidence `Missing material evidence: definition of fmt (imported from ./fmt) — src/fmt.js too_large`. That covers:
  - a hunk that does not fit the budget;
  - the definition of a called, imported helper that could not be exported (too large, missing, not retrieved, not found in the file);
  - a failed snapshot or a tree mismatch.
- **`aggregate` rules 6:** such a criterion makes the task **unresolved**, not `partial`. Records stored under rules ≤ 5 replay as they were decided.
- **The judge's `refs` must name shown evidence IDs.** A vote citing an unknown ID is an invalid judgment and is never counted (QB-07). A false vote must quote a line from the evidence (a hunk, or the definition of a called helper) and cite its ID.

## Report
- Each criterion result carries `evidence_ids` (what it was judged on) and `evidence_missing` (`{ what, reason }`).
- `report.evidence` is the manifest: provenance only, **no file contents**.

## Also fixed here
- `snapshot`, `verify-base` and `checks` had **no stage deadline** (`DEFAULT_DEADLINES`). The supervisor received `deadline_ms: null`, which counts as already due, so it would kill one of those stages as a timeout once it ran longer than the 10-second grace period.
- They now have real deadlines. A unit test checks that every `stage('…')` name has one.

## Scope, stated to the judge every time
Every evidence prompt ends with **"Not retrieved by QB (by design)"**: callers of the changed code, dynamic dispatch, package (non-relative) imports, and helpers called only from unchanged lines. So none of these is ever implied to have been checked.
- The original ticket also asks for **callers**. That is an explicit **scope reduction** for this card: callers are not retrieved, and the judge and this note both say so.

## Limitations
- **Retrieval is static and name-based.** It finds:
  - direct calls in added lines;
  - definitions by name (functions, classes, methods, assigned functions) in the changed file and in relatively imported modules.

  It does not follow dynamic dispatch, callers of the changed code, package imports, or helpers called only from unchanged lines.
- At most 8 changed files and 8 imported modules are exported per run, and files are capped at 64 KiB. Anything beyond that is named as missing when it is material.
- Only JavaScript is parsed for definitions. Other files contribute their hunks.
- Relevance ranking is word overlap. When the budget runs out, the omitted material hunks make the criterion unresolved instead of guessing.
