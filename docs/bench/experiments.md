# Experiments and the report (QB-29)

**Problem (review, QB-29):**
- `bench/report.js` deduplicated `bench/results/*.json` by task id ("later file wins"), so runs with different contracts or code versions were merged.
- A task without a baseline row (T-006) was folded into the totals.
- Result files were named `<task>_<Date.now()>.json` with no experiment around them. Nothing tied a score to its patch, its grade, or the versions that produced it, and nothing was hashed.
- The markdown report printed today's date, so it couldn't be reproduced.

Records use the shared schemas in `bench/schemas.js` (`docs/bench/schemas.md`).

## The experiment directory (`bench/experiment.js`)

```
<root>/<experiment_id>/manifest.json            qb-experiment/1, written once
<root>/<experiment_id>/dirty.patch              exploratory only: archived uncommitted QB changes
<root>/<experiment_id>/trials/<trial_id>/<arm>/ patch.diff, grade.json, … , result.json (qb-trial-result/1)
```

- **`createExperiment(o)`** validates and writes the manifest.
  - The experiment directory is created with a non-recursive `mkdir`, so an experiment id is never reused.
  - Every file is created with `wx`.
  - The trial plan is validated: known tasks and arms, no trial/arm planned twice, one task and repetition per trial id, and a primary comparison of two defined arms.
  - Without an explicit `order`, the plan is task × repetition × arm in declaration order. The seeded randomized order is QB-30.
- **`collectPins(o)`** pins artifacts, not names:
  - **QB commit** (`git rev-parse HEAD`). An **official** experiment refuses a dirty checkout, staged, unstaged or untracked. An **exploratory** one archives `git diff --binary HEAD` plus a hashed listing of untracked files as `dirty.patch`, and records its sha256.
  - **Agent:** the adapter version (`AGENT_VERSION`: the Claude Code version installed in the sandbox image + content-tagged image) and the host's `claude --version` output, or `unknown`. The agent runs from the image, so the host CLI version is informational and can differ.
  - **Images:** agent, proxy and tools, by `docker image inspect` digest (a RepoDigest, else the image Id), or `unknown`.
  - **Node version.**
  - **Grader files:** each one's sha256.
  - **Models:** the requested model ids. The provider-returned version is recorded per trial (`usage.models_returned`).
  - Every external probe (git, docker, claude, image list) can be injected for tests.
- **`recordTrial(expDir, result, artifacts)`** records one arm of one planned trial.
  - Its directory is created exclusively, so recording the same trial/arm again throws: "already recorded; a re-run is a new trial".
  - It refuses a trial that is not in the plan.
  - It refuses a `grade.json` that names another task or spec version, an unpinned grader (`graderHash(pins.grader.files)`), or another patch, or whose outcome disagrees with `grade_outcome`.
  - Artifacts are written first and `result.json` last, carrying every artifact's sha256.
- **`loadExperiment(expDir)`** checks:
  - the manifest schema;
  - `config_sha256`;
  - the plan;
  - the dirty-patch hash.

  It then re-hashes every artifact of every trial, and a mismatch or a missing file throws, naming the file. An arm directory with no `result.json` (a crash mid-record) is returned as `incomplete`, never dropped silently.

**Grader hash convention:** a `qb-grade/1` must carry `grader_sha256 = hashOf(manifest.pins.grader.files)`, exported as `graderHash`.

## The report (`bench/report.js`)

```
node bench/report.js <experiment-dir> [--format table|markdown|json] [--allow-mixed]
node bench/report.js --legacy bench/results [--format table|markdown|json]
```

- **Verified input.** The report reads one experiment through `loadExperiment`, so a tampered or missing artifact stops it.
- **Mixed versions are refused by default.** That covers a result from another experiment, a trial outside the plan, and a grade made against another spec version, grader or patch. `--allow-mixed` reports them anyway, labelled **MIXED** with every reason listed.
- **Only external `pass` / `fail` grades are scores.** Everything else is attrition, counted per arm next to the planned and scored counts:
  - `needs_adjudication`, `grader_error`, `grade_infra_error`;
  - `ungraded`;
  - trial `agent_error`, `timeout`, `trial_infra_error`, `missing`;
  - `incomplete`, `not_recorded`.

  QB's own verdict (`internal_verdict`) is listed separately and never scored.
- **The primary comparison uses matched pairs only:** same task and repetition, with both primary arms scored. Every unmatched pair is listed with each arm's category, so filtering can't hide attrition. A missing baseline stays missing, never a loss or a win.
- **Each trial row links** to its `patch.diff` and `grade.json`.
- **`per_task`** holds per-task repetitions and matched pass counts, the input for QB-30's cluster bootstrap over tasks and repositories. The report itself has counts only; no rates, CIs or lift.
- **Byte-identical output:** no clock, stable sort (task, repetition, arm order A–F). The same stored files always give the same bytes, in-process or via the CLI.
- **`--legacy`** lists old `bench/results` files one per file. The label is "pre-QB-29, not comparable", with each file's internal verdicts and its contract hash (so differing contracts are visible). Files are never deduplicated, merged or aggregated, and the old multi-run summaries are listed as skipped.

## Guarantees and limits

- **Reproducible reporting:** the stored, hash-verified artifacts regenerate the same report.
- **Execution is not reproducible:** re-running an AI agent from the same manifest can produce a different patch. A re-run is a new trial.
- **Hashes are not signatures.** They detect corruption, and tampering by anyone who does not also rewrite the recorded hash in `result.json` / `manifest.json`. Someone with write access to the experiment directory can rewrite both. `wx` only prevents accidental overwrites.
- **Unknowns stay `unknown`.** Image digests and the agent CLI version are `unknown` when Docker or the CLI is unavailable at creation; the report shows them as such. An official run should be created on the machine that runs it.
- **Old results are unrecoverable.** The pre-QB-29 results in `bench/results/` have no pins, patches or external grades and cannot be converted into an experiment.
