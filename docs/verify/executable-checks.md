# Executable checks (QB-16)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

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

## Scenario checks (KAN-99, registry `qb-checks/3`)
The data adapters make one call with JSON arguments, or a sequence of method calls (`call_sequence`, QB-14, which the table above predates). Most dev-r2 criteria need a callback, a returned function or a side effect, which they can't express: 17 of 127 criteria fit (KAN-99 comment 10441).

A **`scenario`** check is a short CommonJS module that throws when its criterion is not met:

```js
module.exports = async ({ require, assert }) => {
  const inject = require('./index.js');
  let body;
  await inject((req, res) => { /* record */ body = '…'; res.end(); }, { method: 'POST', url: '/', payload: 0 });
  assert.equal(body, '0');
};
```

- **Only from a human-reviewed contract.** It is code, so `validateChecks` accepts it only with `allowScenario`. That is set by `contractFromObject(…, { reviewed: true })` for a contract file (`intent/contract-file.js`) and the benchmark oracle (`bench/arms.js`, `bench/run.js`). Model output (`compile()`) never carries one; it is rejected with the reason.
- **Bounded:** at most 8 KiB, and it must assign `module.exports`. A token screen rejects child processes, worker threads, `cluster`, dynamic `import()`, process control (`process.exit`, `.kill`, `.env`, …), `eval`, the `Function` constructor and `globalThis`. **The screen catches accidents and obvious misuse; it is not a security boundary.** The human review and the sandbox are.
- **Hashed:** the source is a parameter, so it is part of `check_set_hash` and of the approved contract hash. Changing one character invalidates both.
- **Not briefed:** like every check, it is never in the agent's briefing.
- **Run** by the same runner, in its own child process with the same timeout. `require` resolves only inside the candidate checkout (its `node_modules` included) or to a builtin that isn't network, process or VM related.
- **Results:**
  - **pass:** it returned without throwing;
  - **fail:** it threw (an assertion, or an error from the code under test, including a module that doesn't exist on that tree);
  - **error:** the scenario itself couldn't run (a syntax error, `module.exports` not a function, a forbidden or escaping `require`, a timeout).

### Milestone 1: can the checks say yes and no? (KAN-99)
- `bench/kan99/checks/<task>/<AC>.js` holds one scenario per criterion for AV-04, FJ-01, FP-03, LM-01 and PW-01 (23 criteria). They were written from each task's prompt, its criterion text and the base repository's public API, not from the hidden suites, the reference or the incorrect implementations. They are a development fixture: dev-r2 and its oracle contracts are unchanged.
- `scripts/kan99-scenario-matrix.js run <task>` overlays each patch (the base, the reference and every incorrect implementation) on a fresh clone of the built task repository, installs from its lockfile, and runs the checks with the runner above. `summary` cross-tabulates the result against the benchmark labels. **Yes** means every check passed; **no** means at least one failed. An error or a missing record is **incomplete**, never a yes or a catch.
- A saved record is never trusted. `summary` revalidates each one against a manifest it builds from the checks and the curation: the exact check ids, criteria and adapters (with the verifier's own `validateCheckResults`), the check set hash, the task's pinned `base_rev`, and the QB commit (`qb_commit`, written by `run`; `--qb-commit` names a different one explicitly). Empty results, an unknown status, a missing, duplicate, unexpected or reordered check, or any mismatch refuses the whole summary (exit 2); it is never counted as a yes or a catch (review 10450).
- `.github/workflows/kan99-scenario-matrix.yml` runs both steps in CI. It's free: no model, no agent, no secrets.
- The scope is 21 patches from one curated set. Those patches are not agent output, and the set is not held out.

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
- Adapters cover callable JavaScript modules (no TypeScript build step). Scenario checks extend what can be expressed, not what can be loaded. Other behaviour stays unresolved until an adapter exists: HTTP, CLI output, performance, side effects.
- Checks come from L1, so they are only as good as the contract. Whether ACs capture the essential behaviour is QB-14.
- **Grader isolation (deferred):** the code under test runs in the same child process and container as the runner, so it could deliberately forge results. The nonce only prevents accidental collisions. Isolating the grader from the code under test is a separate item, as for QB-06.
- `kind: non_behavioral` is L1's call. It's shown in the report so reviewers can see which criteria rest on judgment.
