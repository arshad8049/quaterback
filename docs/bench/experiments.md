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
- **Unknowns stay `unknown` — but not for an official experiment's essentials.** In an exploratory experiment, image digests and the agent CLI version may be `unknown` when Docker or the CLI is unavailable. An official experiment is refused (re-review 1, below) unless the agent, proxy and tools images resolve to digests and the agent adapter version, requested coding-agent model and launch configuration are pinned.

## Re-review 1: every score has its patch; pins bind execution

**Problems (review, Jira 10216):**
- A graded trial could be recorded without `patch.diff`; the report then emitted `score: pass` with `patch: null`.
- Pins were observations. Nothing checked the actual code, images, agent or models before a run or a resume. An official manifest accepted an `unknown` agent image digest. The coding agent's requested model wasn't pinned.

**Patch evidence:**
- `recordTrial` refuses a `grade.json` without `patch.diff`. An empty `patch.diff` is the valid evidence for a no-change result. The grade's `patch_sha256` must equal the patch bytes.
- `loadExperiment` refuses a graded trial whose result has no `patch.diff`, or whose grade names another patch.
- The report never shows a score without its patch: a row with a grade but no patch is `missing_patch`, never pass or fail.

**Pins are enforced at run time (`preflight(manifest)`):**
1. It builds or resolves the sandbox images first (`ensureImages`, injectable).
2. It observes what **will** run now:
   - the QB commit and dirty state, including the exact archived dirty diff;
   - the image refs the sandbox modules will launch, and their resolved digests;
   - the agent adapter and CLI versions;
   - the coding agent's requested model and launch-configuration hash;
   - QB's requested model(s);
   - Node;
   - the grader file hashes.
3. It compares all of that with `manifest.pins` and **refuses any drift**, naming each field (e.g. `images.agent.digest: pinned …, now …`), before any agent work.

`bench/experiment-run.js` calls `preflight` at the start of every run and resume.
- A changed checkout, dirty state, image identity, model or Node can't continue an existing experiment; it needs a new one.
- The fingerprint it returns (`qb-runtime/1`) is recorded with every trial as `runtime.json`, hashed like any artifact.
- `recordTrial` refuses a trial without one, or one that differs from the pins.
- `report.js` checks each trial's own recorded fingerprint against the manifest. A row whose fingerprint differs, or that has none, is a mixed version: refused by default, labelled MIXED with `--allow-mixed`. A report can't certify versions just because every row cites the same experiment id.

**The coding agent's model:** the sandbox runs `claude -p` with no `--model` and passes no model variable (`sandbox/agent/entry.sh`, `AGENT_ENV`). So the requested model is recorded explicitly as `default`, together with a hash of the agent's launch configuration (entry script, managed settings, Dockerfile, environment). The model the provider actually served is not reported to QB; it stays `unknown` in `usage.models_returned`.

**Schema:** `pins.agent` gained two optional fields, `requested_model` and `config_sha256`. They are optional only so older manifests still parse; `bench/experiment.js` requires them for official experiments. New experiments create through `pinExperiment` (async: images first).

**Limits:**
- `preflight` checks identity immediately before the run. An image retagged between the check and a stage's launch is not re-verified per stage.
- Images are launched by their content tags (`QB_SANDBOX_*_IMAGE` or content-derived tags); preflight verifies those tags resolve to the pinned digests.
- **Old results are unrecoverable.** The pre-QB-29 results in `bench/results/` have no pins, patches or external grades and cannot be converted into an experiment.

## Re-review 2: identity per arm-trial, launches bound to pinned image ids

**Problem (review):** `preflight` ran once before the trial loop, and every trial's `runtime.json` reused that snapshot, while the sandbox launched by mutable tags. An image change after the first check went undetected, and later trials were certified with the earlier identity.

- **Per arm-trial preflight.** `runExperiment` calls `preflight` before **every** arm-trial (and once up front), so resumed trials are checked too.
  - Drift refuses that trial, which stops the experiment before its agent runs. Earlier trials stay recorded under their own identities.
  - Alongside the pins, `preflight` returns `image_ids`: each pinned image's immutable id (`sha256:…`), taken from the **same** `docker image inspect` that confirms the pinned digest, so there is no gap between "this tag is the pinned image" and "launch this id".
- **Launches bound to pinned ids** (`lib/sandbox/docker.js` `bindImages`). For the whole arm-trial, including external grading, every container the sandbox creates goes through the binding:
  - `create` (every `runStage`) and `run` (keeper, proxy, probes; executed as create → verify → start) launch from the pinned **image id**: a pinned tag in the arguments is replaced by its id, so a retag between validation and launch has no effect;
  - each created container's actual image (`.Image`) is checked against the pinned ids **before it starts**; a container from any other image is removed unstarted and the launch fails;
  - every launch is recorded as `{ container, image, ref }`.
- **Evidence from the trial itself.** `runtime.json` holds that trial's own preflight (`image_ids`) plus `launched`.
  - `recordTrial` refuses evidence whose `image_ids` don't cover the pinned images, or where any launch ran an image outside them.
  - `report.js` re-checks every trial's own launch evidence.
- **Regressions:**
  - unit: an identity change after the first arm stops the experiment before the second arm runs (pre-fix, both arms ran and were certified with the first snapshot); the recorded trial names the identity it ran under; binding lifecycle;
  - Docker, `test/integration/qb29-image-binding.test.js`: a tag retagged to busybox after binding still runs the pinned image (`node` works, both via `runStage` and `run --rm`); a container from an unpinned image is removed before its workload prints anything;
  - Docker, `qb28-experiment.test.js`: every trial records ≥ 5 launches (arm and grading), all from pinned ids, including the real agent image id.
- **Remaining limits:**
  - the provider-served model version is still `unknown` unless reported;
  - the binding covers containers the sandbox creates through `lib/sandbox/docker.js`, which is all of them in a benchmark run; the interactive `qb auth login` path is outside it and isn't used by experiments.
