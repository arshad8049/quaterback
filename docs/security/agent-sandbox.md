# Agent sandbox: threat model and design (QB-02)

Status: **DRAFT, needs senior review before implementation.**
Ticket: QB-02 (High, Phase 1, effort L). Review reference: p.10, Phase 1 exit gate p.23.

## 1. Problem

`agent/runner.js` runs `claude --print --dangerously-skip-permissions` with:

- the user's own checkout as its working directory,
- the full inherited environment, and
- unrestricted filesystem and network access.

Anything the agent decides to do, or is talked into doing by text in the repository (prompt injection in a README, a test fixture, an issue body), runs with the user's privileges. Repository scripts such as `npm test` and `postinstall` hooks run the same way.

What is already fixed:

- **QB-05:** the benchmark runs each arm in a disposable clone, so it no longer touches the source checkout.
- **QB-03:** change capture no longer depends on what the agent does with git.

Neither of these is containment. The agent process itself is still unconfined.

## 2. Assets

| Asset | Why it matters |
|---|---|
| User checkout + its `.git` | Source of truth; the review requires it to survive every success and failure path byte-for-byte |
| Host filesystem (`$HOME`, SSH keys, cloud creds, other repos) | Exfiltration or tampering |
| Credentials in env (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `CLOUDFLARE_*`, `GITHUB_TOKEN`, …) | Paid-API abuse, account takeover |
| Network | Exfiltration channel and malware download |
| Trusted checks / grader (Phase 2) | Changing them makes false approval possible |
| QB run records (`~/.qb/runs`) | Audit trail; must not be forgeable by the agent |

## 3. Adversaries and entry points

1. **Prompt injection** through repository content, task text or dependency READMEs.
2. **Malicious or compromised repository code**: test scripts, install hooks, git hooks (`.git/hooks` is not copied into the clone, but `core.hooksPath` in a committed config could be).
3. **A model error**: a well-meaning agent that runs `rm -rf`, `git push --force`, or edits the tests to make them pass.

Out of scope for v1: kernel or container-runtime escapes, and side channels. Mitigation for those is keeping the runtime patched; this is documented as residual risk.

## 4. Boundary (proposed)

```
 host (trusted control plane)                  container (untrusted)
 ─────────────────────────────                 ─────────────────────
 qb.js / bench/run.js                          claude --print …
   ├─ createWorkspace()  ──────────────►  /work   (bind mount, rw)  ← the ONLY host path
   ├─ snapshot() before                        HOME=/tmp/home (tmpfs)
   ├─ docker run … (argv via lib/proc)         rootfs read-only, tmpfs /tmp
   ├─ snapshot() after / diffTrees()           uid 10001, no capabilities
   ├─ verify() — trusted checks run            egress → proxy → api.anthropic.com only
   │   outside the agent container
   └─ run record ~/.qb/runs (never mounted)
```

### 4.1 Filesystem

- **Workspace only.** The agent sees only a disposable workspace, built by `lib/workspace.js`. For `qb.js` the workspace is built from a snapshot of the user's working tree, not just HEAD, so uncommitted work stays visible to the agent. `capture.snapshot()` already produces that tree.
- **User checkout is read-only to QB.** It is never the agent's cwd. The final patch is stored in the run record and offered back with `qb apply <run_id>`, so the human merge review stays in place.
- **Hardened container:**
  - `--read-only` rootfs
  - `--tmpfs /tmp:rw,noexec,nosuid,size=512m`
  - `HOME=/tmp/home`
  - nothing else is mounted
- **`.git` in the workspace** is the clone's own, with no remotes (already enforced by `createWorkspace`). Hooks are disabled with `-c core.hooksPath=/dev/null` for every git call QB makes.

### 4.2 Process

```
--user 10001:10001
--cap-drop ALL
--security-opt no-new-privileges
--pids-limit 256
--memory 2g
--cpus 2
```

