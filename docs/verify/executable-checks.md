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
- **Execution: sandbox stage ⑥** (revised after review):
  - **⑥a** `checks-prep.sh` (trusted tools image, git read-only): makes a **fresh checkout of the pinned candidate** (`refs/qb/candidate`) in the scratch volume. It confirms the copy equals that tree, with `git diff <tree>` empty and no file outside the tree, and records the tree. It **never** uses the `/verify` copy the repository's own tests ran on, because a setup, build or test script may rewrite files there.
  - **⑥b** QB's runner (`sandbox/agent/qb-check-runner.mjs`, in the agent image) runs the checks on that checkout **mounted read-only**, plus the read-only dependency volume, with no network. Nothing during the checks can change the code under test.
  - Each check runs in its own child process with a 10 s timeout. The child reports on a nonce-prefixed line, which stops *ordinary* output from the code under test being mistaken for a result. It does **not** stop deliberate tampering: the code under test shares the child and container (see Limitations).
  - **Results are bound to two identities**, and anything else is unusable (`checks_tree_mismatch` / `check_set_mismatch`):
    - the code: `sandbox.checks.tree` (the verified fresh checkout) must equal `candidate_tree`, and the tests' tree;
    - the definitions: `check_set_hash` is a SHA-256 over the canonical JSON of the exact checks sent. The host records it, the runner recomputes it over what it received and writes it into the results, and the verifier compares both with the contract's checks. A result for different arguments or expectations under a reused id never counts.
  - No build output is used: checks run on the candidate's source as captured. A project that needs a build step before its modules can be imported isn't supported yet; its checks error, so the criterion is unresolved.
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
- **Grader isolation (deferred):** the code under test runs in the same child process and container as the runner, so it could deliberately forge results. The nonce only prevents accidental collisions. Isolating the grader from the code under test is a separate item, as for QB-06.
- `kind: non_behavioral` is L1's call. It's shown in the report so reviewers can see which criteria rest on judgment.
