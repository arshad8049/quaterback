# Evaluation protocol (QB-30) — DRAFT for independent review

**Status:** a draft. It has **not** been independently reviewed, and no holdout task has been run. The harness refuses holdout execution until a reviewer's approval names this document's exact sha256 and the exact holdout spec set (`bench/plan.js` `holdoutGate`). Any edit to this file after approval changes its hash, and holdout runs are then refused until it is approved again.

**Goal:** to find out whether Quarterback helps, does nothing, or makes coding-agent outcomes worse on the tested task distribution. A favourable score is not the goal. Every result is reported, including null and negative ones.

## 1. What is compared

The arms are defined in `docs/bench/arms.md` (`bench/arms.js` `ARMS`). Each one adds exactly one thing over the previous.

- **Primary comparison:** A (the native agent) vs E (QB's verifier and repair, after L1, from a human-approved oracle). This is fixed before any run.
- **Secondary comparisons:** B, C, D and F each against A. These are **exploratory ablations**: reported with intervals, never used for headline claims.
- **Scope:** E and F start from a human-approved oracle contract. They do not measure intent compilation (L1), its errors or its cost. Results are not evidence about end-to-end QB including L1 (`config.scope` in every manifest).
- **Budget:** **equal agent-time**. Every arm gets the same total agent-stage wall-clock. QB's other work (L1–L4 model calls, context, judging) is recorded but not equalized, so total compute is **not** controlled.

## 2. Tasks

- **Frozen specs (QB-27):** every task is a `qb-task-spec/1` spec.
  - It has a prompt (the only text agents see), a human semantic requirement, a hidden check suite (qualified against a correct reference and at least two incorrect implementations), adjudication rules, the base commit and lockfile hashes.
  - It is frozen in `bench/specs.lock.json` before any arm runs.
- **Strata:** every spec declares `stratum.type` (addition, bug_fix, integration, refactor, state, errors, already_satisfied) and `stratum.repository`.
- **Repositories:** pinned public repositories, built reproducibly (`qb-bench:<name>`, `bench/repos.js`; `docs/bench/curation.md`). Every machine gets the same base commit.
- **Development set:** 30–50 tasks from several repositories, used to debug the harness and choose the trial count. It is written on the QB side (`docs/bench/curation.md`: 30 tasks, 5 repositories) and is never used for headline claims.
  - **The six legacy tasks** in `bench/tasks.json` (the `cue` repository) stay **ungraded**. They were tuned during development (`split: dev`, `tuned_during_development: true`), their base is local to one machine and they have no frozen spec, so they cannot be reproduced. They are excluded from every scored denominator and from the holdout; an experiment is built from frozen specs only, so they cannot enter one. Their historical result rows are kept, labelled legacy, tuned and ungraded (`bench/report.js` legacy report), and are never removed silently. Grading them later would need a reproducible base plus a separate provenance and licence decision.
- **Holdout set:** a separate, untouched set across repositories, covering every stratum.
  - It is written by an author **outside QB development**, following `docs/bench/curation.md` (KAN-63).
  - Holdout specs are written and frozen before the protocol review, and the reviewer approves their exact set hash.
  - Nobody on the QB side runs, debugs or reads agent output on holdout tasks before the approved execution.

## 3. Execution

- **Pinned runtime (QB-29):** experiments are `official`, with a clean QB checkout, image digests, agent version, requested model and launch config, grader files and spec hashes, all pinned. Identity is re-checked before every arm-trial, and every container launches from the pinned image id.
- **Order:** randomized from a recorded seed (`bench/plan.js` `seededOrder`). (Task, repetition) blocks are shuffled, and within a block every arm runs back to back (paired) in a seeded order.
- **Isolation:**
  - each arm-trial runs in a fresh checkout of the pinned base, with its own run record and per-trial deadline (`trial_deadline_ms`, covering grading);
  - memory-on trials each start from a private copy of the frozen starting store;
  - memory-off reads and writes nothing.
- **Repetitions:** 3 trials per task per arm is the initial choice. The final count is set from dev-set variance and the smallest effect worth detecting, recorded **before** holdout execution, and approved with the protocol.
- **Sequence.** The dev pilot and the official holdout run are separate steps, because the trial count comes from dev-set variance before the independent approval:
  1. the dev-set specs are corrected and frozen, each oracle approved by a named person;
  2. a **capped, paid dev pilot** runs on the dev set only (its budget authorized separately). It is exploratory and never reported as evidence of effectiveness;
  3. the pilot's variance is used to propose the repetitions and the minimum detectable effect;
  4. the independent reviewer reviews this protocol and the exact frozen holdout hashes, and records the approval (§7);
  5. the official holdout run is authorized and executed. Until step 4, the holdout gate refuses it.

  Holdout authoring can proceed in parallel with steps 1–3.

## 4. Grading

- **Same grader for every arm (QB-27):** the external grader is identical for every arm. Its inputs are the frozen spec, the hidden suite and the patch, never the contract, internal verdict or arm. The untrusted patch is applied only inside the sandbox.
- **Scores and attrition:**
  - only `pass`/`fail` are scores;
  - `grader_error`, `infra_error`, `needs_adjudication` (only for checks a spec reserves), missing, incomplete, agent errors and timeouts are **attrition**;
  - attrition is reported per arm next to completion rates and is never counted as a win or a loss.
- **Adjudication:** blinded (no arm, trial or internal verdict). Every adjudicator's verdict is kept, and disagreements are reported, not resolved by majority.

## 5. Analysis (predeclared; `bench/stats.js`)

- **Unit of analysis: the task.** Repeated trials are nested within a task, and tasks are grouped by repository. Trials are never treated as independent observations.
- **Task effect:** `d_t = (passes of E − passes of A) / matched pairs` over that task's matched repetitions (both arms scored). A task with no matched pair has **no** effect and is listed, never set to 0.
- **Estimate:** the mean of task effects. Every task weighs the same.
- **Uncertainty:** a two-stage **cluster bootstrap**. Resample repositories with replacement, then tasks within each sampled repository, B = 2000, percentile 95% CI, seeded from the experiment so reports are reproducible.
  - With fewer than two repositories, the interval is labelled as not generalizing across repositories.
- **Not used:** McNemar's test (or any test) over all trial rows. It treats repeated trials of one task as independent and overstates the evidence.
- **Operational endpoint (predeclared, reported next to the primary):** success per **assigned** repetition. Over the repetitions planned for both arms, anything but a pass (fail, agent error, timeout, infra or grader error, missing) counts as no success. Task effect `o_t = (successes of E − successes of A) / assigned pairs`; same estimate and cluster bootstrap as the primary (`bench/stats.js` `operationalEffects`).
  - Why: the primary is complete-case. It drops a pair when either arm has no score, so an arm that errors out on hard tasks could look better among its surviving runs.
- **Strata:** mean effect and matched-task counts by task type and by repository.
- **Reported alongside correctness:** completion rate and attrition per arm, agent-stage time, elapsed time, QB model calls, tokens and cost where reported (unknown stays unknown), human interventions, and every failed or missing run.
- **Interpretation:**
  - a claim of improvement requires the primary 95% CI to exclude 0 **and** the operational endpoint's 95% CI to exclude 0 in the same direction. When they disagree, both are reported and no improvement is claimed;
  - a CI containing 0 is reported as "no detectable effect", not as a win;
  - a negative CI is reported as harm;
  - claims are bounded to the tested task distribution and strata.

## 6. Change control

- **After viewing holdout results:** any change to QB, a spec, the grader, the arms or this protocol is a **new experiment version**, with new pins, re-frozen specs (with `after_viewing_results: true` in their changelog) and a new approval. It is disclosed in the report.
- **Earlier results are kept:** holdout results that were already viewed are never discarded or re-run silently.

## 7. Approval record

The reviewer's approval goes in the manifest as `approval`. Not a name alone; it records:
- `approver`;
- `approved_at`;
- `protocol_sha256`: this document, from `sha256sum docs/bench/protocol.md`;
- `holdout_set_sha256`: `holdoutSetHash` over the exact holdout specs.

## Open items (outside the harness)

1. **Task curation:** the dev set (KAN-62, `docs/bench/curation.md`) and the independently written holdout (KAN-63), with qualified hidden suites.
2. **Independent protocol review**, and the approval record above (KAN-63).
3. **The evaluation run itself:** paid agent time, and a Claude Code login (`qb auth login`) (KAN-64): the capped dev pilot first, then the official holdout run (§3, Sequence).
4. **For the reviewer:** whether the operational endpoint should be primary rather than reported alongside, and whether a further sensitivity analysis for attrition is needed.
