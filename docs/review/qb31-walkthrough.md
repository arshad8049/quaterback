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

**Run ids:**

## Documentation gaps found

Each gap, with the fix commit:

## Redacted transcript

(attached or linked)

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
