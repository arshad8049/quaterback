# Repairs linked to the patch that resolved them (QB-23)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
- **`qb.js` handed memory only the final report.**
  - A successful report has no failed-criterion repair hints.
  - `remember()` saved hints only from a non-failing report.
  - So a real fail-then-repair sequence saved **zero** repairs.
- **Any hint that was saved was stamped `resolved: true`** without evidence that it fixed anything.

**Pre-fix reproduction (on `a20ba67`), through the real `qb.js` loop** (`test/unit/qb23-repairs.test.js`):
- AC-1 is judged not met on attempt 1. The repair hint drives attempt 2 with a different patch, and AC-1 is met there.
- `repairs.jsonl` had **0** lines.
- Through `memory.remember()` with real `verify()` reports, the same fail-then-PASS sequence also saved 0.

## Design
**1. An append-only attempt history.** `qb.js` keeps one entry per verified attempt, built by `memory/repairs.js` `attemptEntry`:
- the run record's patch hash (`patch_sha256`, from QB-38);
- the report id and verdict;
- whether the oracle was approved;
- the criteria results, with each criterion's QB-11 evidence IDs;
- the repair hints;
- an `evidence_sha256` over the criteria, evidence IDs and test outcome.

It is stored with the run's outcome record (`attempt_history`, `run_id`) in memory's append-only `outcomes.jsonl`.

**2. Each repair hint is linked to what followed it** (`linkRepairs`). A hint from attempt N, for criterion X, is linked to:
- attempt N+1's patch hash (`patch_before_sha256` → `patch_after_sha256`);
- X's re-evaluation there (`before` / `after`: met, method, evidence IDs);
- the run's final verdict and oracle approval.

There is one link per criterion per attempt.

**3. Suggestion, observation and confirmation are stored separately** (`repairs.jsonl`, record `schema: 2`, `source: model_suggestion`):

| outcome | when | proven? |
|---|---|---|
| `resolved` | X was not met at N, met at N+1 on a **changed** patch, **and** the run ended in an **approved PASS** with X still met | **yes** (`resolved: true`) |
| `observed_resolved_unconfirmed` | X flipped to met on a changed patch, but the run did not end in an approved PASS | no |
| `unresolved` | unchanged patch, no patch, X still not met at N+1, or X was not failing when hinted | no |
| `not_attempted` | no later attempt (abandoned, out of retries) | no |
| `not_tracked` | the hint is not about an acceptance criterion (tests, policy, constraints) | no |

Every hint is recorded with its outcome. Without an attempt history nothing can be linked, so nothing is recorded as a repair.

**Recall** (`recallRepairs`):
- It returns `status` and `proven` for every result.
- Only `resolved`, `observed_resolved_unconfirmed` and pre-QB-23 records are recalled.
- Pre-QB-23 records have no `schema` field, so they are labeled `legacy_unverified`: their `resolved` flag was never established.
- Proven repairs rank first.
- Unresolved and abandoned suggestions are never recalled as fixes.
- `qb.js` prefixes recalled hints in the agent briefing with `[proven fix from a past run]` or `[past suggestion, not proven]`.
- `stats()` reports `repairs_proven`.

## Done when
- **A failed AC repaired on attempt two creates one traceable resolved repair:** it links attempt 1's failure and hint → attempt 2's patch hash → attempt 2's criterion met, with evidence IDs → the final approved PASS. This is tested through real `verify()` reports, and through the `qb.js` loop (where the run is not an approved PASS, so it is recorded as observed and unconfirmed).
- **Nothing else marks a hint proven:** an unchanged patch, an abandoned task, a success on a different criterion, a run that did not end in an approved PASS, a non-criterion hint, or a criterion that was not failing. Each is tested.

## Limitations
- Resolution is attributed per criterion, from the next attempt only. If one patch addresses several hints, each hint whose criterion flipped is credited.
- Test-regression, policy and constraint hints are recorded as `not_tracked`, not attributed.
- The store itself (path captured at import, unlocked stats, silent dropping of corrupt lines) is QB-25's scope, and is unchanged here.
- The `memory/sandbox/run.js` demo calls `remember()` without a history, so it now records no repair links.
