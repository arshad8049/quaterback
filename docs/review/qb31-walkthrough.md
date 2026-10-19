# QB-31 fresh-machine walkthrough: evidence record

The acceptance evidence for QB-31: a person follows [docs/onboarding.md](../onboarding.md) on a clean machine, from install to artifact inspection, with one **real, authenticated** Claude Code task. Fake agents and CI smoke tests don't replace it (KAN-31 comment 10264).

**Never record credentials:** no tokens, keys, login URLs with codes, or `~/.qb` auth contents. Redact them in the transcript.

## Machine

A clean **Ubuntu 24.04 LTS x86_64** VM with **at least 16 GB RAM** (the sandbox admits a run only with about 11.1 GiB free): no previous QB state, auth volume, cached project dependencies or prebuilt QB images.

`scripts/qb31-walkthrough.sh` runs these steps in order and writes this record (machine table, step table, run ids, redacted logs) to `~/qb31-evidence/`. Free option without a VM: [GitHub Codespaces](qb31-codespaces.md).

| | Value |
|---|---|
| Date / operator | |
| VM / provider, CPU, RAM, disk | |
| `uname -a`, `lsb_release -d` | |
| `node --version` | (Node 24) |
| `docker version --format '{{.Server.Version}}'` | |
| `ollama --version`, `QB_MODEL` | |
| QB ref given, `git rev-parse HEAD` | |
| Claude Code version in the sandbox (`AGENT_VERSION`) | |
| Login route | `qb auth login` (subscription) |

## Result: PASSED — attempt 4, 2026-10-12 (owner run, GitHub Codespaces)

**Raw record, unedited:** [`qb31-walkthrough/attempt-4-2026-10-12-codespaces/`](qb31-walkthrough/attempt-4-2026-10-12-codespaces/evidence.md), with its redacted logs. It was checked for keys, tokens and codes, and none are present.

| | Value |
|---|---|
| Date / operator | 2026-10-12, 15:00–15:09 UTC / Arshad Ahmed Shaik (owner) |
| Machine | GitHub Codespaces, 4-core: AMD EPYC 7763, 15.6 GiB RAM, 32 GB disk. Ubuntu 24.04.3 LTS, x86_64. A container: no systemd, docker-in-docker (see [qb31-codespaces.md](qb31-codespaces.md)). |
| Versions | Node 24.21.0, npm 11.19.0; Docker 29.8.2; Ollama 0.40.3 with `deepseek-r1:7b` |
| QB ref | `main` 54c2f24 (the given ref = `git rev-parse HEAD`) |
| Agent | `claude-code@2.1.288` (qb-sandbox-agent:c-4b166ca34296ddda), signed in with `qb auth login` (subscription) |

| # | Step (onboarding §) | Expected | Actual | Result |
|---|---|---|---|---|
| 1 | Prerequisites (§1) | git, Node 24, Docker, Ollama | Done in attempts 1–2 on this Codespace (PASS); this run resumed `--from 2` | PASS (earlier) |
| 2 | QB at the given SHA, `npm ci` | succeeds | HEAD 54c2f24; exit 0 | PASS |
| 3 | `ollama pull deepseek-r1:7b` | listed | listed | PASS |
| 4 | `qb auth login` | signed in, expiry shown | "signed in; access token expires 2026-10-12T23:01Z" | PASS |
| 5 | `qb doctor` | exit 0; memory ✓; agent-auth "validity not verified" | exit 0; memory 13.6 GiB available (11.1 needed) | PASS |
| 6 | demo repo + `qb doctor --repo` | repository ✓, test-runner ✓ node-test | exit 0 | PASS |
| 7 | demo run (reviewed contract) | authenticated agent call; checks pass; verdict pass; run id | `03e4e16e…` **VERIFIED**: the agent ran 45.5 s in the sandbox (src/utils.js +7/−1, test/utils.test.js +20/−1); AC-1…AC-4 ✓ by executable checks; 226 s total | PASS |
| 8 | `git -C qb-demo status --porcelain` | empty | empty | PASS |
| 9 | stop Docker → doctor → start → doctor → rerun | ✗ docker, then ✓; rerun completes | ✗ docker (exit 1), then ✓ (exit 0); rerun `7d882ad9…` **VERIFIED** | PASS |
| 10 | `qb runs`, `qb show`, `qb replay` | listed; replay reproduces | outcome=VERIFIED, reproduced | PASS |
| 11 | `qb patch --out`, apply to qb-demo, behaviour check | applies cleanly; `0 10 7` | patch exported ("verdict: pass; tests passed in sandbox"); `git apply --check` and `apply` clean; printed `0 10 7` | PASS |

