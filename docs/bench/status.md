# Evaluation status (QB-30)

**Last updated:** 2026-10-16. **Jira is authoritative for status.** This page sums up where the
evaluation stands against the sequence in `docs/bench/protocol.md` §3, and links each result to
its run. It is a progress record, not part of the protocol: editing it never changes the
protocol's hash.

**Headline:** no comparison so far shows that Quarterback improves outcomes. Both runs were
exploratory, and in both the agent alone solved every task (a ceiling effect).

## Protocol sequence

| Step (§3) | State |
|---|---|
| 1. Dev specs corrected and frozen | Done for v1: 30 tasks, 5 repositories (`bench/specs.lock.json`). The v1 qualifications record the earlier grader, so the current grader refuses them. Re-qualification r2 is drafted, not frozen (`docs/bench/dev-r2.md`, KAN-71) |
| 2. Capped dev pilot (exploratory) | Done: run 38307663205, below |
| 3. Repetitions and minimum detectable effect | **Blocked.** At near-100% pass in both arms there is no usable variance. It needs tasks the agent alone fails, or a primary measure with room to move: an open protocol decision |
| 4. Independent protocol and holdout review | Not started. The holdout needs an independent author (KAN-63) |
| 5. Official holdout run | Not started. The holdout gate refuses it until step 4 |

## Exploratory results

Scores come from the external grader only. QB's internal verdicts are recorded and never
scored. Neither run is evidence of effectiveness.

### Dev pilot (2026-10-12, KAN-64)

[Run 38307663205](https://github.com/arshad8049/quaterback/actions/runs/38307663205), QB 0fa061b,
1 repetition by owner decision.

| Arm | Scored | Pass | Fail | Attrition |
|---|---|---|---|---|
| A, the agent alone | 30 | 30 | 0 | 0 |
| E, QB verify and repair from the approved oracle | 30 | 29 | 1 (LM-04) | 0 |

- **Effect:** −0.033, 95% CI −0.129 to 0 (task-level cluster bootstrap).
- **E's internal verdicts:** 24 partial, 6 unresolved. The frozen oracles have no executable
  checks, so QB cannot confirm behavioural criteria.
- **Not analysed yet:** E's failure on LM-04.

### Harder-task screen (2026-10-13, KAN-64 and KAN-65)

14 real Fastify v5 bug fixes, chosen for difficulty, so **never headline evidence**. 2
repetitions per arm. Details: `docs/bench/hard-candidates.md`, `docs/bench/screen-review.md`.

- **Main run:** [38409518314](https://github.com/arshad8049/quaterback/actions/runs/38409518314).
  - 12 tasks ran clean: A 24/24, E 24/24.
  - FY-07 and FY-14: 8 agent execution failures with empty patches, all in the last shard. The
    harness first graded them as fails. Since 7443bd0 it records them as attrition, as the
    protocol requires.
- **Rerun of those 8:** [38459455639](https://github.com/arshad8049/quaterback/actions/runs/38459455639),
  A 4/4, E 4/4.
- **Combined:** A 28/28, E 28/28, but only by counting the rerun pairs. The main run and the
  rerun are separate experiments, and first-attempt success over every assigned trial is lower
  (the 8 failures).
- **Cost of QB on these tasks:** QB's internal verdict called 27 of the 28 passing E patches
  `fail`. E therefore used all 3 attempts in 23 of 24 clean main-run trials. Its agent time was
  about 52–159 s per trial, against A's 13–67 s.
- **Context model:** the L2 context model timed out at 180 s in every E trial on the CPU runner,
  so E ran without LLM context.

## What the screen led to (KAN-65)

- **False regressions:** a pre-existing test failure whose message names its own run directory is no longer reported as a new regression (eb3fec6).
- **Base check:** qualification checks that the unchanged base passes its own tests, and fails
  closed on a broken `.quarterback.json`.
- **FY-08:** corrected as a disclosed v3.
- **Supported-scope plan:** 10 of the 14 tasks included, 4 excluded. In the excluded four, the
  required change contradicts an existing test that QB protects. That is a product limitation,
  decided after viewing results (`docs/bench/screen-supported-scope.md`).
- **Not run:** no supported-scope run has been made, and none is approved.

## Open items

- **Tasks the agent alone fails.** Without them, pass rate cannot separate the arms.
- **A primary measure with room to move.** Whether pass rate stays primary is a protocol
  decision for the owner and the independent reviewer.
- **The approved test-update design** (option c), so tasks that legitimately change an
  existing test are supported.
- **KAN-70:** FY-04's reference omits the upstream docs and type updates.
- **The LM-04 failure** in the dev pilot, not analysed yet.
- **The L2 context timeout** on CPU runners.