- **Timeout:** wall-clock timeout enforced from the host (`docker kill`), not just `spawnSync`'s timeout. The container is `--rm`, and a timeout leaves no surviving children (Phase 3 exit gate).

### 4.3 Environment

- **Allowlist only:** `PATH`, `HOME`, `LANG`, `TERM=dumb`, plus the single agent credential (see 5.1).
- **Nothing else inherited.** `--env-file` is generated per run and redacted in the run record.

### 4.4 Network

- **Default deny:** `--network qb-agent-net`, an internal Docker network with no default route.
- **Egress proxy:** a sidecar proxy container (tinyproxy or squid) on that network, with an allowlist of `api.anthropic.com:443`. The agent gets `HTTPS_PROXY=http://qb-egress:8888`.
- **Proxy is mandatory.** Direct connections fail because the network is internal.
- **Package installs are not allowed** inside the agent container in v1. The workspace must already contain what the tests need, or the trusted verifier installs them outside the agent's container.

### 4.5 Trusted checks

- **Phase 1:** `verify()` runs tests in the workspace after the agent exits. The agent can still edit tests in the workspace, which is acceptable for Phase 1.
- **Phase 2 (QB-09/16):**
  - The protected verifier copies trusted check files from the pinned base, not from the agent's tree.
  - It runs them in a **second** container with no network and no credentials.
  - Edits to protected paths block PASS.

## 5. Decisions needed from the reviewer

1. **Agent authentication inside the container.** Options:
   - (a) `ANTHROPIC_API_KEY` env var only. Simplest, and it's the only secret the container sees.
   - (b) Mount `~/.claude` credentials read-only. This keeps subscription auth, but exposes the whole credentials directory.

   **Proposal: (a)** for the beta; (b) is not supported.
2. **Docker as the v1 runtime** on macOS (Docker Desktop VM) and Linux. Rootless Podman is a later adapter. The review's target is "one verified Linux sandbox profile", so the CI integration job runs on ubuntu-latest.
3. **Egress proxy image and pinning** (tinyproxy:1.11 digest-pinned?). Does the allowlist need `statsig.anthropic.com` / `sentry.io` for Claude Code telemetry? Proposal: no; set `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`.
4. **Agent image:** `node:20-slim` + `@anthropic-ai/claude-code@<pinned>`, built locally from `agent/sandbox/Dockerfile`, with the image digest recorded in the run manifest (`agent.version`).
5. **Unsafe escape hatch:** `--unsafe-no-container`, which runs in the disposable workspace on the host with the env allowlist. This is for development only, prints a warning, and is recorded as `isolation: "workspace-only"` in the manifest. Should it exist at all?

## 6. Tests (Phase 1 exit gate)

Integration tests, `QB_INTEGRATION=1`, require Docker. Each runs a fixture "agent" script inside the real container image:

| Fixture | Expected |
|---|---|
| Write `$HOME/qb-escape` and `/work/../escape` | No file appears on the host; the attempt is recorded |
| `curl https://example.com` | Connection refused / proxy 403 |
| `curl https://api.anthropic.com` | Reachable through proxy |
| Read `/proc/1/environ`, `env` | Only allowlisted vars present |
| Modify the user checkout path (passed in the prompt) | Path does not exist in container; checkout fingerprint unchanged |
| Fork bomb / sleep past timeout | Container killed, status `timeout`, no surviving processes |

Unit tests run without Docker. They use a `docker` shim on `PATH` that records argv, and assert:

- no host mounts other than the workspace
- `--cap-drop ALL`, `--read-only`, internal network
- the env allowlist

## 7. Residual risk after this ticket

- **Container escape** through a kernel or runtime vulnerability.
- **The model API as an exfiltration channel.** The agent can encode workspace contents in prompts it sends to the allowed endpoint. Mitigated only by the workspace containing nothing beyond the repository.
- **Test tampering inside the workspace** until Phase 2's protected verifier.
