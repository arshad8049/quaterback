# Arms, budgets and memory isolation (QB-28)

**Problem (review, QB-28):** the two arms were not comparable.
- **Time:** QB could get three agent invocations, each up to the sandbox's default agent deadline, while the baseline got one 8-minute invocation (`bench/baseline.js`).
- **Verification:** the baseline was verified with `null` context and its tests were never used as feedback.
- **Duplicated loop:** the benchmark carried its own copy of QB's attempt loop (`runQB` in `bench/run.js`) instead of the code users run.
- **Memory:** the benchmark never called L5.

## Scope: what these arms measure

Arms C–F start from the frozen spec's human-written, **human-approved oracle** as their contract. E and F run QB's production orchestration **after L1**. Intent compilation is not exercised: the L1 contract generation, the clarification rounds, their errors and their cost. Results from these arms are therefore **not evidence of end-to-end QB performance**. They measure what QB adds once a correct contract exists. Evaluating full production L1 with human approval would be a separate experiment. The label is recorded in `bench/arms.js` `SCOPE`, written into every manifest's `config.scope`, and reflected in arm E's `adds` text.

## One orchestration API

`lib/qb-pipeline.js` `runPipeline()` is QB's production orchestration after L1:

> L5 recall → L2 context → L3/L4 attempt loop (QB-10 routing, QB-18 refresh) → L5 persist

`qb.js`, `bench/run.js` and arms E/F all call it. It was extracted from `qb.js` unchanged:
- `test/unit/qb28-orchestration-golden.test.js` pins the run record, event trail, attempts, routing, console outcome lines, memory persistence and the cross-run memory hand-off;
- those tests were committed (`571fce9`) before the extraction and pass unchanged after it.

`runPipeline` with `memory: null` reads and writes no memory at all.

## The arm table (`bench/arms.js` `ARMS`, `runArm()`)

Each arm differs from the previous one by one thing. B differs from A in both its feedback and its attempt count, because that is what a retry loop is.

| Arm | Adds | Contract (who approves) | Feedback between attempts | Context | Memory | Max attempts |
|---|---|---|---|---|---|---|
| A | native agent: the original prompt, with a note that it may plan and run the project's tests | none | none | none | off | 1 |
| B | retry loop | none | the repository's **own visible tests**, run by the sandbox (stage ⑤); failing-test output tail, never the hidden grader | none | off | 3 |
| C | accepted contract | the spec's oracle, human-approved (`approved_by` in the frozen spec), QB-13 path | as B | none | off | 3 |
| D | QB context | as C | as B | QB L2 package | off | 3 |
| E | QB verifier + repair | as C | QB L4 verdict + QB-10 repair hints + QB-18 refresh (`runPipeline`) | as D | **off**: no reads, no writes | 3 |
| F | memory | as C | as E | as D | **on**: its own copy of the frozen starting store | 3 |

- **Primary comparison:** A vs E, predeclared in the manifest (`primary_comparison`). B, C, D and F are secondary ablations.
- **Execution gate:** every arm passes the QB-13 execution gate on the spec's approved oracle, including A and B, which never see that contract.
- **A manifest can't redefine an arm.** `bench/experiment-run.js` refuses a manifest whose arm definition differs from `ARMS`.

## Budgets: equal agent-time

- **The agent budget:** every arm gets the same total agent wall-clock, `budget.agent_time_ms`. Each agent invocation receives what remains as its deadline, and no invocation starts once the budget is spent (`budget.agent_time_exhausted` event). An arm without a retry loop (A) may use all of it in one invocation.
- **What sits outside it:** QB's other work (L1 contract, L2 context, L4 judging, repair routing). That work is **recorded** and bounded only by the per-trial deadline `budget.trial_deadline_ms` (a `lib/budget.js` run deadline).
  - Recorded per trial: total elapsed time; agent time; every QB model call; tokens and cost when reported; human approval time.
  - Missing values are `unknown`, never 0. The coding agent reports no tokens, so a trial's total tokens are `unknown`; QB's own model tokens stay in `usage.json` (`qb-usage/1`). Human approval happens when the spec is frozen and isn't timed, so it is `unknown`.
- **What this experiment is:** total compute is **not** controlled, and the manifest says so (`total_compute_controlled: false`). Results from this design must be described as an **equal agent-time** comparison.
- **One budget for all arms:** the manifest has a single `agent_time_ms` for every arm, so there is no way to write per-arm budgets. Extra budget fields, and per-arm time on an arm definition, are refused by the strict schema.

### Re-review: what the agent budget debits, and which deadlines are in force

- **Only the trusted agent stage is debited.** The sandbox reports the agent container's own run as `sandbox.stages.agent.duration_ms`. That is what `agent_time_ms` debits, and the next invocation's deadline is the budget minus the agent stages so far.
  - Seed, dependency install, capture and the visible-test run are **not** debited, so retry arms aren't penalized for sandbox overhead.
  - Each attempt's agent-stage and whole-invocation times are kept separately, in `usage.json` `arm_timing`.
  - If a result carries no stage duration, the whole invocation is debited (conservative), with `basis` saying so.
- **`model_call_deadline_ms` is the per-call limit in force.** The trial's budget run carries it (`lib/budget.js` `startRun({ modelCallMs })`), overriding `QB_MODEL_CALL_TIMEOUT_MS` while the run is active. `usage.json` `deadlines.model_call_ms` reports it.
- **`trial_deadline_ms` covers every stage, external grading included.**
  - The trial's budget run stays open through `grade()`, and grading receives its cancellation signal.
  - A grading run cut off by the deadline is cancelled, and the trial is recorded as `timeout` ("during external grading"). That is attrition, never a score.

## Memory isolation

- **Memory OFF (A–E):** no recall and no persist. A spy records `recall_calls: 0, persist_calls: 0`, and the default store stays untouched.
- **Memory identity (re-review):** a store namespace is keyed by a repository's realpath, and every trial runs in a fresh checkout at a new path. Arm F therefore binds its memory to the **frozen source repository** (`spec.repo.source`, part of the frozen spec) through `createMemory({ root, namespaceRepo })`. Recall and persist use that namespace, while each hint's file-existence and revision checks still run against the trial's own checkout. A test seeds a real history on the source (a passing task that changed `src/duration.js`, with a proven repair) and shows two things: the proven repair and the file reach F's first briefing in a fresh checkout, in two independent trials with identical starts; and E sees neither.
- **Memory ON (F):**
  - each trial copies the frozen starting store into a private directory, after checking its tree hash against `manifest.memory.starting_store_sha256`;
  - it runs with `createMemory({ root: <copy> })` and discards the copy afterwards;
  - the starting store is never modified, so an earlier evaluation trial's outcome can never influence a later one;
  - recall and persist calls are counted per trial.
- **Not run here:** sequential learning (experience accumulating across evaluation trials) would be a separate, declared experiment. This harness doesn't run one.

## Running (`bench/experiment-run.js`)

For every planned (trial, arm) not yet recorded:
1. a fresh checkout of the spec's pinned base;
2. its own run record (kind `bench-arm`);
3. its own budget run with the per-trial deadline;
4. `runArm()`;
5. the external grader (QB-27) on the final patch, the same for every arm;
6. `recordTrial()` (QB-29).

An arm that throws is recorded as `timeout` or `infra_error`, so attrition is kept. The run record keeps QB's internal outcome; the score is the grade.

`bench/run.js` remains as the legacy exploratory runner, with ungraded tasks, a baseline and `runPipeline` with memory off. Official experiments use `experiment-run.js`.