**Known limitation (not an acceptance criterion).** The L2 context stage spends about 180 s per run on this CPU-only 4-core machine. That is the local model's per-call deadline; the run continues without an LLM-ranked context.

**Four attempts were needed.** Each failed attempt found a product bug on a genuinely fresh machine, and each was fixed test-first and verified before the next. They are recorded below.

| Attempt | Blocked by | Fix |
|---|---|---|
| 1 | The local model (~5.6 GiB) stayed resident, leaving 7.9 GiB at sandbox admission | QB unloads the local model before admission (`lib/model-release.js`, PR #7) |
| 2 | `qb auth login`/`status`/doctor reported "logged in" with no credential stored | Login, status and doctor require a stored credential; the kit stops at step 4 (PR #8) |
| 3 | The login volume was left root-owned on a fresh machine, so the credential could not be written | The agent image is built before the volume is prepared; ownership is fixed on every login (PR #9) |
| 4 | — | All steps pass |

## Steps (expected vs actual)

| # | Step (onboarding §) | Expected | Actual | Elapsed |
|---|---|---|---|---|
| 1 | Prerequisites (§1) | git, Node 24, Docker, Ollama installed; `docker` works without sudo after re-login | | |
| 2 | QB install at the given SHA, `npm ci` (§1) | succeeds | | |
| 3 | `ollama pull deepseek-r1:7b` (§1) | model listed by `ollama list` | | |
| 4 | `qb auth login` (§1) | signed in; `qb auth status` shows an expiry | | |
| 5 | `qb doctor` (§2) | exit 0; `memory` ✓; `agent-auth` "validity not verified" (!) | | |
| 6 | Demo repo + `qb doctor --repo qb-demo` (§3) | repository ✓, test-runner ✓ node-test | | |
| 7 | Demo run with the reviewed contract (§3) | authenticated agent call succeeds; checks lower/upper/in-range/at-bounds pass; verdict `pass`; run id printed | | |
| 8 | `git -C qb-demo status --porcelain` (§3) | empty: checkout unchanged | | |
| 9 | Docker stop → `qb doctor` → start → `qb doctor` → rerun (§4) | ✗ docker, then ✓; the rerun completes | | |
| 10 | `qb runs`, `qb show`, `qb replay` (§5) | run listed; replay reproduces the verdict | | |
| 11 | `qb patch … --out`, apply to qb-demo, behaviour check (§5) | applies cleanly; prints `0 10 7` | | |

**Run ids (attempt 4):** demo `03e4e16e-c8a3-464b-8855-dfeec81fe579`; rerun after recovery `7d882ad9-817e-4b9a-a987-134d6907bffb`.

## Documentation gaps found

Each gap, with the fix commit:
- **Memory.** The docs did not say how much RAM a sandboxed run needs. They now say a 16 GB minimum, and `qb doctor` checks free memory against the sandbox's admission gate (34c4779).
- **Ollama prerequisite.** The Ollama installer needs `zstd`, which a minimal Ubuntu 24.04 lacks. It is now a listed prerequisite (f13e2fa).
- **Sign-in.** The docs now say to paste the code into the terminal and press Enter, and to expect `signed in; access token expires …`. If it says `sign-in did not complete`, run it again (6a977bb).
- **No 16 GB VM.** The walkthrough now runs in a free GitHub Codespace, with a step-by-step guide (`docs/review/qb31-codespaces.md`).

## Redacted transcript

The per-step logs in each attempt's folder (`qb31-walkthrough/attempt-*/logs/`). The sign-in step is never recorded.

## Attempt 1 — 2026-10-12, GitHub Codespaces (owner run): BLOCKED, product fix made

**Raw record, unedited:** [`qb31-walkthrough/attempt-1-2026-10-12-codespaces/`](qb31-walkthrough/attempt-1-2026-10-12-codespaces/evidence.md), with its redacted logs.

**Setup:**
- Operator: the owner. Provider: GitHub Codespaces, 4-core.
- Ubuntu 24.04.3 x86_64, 15.6 GiB RAM, Node 24.21.0, Docker 29.8.2, Ollama 0.40.3.
- QB at `main` 8b3e582. Agent `claude-code@2.1.288`.

| Step | Result |
|---|---|
| 1–6: install, model, `qb auth login`, `qb doctor` (memory ✓ 13.5 GiB), demo repo | PASS |
| 7: demo run | **BLOCKED** `insufficient_host_resources` at sandbox admission. No agent call was made. |
| 8: demo checkout unchanged | PASS |
| 9: Docker stop → doctor ✗ docker → start | Docker restarted, but doctor then showed ✗ memory at 7.9 GiB, and the rerun was BLOCKED the same way |
| 10–11 | Inspected an earlier cancelled run (a kit bug, now fixed); no patch to export |

**Cause.**
1. Doctor measured 13.5 GiB free before any model call.
2. L2 then loaded `deepseek-r1:7b`, about 5.6 GiB on CPU, and Ollama keeps a model resident after use.
3. At admission only 7.9 GiB was free, against the 11.1 GiB the sandbox needs.

So on a 16 GB host, the local model and the sandbox didn't fit together. Nothing needs the model while the sandbox runs.

**Fix.**
- **Code:** QB now asks a *local* Ollama to unload the model just before admission and waits until it is gone (`lib/model-release.js`, called from `lib/sandbox/pipeline.js`). The result is recorded as `sandbox.model_release`.
- **Kit:** steps 10 and 11 now use the latest demo run.

**Next:** attempt 2 on the same setup after the fix is merged.

## Attempt 2 — 2026-10-12, same Codespace, `main` bac5956 (with the model release): BLOCKED at sign-in, product fix made

**Raw record:** [`qb31-walkthrough/attempt-2-2026-10-12-codespaces/`](qb31-walkthrough/attempt-2-2026-10-12-codespaces/evidence.md)

**The model release worked.** Both runs passed sandbox admission:
- doctor read 12.5 GiB free after the Docker restart;
- L3 now ran for 11 s, where it was 0.05 s before.

**New failure.** Both runs ended `BLOCKED auth_refresh_failed: pre-run refresh failed: Not logged in · Please run /login`. That is the first time a run reached the credential stage.

**What the evidence shows.**
- Earlier signs it was not signed in:
  - `qb auth login` exited 0;
  - `qb auth status` printed "logged in (expiry unknown)";
  - doctor showed "login volume present".
- In fact the QB login volume held **no stored credential**. "Expiry unknown" means `.credentials.json` was absent.
- Why the sign-in stored nothing isn't known: the sign-in step is deliberately not recorded.
- Ruled out by inspecting Claude Code 2.1.288:
  - it writes `.credentials.json` under `CLAUDE_CONFIG_DIR` (the volume);
  - its token exchange (`platform.claude.com/v1/oauth/token`) is on the AUTH allowlist.

**Fix (QB never reports a sign-in it doesn't have).**
- `qb auth login` fails with "sign-in did not complete: no credential was stored" unless a credential was stored.
- `qb auth status` says "not signed in: the QB login holds no stored credential".
- `qb doctor`'s `agent-auth` check requires a stored credential.
- The kit stops at step 4 with re-sign-in instructions instead of running blocked demos.
- Step 9 now requires the rerun to complete (attempt 2's step 9 was wrongly marked PASS while its rerun was BLOCKED).

### Attempt 3 — sign-in diagnosis (same Codespace, `main` 9341049)

**What happened.** The kit stopped at step 4 with the new check: "sign-in did not complete". A direct `qb auth login` then showed:
- the sign-in page and the code paste worked, ending in `Login successful.` (the browser terminal delivers a long paste in pieces, so the CLI first printed "Invalid code" for each partial piece);
- QB still found **no stored credential**.

**Cause.** Listing the QB login volume showed it was **empty and owned by `root:root`, mode 0755**. The login container runs as uid 10001, so it could not write `.credentials.json`.

Why the volume ended up root-owned:
1. On a fresh machine, `login()` created the volume and ran `chown 10001:10001` with the agent image **before building it**. The build happens later, in `authContainer`.
2. That `chown` failed, and its result was ignored.
3. Every later login skipped the `chown` because the volume already existed.

The volume was created at 04:32, during the very first sign-in on that fresh Codespace.

**Fix (`prepareAuthVolume`).**
- Build the agent image first.
- Check that the volume is created.
- Run the `chown` on **every** login. It is idempotent, so it also repairs a volume left root-owned by the old order.
- Stop the login with the reason if the `chown` fails.

**Verification.**
- 3 tests written first; all failed before the fix.
- With real Docker, a root-owned volume becomes `10001:10001` and writable by uid 10001.

## Senior review 10276 (2026-10-12): SENT BACK — unsupported test runners were not refused before model execution

**What the review accepted:** the walkthrough evidence above.

**Finding.** The card says unsupported agents *and runners* fail before model execution. Runners did not.
- `validateRunOptions` never consulted `testPlan`, and doctor only warned.
- My claim in comment 10275, that unsupported runners already failed early, was wrong.

**Reproduced first** with `qb.js --agent claude-code`, the model stubbed and the sandbox spied:

```
jest exit 2 model calls 1 agent launches 0 run records 1
mocha-config exit 2 model calls 1 agent launches 0 run records 1
```

**Fix.**
- `lib/run-options.js` now runs `testPlan(repo)` in the run preflight. `testPlan` reads `package.json` / `.quarterback.json` only and never executes repository scripts.
- Every agent run is refused with exit 2 and the runner named, for:
  - a detected unsupported runner;
  - a configured unsupported runner;
  - an invalid test config.
- `--agent dry-run` is the one stated exception: it only plans and verifies nothing.
- Doctor's `test-runner` check now fails for agent runs and warns for dry-run.
- `docs/support.md` and `docs/onboarding.md` are aligned.

**Regressions** (`test/unit/qb31-runner-gate.test.js`, 5 of 7 failing before the fix):
- detected Jest and a configured `.quarterback.json` mocha both give exit 2, the runner-specific error, **0 model calls, 0 agent launches** (`test/helpers/preload-sandbox-spy.js`) and **0 run records**;
- an invalid config is refused;
- the node:test control is not refused and reaches the model;
- the dry-run exception is tested explicitly.

## Senior re-review 10278 (2026-10-12): ACCEPTED at `f747418`

- **Verdict:** PASS. The runner preflight fix resolves the finding in 10276. Together with the attempt-4 walkthrough above, it satisfies QB-31's supported onboarding and adapter scope.
- **Reviewer's checks:**
  - `node --test test/unit/qb31-*.test.js` at the reviewed SHA: 74 passed.
  - Exact-SHA CI [run 38270867037](https://github.com/arshad8049/quaterback/actions/runs/38270867037), attempt 2: green. Attempt 1 failed on the disclosed OOM-classification flake, and the rerun passed.
- **Limits the review kept:**
  - No cross-platform qualification.
  - No QB-30 effectiveness claim.
  - The CPU context-stage timeout and the OOM flake remain.
- **Merged into `main`:** PR #16, merge commit `908adbd`, 2026-10-15.
