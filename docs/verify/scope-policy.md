# Scope and constraints as enforced policy (QB-09)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

## Why
Scope violations were listed in the report but didn't block PASS. Constraints were only text in the briefing. L2's `relevant_files` acted like an allowlist, but retrieval relevance isn't authorization.

Pre-fix (`6ecbd2a`): an approved contract with the constraint "Do not touch the legacy module", a change to `src/legacy/old.js`, passing tests and an affirmative judge → **PASS**, with the violation merely listed.

## Model
These fields are part of the approved oracle (QB-13): they're shown in the approval view and covered by the approval hash.

| Field | Meaning |
|---|---|
| `scope.allowed_changes` | Path globs the task may change. An explicit allowlist. |
| `scope.protected_paths` | Path globs that must not change. |
| `constraint_policy` | One entry per constraint, by index. It's either `enforced_by` (`protected_paths` ref, `allowed_changes`, or `check` ref to an executable check, QB-16) or `advisory: true` (shown to the human, not machine-checked). |

`contractState` rejects malformed globs (absolute paths, `..`, control characters), policy entries naming no constraint, unknown check refs, protected refs not in the scope, unknown kinds, and duplicates.

## Evaluation
`verify/policy.js` evaluates the **captured** change set: the change list, unsupported changes and the diff headers, including both sides of a rename. The agent's claims are never used.

| Effect | When | Verdict (`aggregate` rules 4) |
|---|---|---|
| `fail` | a protected path changed, or an enforced constraint was violated | FAIL, even if every judge vote and every test passed |
| `unresolved` | a change outside `allowed_changes`, or a constraint with no enforcement or no usable evidence | never PASS |
| `ok` | otherwise | unchanged |

### Path semantics (re-review 1)
- **One exact semantics for every captured name.** A glob matches the **whole** path. `*` and `?` match any character except `/`, and `**` also matches `/`. That includes newline, CR and U+2028/2029, which Git allows in filenames.
- Before this, `**` compiled to `.*`, which stops at line terminators, while `*` did not. So `src/a⏎b.js` was allowed by `src/*` while protection `src/**` missed it.
- **Unsupported changed paths:** control characters, line terminators, absolute paths, or `.`/`..`/empty segments.
  - They are listed in `policy.unsupported_paths`.
  - They are never authorized by `allowed_changes`, so the task is never PASS.
  - Protected matching still applies to them, so **protection wins (FAIL)**.
- Git **C-quoted diff headers** (`diff --git "a/x\nb" "b/x\nb"`, octal UTF-8 escapes) are decoded, so a quoted name is still checked.

- **No scope declared:** every change is unauthorized.
- **Widening the scope** changes the contract, which voids the approval, so a new human approval is required.
- The report carries `policy`: allowed, protected, changed files, out-of-scope, protected-touched, per-constraint status and effect.
- Policy repair hints tell the agent what to revert.
- The briefing tells the agent the enforced scope.
- Older records replay without the policy rule.

## Limitations
- Constraints are only as enforceable as the available adapters: path scope, plus callable checks.
- Behavioural constraints such as "no performance regression" stay unresolved, or advisory if a human marks them so.
