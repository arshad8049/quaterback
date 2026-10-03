# Executable checks (QB-16)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
The verification plan was prose. It was printed into the agent's briefing, but L4 ran only the repository's own test suite plus model judgment. A plan step such as "call clamp(5, 0, 3) and expect 3" never produced evidence, and existing tests often don't exercise new behaviour.

## Model
- **Registry `qb-checks/1`** (`verify/checks/registry.js`). A check is *data*: an approved adapter plus typed, size-bounded JSON parameters.

  | Adapter | Parameters | Passes when |
  |---|---|---|
  | `module_exports` | `module`, `export`, `type` | the export exists with that `typeof` |
  | `call_returns` | `module`, `export`, `args`, `expect` | `await export(...args)` deep-strictly equals `expect` |
  | `call_throws` | `module`, `export`, `args`, `message_includes?` | the call throws or rejects (with that text) |

  Field rules:
  - `module`: a repository-relative `.js`/`.cjs`/`.mjs` path.
  - `export`: an identifier or `default`.
  - `args`/`expect`: plain JSON, ≤ 4 KiB, surviving a round trip unchanged.

  Unknown adapters, extra fields, shell text, escaping paths and the rest are **rejected** with a reason and never run. At most 32 checks per contract.
- **Contract.** L1 proposes `checks: [{ id, ac_id, adapter, params, plan_item? }]`. The compiler keeps:
  - `checks`: the accepted ones;
  - `checks_rejected`: the rest, with reasons;
  - `checks_registry`: the registry version.

  Each criterion has `kind`: `behavioral` (the default) or `non_behavioral`. Only an explicit `non_behavioral` opts out.
- **Execution: sandbox stage ⑥.** Checks run on the verification checkout (`/verify`, the captured candidate), after stage ⑤:
  - QB's runner (`sandbox/agent/qb-check-runner.mjs`, baked into the agent image) runs with no network and a read-only checkout;
  - each check runs in its own child process with a 10 s timeout;
  - a child reports on a nonce-prefixed line, so output from the code under test can't be mistaken for a result;
  - results go to `/out/qb-checks.json` (`qb-check-results/1`).

  The host accepts them only if they are complete, one per requested check, in order, and from the same tree the tests ran on (`sandbox.checks.tree` = `verification.tree` = `candidate_tree`).
- **The checks are not in the agent's briefing,** so expected values can't simply be hard-coded.

## Verdict
- A **behavioural** criterion is decided only by its executed checks:
  - all pass → met;
  - any fail → not met (FAIL, with a repair hint from the failing check);
  - any error, unusable results, or a different tree → unknown;
  - **no check → explicit `check_status: unresolved`**, and the judge is not asked.
- A **non-behavioural** criterion (documentation, naming, wording) is still decided by the independent judge.
- The report carries `checks` (requested, results, rejected, error) and `verification_plan_status`:
  - each plan item is `passed`, `failed` or `error` only through executed checks mapped to it via `plan_item`;
  - otherwise it is `not_executed`. Printing a step, or an agent claiming it ran, changes nothing.

## Limitations
- Adapters cover callable JavaScript modules (no TypeScript build step). Other behaviour stays unresolved until an adapter exists: HTTP, CLI output, performance, side effects.
- Checks come from L1, so they are only as good as the contract. Whether ACs capture the essential behaviour is QB-14.
- The code under test runs in the same container as the runner and could tamper with the results file (grader tampering, out of scope here, as for QB-06).
- `kind: non_behavioral` is L1's call. It's shown in the report so reviewers can see which criteria rest on judgment.
