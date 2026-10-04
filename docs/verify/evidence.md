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

## Limitations
- **Retrieval is static and name-based.** It finds:
  - direct calls in added lines;
  - definitions by name (functions, classes, methods, assigned functions) in the changed file and in relatively imported modules.

  It does not follow dynamic dispatch, callers of the changed code, package imports, or helpers called only from unchanged lines.
- At most 8 changed files and 8 imported modules are exported per run, and files are capped at 64 KiB. Anything beyond that is named as missing when it is material.
- Only JavaScript is parsed for definitions. Other files contribute their hunks.
- Relevance ranking is word overlap. When the budget runs out, the omitted material hunks make the criterion unresolved instead of guessing.
