# Evaluation harness schemas (Phase 4: QB-27..QB-30)

`bench/schemas.js` defines every record the Phase 4 harness reads or writes. The schemas were agreed before the grader (QB-27) and the experiment store/report (QB-29) were built, so both cards share one definition. Changing a schema means a new version string; no record is reinterpreted silently.

| Record | Written by | Purpose |
|---|---|---|
| `qb-task-spec/1` | a person, then frozen | prompt (what agents see), semantic requirement (graders/adjudicators only), hidden suite, grader-owned paths, adjudication rules, qualification, provenance, changelog |
| `qb-spec-lock/1` | `bench/specs.lock.json` | spec id → version + content hash + split; a hash that changes after results exist is refused |
| `qb-experiment/1` | experiment creation | pinned artifacts, tasks, arms, budgets, trial plan, protocol + approval |
| `qb-trial-result/1` | one arm of one trial | status, hashed artifacts, internal verdict (recorded, never the score), grade outcome, usage, memory isolation |
| `qb-grade/1` | the external grader | outcome + reason + per-check results, for one patch |
| `qb-adjudication/1` | one adjudicator | a blinded verdict on one item |

## Rules the schemas encode

- **Pins are artifacts, not names.**
  - QB commit, plus a dirty flag and the hash of the archived dirty diff (official experiments refuse dirty code);
  - the agent's adapter version and its CLI version;
  - sandbox images by digest;
  - the task repository commit and lockfile hashes;
  - grader file hashes, spec hashes and the full config with its hash;
  - Node;
  - requested model ids. The provider-returned model version is recorded per trial in `usage.models_returned`.
- **Unknown stays unknown.** Usage fields (`agent_ms`, `model_calls`, `tokens`, `cost_usd`, `human_approval_ms`, returned model versions, the agent CLI version and image digests) accept `'unknown'` and are never coerced to 0.
- **Only `pass` / `fail` are scores.**
  - `grader_error` and `infra_error` are attrition: reported per arm, never counted as a pass or a fail.
  - `needs_adjudication` is allowed only for checks the frozen spec lists in `suite.adjudicate_checks`.
  - Trial `status` values other than `completed` are attrition too.
- **Budgets are declared.** `agent_time_ms` is the same total agent wall-clock for every arm; this is the "equal agent-time" condition. `trial_deadline_ms` bounds the whole arm-trial. `total_compute_controlled` is the literal `false`, so no report can imply otherwise.
- **Memory isolation is recorded per trial:** the mode, the hash of the starting store, and recall/persist call counts. Memory-off must show 0 and 0.
- **Holdout approval names exact hashes.** `approval` must carry `protocol_sha256` and `holdout_set_sha256` (`holdoutSetHash`: the sorted id / version / hash of every holdout spec). A bare approver name is not an approval.
- **Paths are contained.** Artifact and suite paths are relative POSIX paths with no `..`; a symlink inside a hashed tree is refused.

## What the hashes do and don't guarantee

`hashOf` is sha256 over canonical JSON (sorted keys); `fileHashes` / `treeHash` hash raw bytes.

- The report re-hashes every artifact before use, so corruption or an edited artifact is detected unless the editor also rewrites the recorded hash.
- The hashes are not signatures. Anyone with write access to the experiment directory can rewrite both.
- **Reproducible reporting** (stored artifacts → an identical report) and **execution** are separate guarantees. Re-running an AI agent from the same manifest can produce a different patch, and a re-run is a new trial, not a reproduction.
