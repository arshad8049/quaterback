# QB-31 fresh-machine walkthrough: evidence record

The acceptance evidence for QB-31: a person follows [docs/onboarding.md](../onboarding.md) on a clean machine, from install to artifact inspection, with one **real, authenticated** Claude Code task. Fake agents and CI smoke tests don't replace it (KAN-31 comment 10264).

**Never record credentials:** no tokens, keys, login URLs with codes, or `~/.qb` auth contents. Redact them in the transcript.

## Machine

A clean **Ubuntu 24.04 LTS x86_64** VM: no previous QB state, auth volume, cached project dependencies or prebuilt QB images.

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
| 5 | `qb doctor` (§2) | exit 0; `agent-auth` "validity not verified" (!) | | |
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
