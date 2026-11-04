# Provenance: KAN-106 run 1 (2026-11-04)

These trial rows predate recorded run identity (`run` in `qb-l1-eval-trial/2`). This note says which harness produced each file. It was reconstructed from git objects and file times, and no data was rerun.

| file | model (digest) | rows say commit | harness that actually ran | trial times (UTC) |
|---|---|---|---|---|
| `trials-deepseek-r1_7b.jsonl.gz` | deepseek-r1:7b (`0a8c2669…6e73163`) | `d946ff3` | **`53a9f8d`** (see below) | 17:00:33–17:50:12 |
| `trials-qwen2.5-coder_14b.jsonl.gz` | qwen2.5-coder:14b (`9ec8897f…968716849`) | `ab835c7` | `ab835c7`, clean tree | 17:50:14–19:11:21 |

**Why the DeepSeek rows say `d946ff3`.** The baseline started at 17:00:33 UTC (the first trial ended 17:02:17 after 104 s), from an uncommitted working tree on top of `main` `d946ff3`. The harness files were committed two minutes later as `53a9f8d`. That commit was then amended as `ab835c7` to route the fixture repo's `git` calls through `lib/proc.js`. It is no longer on the branch; it is kept as tag `kan106-run1-deepseek-harness` so the objects below can be checked. Every harness file was last modified before the run started (`score.js` last, at 17:00:23 UTC), so the tree that ran is `53a9f8d`.

**Why the comparison is like for like.**
- `bench/l1-eval/tasks.json` is the same blob in `53a9f8d` and `ab835c7` (`b7c33d54…`).
- `bench/l1-eval/score.js` is the same blob in both (`0890586e…`).
- `bench/l1-eval.js` differs only in the fixture repo's git helper: `child_process.execFileSync` became `lib/proc.git`, with the same argv and env.
- `git diff d946ff3 ab835c7` touches only `bench/l1-eval*` and `test/unit/kan106-l1-eval.test.js`. No compiler, prompt, validator or `lib/budget.js` code differs between the two runs.
- Settings were the same for both: defaults for `QB_MODEL_CALL_TIMEOUT_MS` (180 000) and `QB_MODEL_CONCURRENCY` (2), local Ollama at 127.0.0.1:11434, the same machine (darwin arm64, 11 cores, 18 GiB, Node v20.20.2).

**Scoring.** `summary.{json,md}` here is regenerated with `node bench/l1-eval.js --summarize`. That rescores the saved contracts against the current `tasks.json` (`qb-l1-eval-tasks/2`, with module-pinned matchers and named relations). The outcomes are the ones recorded at run time. The proxy-pass counts did not change under the stricter matchers.

**Known proxy gap, found by hand review.** The proxy checks that the expected checks are present. It does not penalise extra, meaningless checks. For example, some finalized Qwen greeting contracts also contain `call_returns` on `test/greeting.test.js` expecting `true`. A proxy pass is not a correctness claim.

From `qb-l1-eval-trial/2` on, each row records `run: { task_set_sha256, code_sha256, dirty, settings }`. Summaries pool trials only under the same model digest, task set, code and settings. Different runs under one model name are reported separately, with a warning.
