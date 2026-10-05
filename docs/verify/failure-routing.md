# Failure routing (QB-10)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

## Why
- Failed tests only overrode a pass verdict.
- With every AC met but tests failing, there were no AC failures and no repair hints, so the repair loop stopped (pre-fix on `4ae5071`: verdict fail, `failures: []`, 0 repair hints).
- Nothing proved whether a failure was pre-existing.
- Infrastructure errors weren't separated from code problems.

## Base vs candidate (sandbox stage ⑤b)
- When the candidate's test run exits nonzero, the **same suite runs on the base tree**: `base-prep.sh` makes a fresh checkout of `refs/qb/base`, confirmed identical to that tree, in the scratch volume. QB's reporter writes `qb-node-test-base.ndjson`.
- QB's reporter records each failing test with a bounded error message (`error`, ≤ 500 chars).
- QB's reporter also records each test's **suite path**, rebuilt from node:test's `test:start` events. These are emitted per file in definition order. If the path can't be established it is `null`.
- `verify/tests.js` compares **every** failing test; the comparison is never truncated. Identity is the **file relative to the run root + suite path + test name**.
  - **pre-existing:** exactly one base failure has the same identity **and fails the same way** (same `failureType`, same assertion message).
  - **regression:** anything else. That includes:
    - a test that is new or passes on the base;
    - a test that fails for a new reason (`changed_failure: true`);
    - a test with no established path;
    - an identity that appears twice on either side (ambiguous).
  - **Waiving is an explicit, approved policy.** Pre-existing-only failures give `preexisting_failures` (no block on PASS) only when the approved contract sets `test_policy: { "preexisting_failures": "waive" }`.
    - `test_policy` is part of the approval hash and shown in the approval view.
    - By default they still **fail** the task (`preexisting_failures_not_waived`). They stay listed and aren't blamed: no repair action is invented, and routing stops.
  - **The base run is held to the same rigor as the candidate's.** All of these must hold:
    - it finished normally (`completed`/`execution_error`; not timeout, OOM, infra or cancelled);
    - it has a real exit code, not 126/127;
    - the exit code agrees with the report (failures ⇔ exit 1, none ⇔ exit 0);
    - the report is complete and consistent, with no cancellation or collection failure.

    Otherwise **every failure counts as a regression**, with `baseline: baseline_<reason>`.
- **Display bounds are separate from the decision.** The report lists at most 50 regressions and 50 pre-existing failures, plus `regressions_total` / `preexisting_total`. At most 10 test repair actions are produced.

## Verdict and repair
- Outcomes are reported independently in `outcomes { execution, policy, tests, criteria }`.
- A regression fails the task even when criteria are unknown.
- Each regression becomes a repair action `TEST:<file>:<name>` with its evidence ("fails after this change: <error>").
- `aggregate` rules 5: the classified test outcome replaces the old "any failed count forces FAIL" rule. Records stored under rules ≤ 4 replay as they were decided.

## Routing (`verify/routing.js`, shared by `qb.js` and the benchmark)

| Action | When |
|---|---|
| `done` | pass |
| `environment` | the agent execution failed, or the test run is unusable (timeout, OOM, infra, no report, collection failure, cancelled tests). **No code repair.** |
| `stop` | nothing concrete to repair, **or no progress**: the patch is identical to the previous attempt's |
| `repair` | concrete repair actions exist: a failing check or criterion, a policy violation, a test regression. Bounded by `--max-retries`. |

## Limitations
- The base run costs a second test run, only when the candidate's tests fail.
- "Fails the same way" compares the bounded assertion message exactly. A message that varies between runs (timestamps, temp paths) counts as a regression, which fails closed.
- A suite path depends on node:test's per-file event order. If a test file runs its own subtests concurrently, the path may not be established, which also fails closed.
- The base run must exit 1 when tests fail (what `node --test` does). A custom test script that exits with another code makes the baseline unusable, which fails closed.
- Only node:test reports carry test identities (QB-06).
