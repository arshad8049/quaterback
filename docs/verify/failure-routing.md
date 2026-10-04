# Failure routing (QB-10)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
- Failed tests only overrode a pass verdict.
- With every AC met but tests failing, there were no AC failures and no repair hints, so the repair loop stopped (pre-fix on `4ae5071`: verdict fail, `failures: []`, 0 repair hints).
- Nothing proved whether a failure was pre-existing.
- Infrastructure errors weren't separated from code problems.

## Base vs candidate (sandbox stage ⑤b)
- When the candidate's test run exits nonzero, the **same suite runs on the base tree**: `base-prep.sh` makes a fresh checkout of `refs/qb/base`, confirmed identical to that tree, in the scratch volume. QB's reporter writes `qb-node-test-base.ndjson`.
- QB's reporter records each failing test with a bounded error message (`error`, ≤ 500 chars).
- `verify/tests.js` compares failing tests by identity (path relative to the run root + test name):
  - **regressions**: fail on the candidate, not on the base → outcome `failed`;
  - **pre-existing**: also fail on the base → listed in `test_outcome.preexisting`. If they're the only failures → outcome `preexisting_failures`: visible, not blamed on this change, and doesn't block PASS.
  - If the base run is missing or unusable (no report, malformed, cancelled, collection failure), **every failure counts as a regression**, with `baseline: baseline_<reason>`.

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
- A test that fails on both, but for a different reason, still counts as pre-existing (identity is by name).
- Only node:test reports carry test identities (QB-06).
