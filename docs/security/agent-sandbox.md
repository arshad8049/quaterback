# Execution sandbox: threat model and design (QB-02)

Status: **v2 DRAFT, resubmitted for review.** v1 was rejected; see §0.
Ticket: QB-02 (High, Phase 1). Review reference: p.10, Phase 1 exit gate p.23.
Platform claims are limited to **Linux x86_64 + Docker Engine** until §11 validation passes. macOS (Docker Desktop) is unsupported until it is validated separately.

---

## 0. Review response (v1 → v2)

### Decisions

| v1 decision | Reviewer ruling | v2 change | § |
|---|---|---|---|
| 1. API-key-only auth | Rejected | Authentication is separated from containment. Subscription login goes directly to the official binary and is stored in a QB-scoped credential volume. QB never reads or collects the token, and the user's `~/.claude` is never mounted. | §5 |
| 2. Docker runtime | Approved; Linux validated first | Explicit support matrix, pinned CI runner `ubuntu-24.04`, Docker Desktop tracked separately | §11 |
| 3. `tinyproxy:1.11` egress | Pattern approved, image not | The agent has **no network interface at all**. Egress goes only through a per-run proxy, reached over a Unix socket. The proxy image is selected by provenance, digest-pinned and ACL-tested. Telemetry is off. | §4 |
| 4. `node:20-slim` image | Rejected (EOL) | Supported Node LTS base, digest-pinned. Claude is pinned separately. Runtime identity and Claude version are recorded separately. | §7 |
| 5. Unsafe escape hatch | Not in beta CLI | Removed. Docker unavailable means a hard stop with an actionable error. The host-only fake-agent harness exists only in `test/` and cannot satisfy any gate. | §10 |

### Blocking changes

| Blocking change | v2 change | § |
|---|---|---|
| 1. All repo execution in containers | The host only orchestrates. Agent, dependency preparation, verification and capture each run in their own container. Nothing from the repository runs on the host. | §2, §3 |
| 2. Internal network ≠ host isolation | Agent and verifier containers use `--network none`. The proxy runs on its own per-run network, with destination-IP denial. Each item has an explicit test. | §4 |
| 3. Endpoint policy per auth mode | Four named policies (auth bootstrap, inference, dependencies, verification), minimised against the pinned Claude version | §4.3 |
| 4. Hostile output tree | Capture runs in a capture container with a trusted `GIT_DIR` and bounded traversal. The host only receives a size-capped patch. This also reopens QB-03 (see the finding below). | §6 |
| 5. Resources + cleanup | tmpfs-backed size-capped workspace volume, bounded logs, explicit OOM/timeout/cancel/infra states, labelled resources, crash reaper, in-container deadline backstop | §8 |
| 6. Dependency preparation | Separate dependency container: lockfile required, registry-only egress, no credentials, read-only result | §3.2 |
| 7. Checkout preservation + `qb apply` | A precise preservation definition. QB never writes to the user's `.git`. `qb apply` with baseline checks and atomic, recorded application. | §9 |

**New finding while revising (reopens QB-03).** `agent/capture.js` runs `git add` on the host using the workspace's own `.git/config`. I reproduced two attacks:

- An agent-written `core.fsmonitor` executes on the host.
- A clean-filter in `.git/config` plus a `.gitattributes` entry executes on the host.

The pre-review code had the same exposure through `git diff`. Both are seeded as `todo` tests in `test/unit/hostile-tree-seeds.test.js`. §6 fixes it.

**Other host-execution paths still in landed code:**

- `verify/checker.js` runs the repository's test command on the host (`npm test` etc.).
- `qb.js` still runs the agent directly in the user's checkout.

Both are closed by this ticket's implementation. Until then, QB must only be used on trusted repositories.

---

## 1. Threat model

### Assets

- **The user's checkout:** working files, index, refs and `.git/` (§9.1 defines preservation precisely).
- **The host:** filesystem, processes and network position, including LAN, cloud metadata and host services.
- **Credentials:**
  - the Claude login;
  - any other secret in the user's environment, which must never reach a container.
- **The Docker daemon:** access to it is root-equivalent on the host.
- **QB run records:** they must not be forgeable by repository code.
- **Other concurrent runs.**

### Adversary

Any code or content originating from the repository or the model is hostile, from the moment the workspace is created until the user applies a reviewed patch. That includes:

- files, `.git/` contents and attributes;
- package manifests and lifecycle scripts;
- test code;
- prompt-injected agent behaviour;
- anything the agent writes.

### Trusted

- QB's own code on the host.
- Pinned container images built by QB.
- The Docker daemon and kernel. A breakout through them is residual risk, §12.

### Security goals (Phase 1)

| Goal | Statement |
|---|---|
| G1 | No repository-originated code executes on the host. |
| G2 | Untrusted containers cannot reach the host, host services, the LAN, metadata endpoints or other runs. They can reach only the policy-listed endpoints. |
| G3 | Untrusted containers receive no host secrets. The Claude credential reaches only the agent container (§5). |
| G4 | The user's checkout is preserved (§9.1) on every success, failure and crash path. |
| G5 | Every run ends in a recorded terminal state, and leaves no running containers, networks, volumes or credential copies, including after QB itself crashes. |

**Non-goal for Phase 1:** trustworthy acceptance. The agent can still edit tests inside the workspace. Test tampering is an explicitly **unresolved correctness** issue for Phase 2 (QB-09/16), not a containment issue.

---

## 2. Execution topology

```
HOST — QB control plane (trusted). Never executes repository code;
        never runs git against a hostile .git.
 │
 │   docker run … (argv via lib/proc; labels qb.run=<id>)
 ▼
 per-run resources
 ┌──────────────────────────────────────────────────────────────────────┐
 │ vol  qb-<id>-work   tmpfs, size/inode-capped   (the workspace)       │
 │ vol  qb-<id>-deps   tmpfs, size-capped         (node_modules)        │
 │ vol  qb-<id>-sock   proxy Unix socket                                │
 │ net  qb-<id>-egress bridge, IPv6 off, proxy only                     │
 │                                                                      │
 │ ① seed      no net   in: base patch/tar on stdin  →  rw work         │
 │ ② deps      no net*  rw deps, ro work manifests, policy DEPS         │
 │ ③ agent     no net*  rw work, ro deps, cred (§5),  policy INFERENCE  │
 │ ④ verify    no net   ro-copy of work, ro deps,     no credentials    │
 │ ⑤ capture   no net   ro work, trusted GIT_DIR  →  bounded patch      │
 │ Ⓟ proxy     on qb-<id>-egress + socket volume; enforces policy       │
 └──────────────────────────────────────────────────────────────────────┘
   * "no net" = --network none. Egress exists only via the Unix socket to Ⓟ.
```

The containers run **one at a time**, and each must be confirmed stopped (`docker inspect` `State.Running=false`, exit code recorded) before the next starts or any output is read (§8.4).

---

## 3. Containers

Settings shared by every container:

| Setting | Value |
|---|---|
| User / privileges | `--user 10001:10001`, `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Filesystem | `--read-only` rootfs; `--tmpfs /tmp:rw,nosuid,nodev,size=256m` |
| Process limits | `--pids-limit`; `--memory` with `--memory-swap` equal to it (no swap) |
| Init + cleanup | `--init`, `--rm=false` (so QB can inspect the exit; removed explicitly afterwards) |
| Logs | `--log-driver local --log-opt max-size=… --log-opt max-file=1` |
| Never | `--privileged`, host network/PID/IPC/UTS namespaces, published ports, the Docker socket, any host bind mount, or `--add-host` |
| Environment | Constructed from an allowlist per container; nothing is inherited from QB's process |

### 3.1 Seed container ①

- Builds the workspace inside `qb-<id>-work` from a tar stream that QB produced on the host by **reading** the user's checkout. §9.2 describes how that read works without git writes.
- The workspace gets a fresh `.git` initialised by the trusted image, with the base commit and no remotes. The user's `.git` is never copied.

### 3.2 Dependency container ② (blocking change 6)

- **Input:** the repo's manifest and lockfile (read-only).
- **Lockfile required.** If `package-lock.json` (or the declared lockfile) is missing, the run ends `BLOCKED: setup_missing_lockfile`. It never falls back to an unlocked install.
- **Command:** a fixed argv per ecosystem, e.g. `npm ci`. Lifecycle scripts **do** run, contained here, with:
  - policy DEPS (registry only);
  - no credentials;
  - its own time, memory and disk limits.
- **Output:** a deps volume, mounted **read-only** at `/work/node_modules` in ③ and ④. The agent cannot change the installed dependency set. If it needs a new dependency, the run ends `UNRESOLVED: dependency_change_required` with that recorded; a later run can re-prepare.
- **Failure:** `ERROR: setup_failed`, with bounded logs. It is never reported as a verification result.
- **Platform:** Linux-native binaries are built in the container. Host `node_modules` (e.g. macOS native addons) are never used.

### 3.3 Agent container ③

- **Runs:** the pinned official Claude binary, non-interactive, with `--dangerously-skip-permissions`. That flag is acceptable only *because* of this boundary. The CLI refuses it as root, so uid 10001 is mandatory.
- **Credential:** per §5.
- **Network:** policy INFERENCE through the proxy (§4).
- **Environment:** `HOME=/tmp/home`, `CLAUDE_CONFIG_DIR` (per-run, §5), `HTTPS_PROXY=http://127.0.0.1:8888` (the in-container socket forwarder, §4.1), plus the telemetry/update settings in §4.3.

### 3.4 Verifier container ④ (blocking change 1)

- **Input:** a **fresh read-only copy** of the post-agent workspace (copied volume→volume inside a container) plus the read-only deps. The agent container is already gone.
- **Runs:** the test command as fixed argv from the runner adapter. It never comes from the agent or the model.
- **Restrictions:** `--network none`, no credentials, its own limits.
- **Output:** exit code, signal, OOM flag, duration, and bounded stdout/stderr. The host parses only those bounded strings.
- **Phase 2:** protected checks copied from the pinned base, and blocking on protected-path edits (QB-09/16).

### 3.5 Capture container ⑤

See §6.

---

## 4. Network isolation (blocking changes 2 and 3)

### 4.1 Mechanism

**Untrusted containers have no network.** ①②③④⑤ run with `--network none`, so their only interface is loopback. That removes the gateway, host services, LAN, cloud metadata, IPv4, IPv6, DNS and other runs at the kernel level, rather than relying on routing.

`HTTPS_PROXY` is a client hint, and malicious code can ignore it. It doesn't matter here, because there is no other way out.

**The only egress is a Unix socket:**

- The proxy container Ⓟ listens on a Unix socket in the per-run volume `qb-<id>-sock`.
- ② and ③ mount that volume.
- A trusted forwarder baked into the image bridges `127.0.0.1:8888` to the socket, because Claude Code needs a TCP proxy URL.
- Malicious code can bypass the forwarder and talk to the socket directly. It still reaches only Ⓟ, which enforces the policy.

**The proxy Ⓟ:**

- is the only container on a network: the per-run bridge `qb-<id>-egress`, with IPv6 disabled and created fresh per run (no cross-run reachability);
- resolves names itself;
- allows `CONNECT` only to policy hostnames on port 443;
- denies IP-literal targets;
- **after resolution**, denies destinations in:
  - `127.0.0.0/8`
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
  - `169.254.0.0/16` (incl. `169.254.169.254`)
  - `100.64.0.0/10`
  - `0.0.0.0/8`
  - `::1`, `fc00::/7`, `fe80::/10`
  - the docker bridge gateway

  This defends against DNS rebinding of allowed names to internal addresses.
- has no access to credentials, and does no TLS interception: it allowlists on the `CONNECT` host, not on decrypted content.

**DNS exfiltration:**

- Untrusted containers cannot resolve anything.
- The proxy resolves only names that already passed the hostname allowlist, so request-controlled names never reach a resolver.

### 4.2 Proxy image (decision 3)

| Criterion | Requirement |
|---|---|
| Maintenance | An actively maintained upstream with security advisories |
| Provenance | Official / verified-publisher image, digest-pinned. Signature or attestation verified at build time if the publisher provides one; otherwise documented as a gap. |
| Capability | `CONNECT` hostname allowlist, post-resolution destination-IP deny, IPv6 off, access log |

**Candidate:** Squid (Canonical-maintained `ubuntu/squid` on an LTS base). It supports `dstdomain` allowlists and post-resolution `dst` IP ACLs natively. A thin derived image adds the socket bridge.

**Alternative:** Envoy, using its dynamic forward proxy with a pipe listener. It has native Unix-socket listeners, but IP-range denial after DNS is harder.

The final pick depends on §11 test T-NET passing. No image is approved until then.

### 4.3 Endpoint policies (blocking change 3)

Hosts below are from Claude Code's network-requirements documentation. Each policy is **minimised empirically against the pinned Claude version**:

1. Run with deny-all plus proxy logging.
2. Add only hosts that are demonstrably required.
3. Record the final set in the image manifest.
4. Test that nothing else is reachable.

No wildcards.

| Policy | Used by | Allowed (candidate, to be minimised) |
|---|---|---|
| **AUTH_BOOTSTRAP** | §5 login container, user-initiated only | `platform.claude.com` (OAuth exchange); `api.anthropic.com` if the pinned version's first-run check requires it. The browser step happens on the host, with no container egress. |
| **INFERENCE (subscription)** | Agent ③ | `api.anthropic.com`; `platform.claude.com` (OAuth refresh) |
| **INFERENCE (API key)** | Agent ③ | `api.anthropic.com` |
| **DEPS** | Dependency ② | `registry.npmjs.org`, or a configured mirror; nothing else |
| **VERIFY** | Verifier ④, capture ⑤, seed ① | none (`--network none`, no socket mounted) |

**Agent container environment.** These turn off optional traffic, updates and unused features:

```
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
DISABLE_TELEMETRY=1
DISABLE_ERROR_REPORTING=1
ENABLE_CLAUDEAI_MCP_SERVERS=false
CLAUDE_CODE_DISABLE_ARTIFACT=1
```

Managed settings are baked into the image at `/etc/claude-code/managed-settings.json`. They disable plugins, MCP, WebFetch and WebSearch for v1, and their exact keys are validated against the pinned version.

Two hosts are **excluded by design**:

- `downloads.claude.ai`: updates are disabled.
- `registry.npmjs.org` in INFERENCE: plugins and MCP are disabled.

---

## 5. Authentication (decision 1)

Authentication and containment are separate concerns. QB supports two modes and never holds the credential in its own process.

### Mode S: subscription login (default)

**`qb auth login`** starts a one-off **auth container**:

- It uses the same pinned image and policy AUTH_BOOTSTRAP.
- It runs the official binary's own login flow in the user's terminal (paste-code flow; the browser opens on the host).
- The credential is written by Claude Code itself into `CLAUDE_CONFIG_DIR` on a **QB-scoped Docker volume**, `qb-claude-auth`.
- QB never reads, prints or transmits it, and never mounts the user's existing `~/.claude`.

**Per run:**

1. A trusted init step copies **only** `.credentials.json` from `qb-claude-auth` (mounted read-only) into a per-run config volume.
2. The agent ③ mounts **only** the per-run config.
3. After ③ stops, a trusted step copies back **only** a refreshed `.credentials.json`, and only if it validates (JSON shape, size ≤ 16 KiB, mode `0600`). This allows OAuth refresh to persist.
4. Everything else the agent wrote to its config directory is discarded. Settings, hooks, MCP config and history can therefore never persist into the next run.

**`qb auth logout`** runs the official `/logout` in an auth container, then removes the volume.

### Mode K: API key or long-lived token (opt-in)

- The user supplies `ANTHROPIC_API_KEY`, or a `CLAUDE_CODE_OAUTH_TOKEN` from the official `claude setup-token`.
- It comes from the environment variable they set for QB. QB does not prompt for it, store it or generate it.
- It is passed by an env file (mode `0600`, deleted at run end) to ③ only, and is redacted in the run record.

### Residual risk (both modes)

Code running inside the agent container can read the credential, and Claude Code's own documentation warns of this for bypass-mode containers. Limits on what an attacker can do with it:

- Egress is confined to the INFERENCE policy, so a stolen token can only be sent to Anthropic endpoints.
- The credential never reaches ②, ④ or ⑤.
- Recommendation: a dedicated account or workspace for QB use. To be stated in user docs.

---

## 6. Hostile output tree (blocking change 4; reopens QB-03)

After ③ stops, `qb-<id>-work` is hostile. The host never traverses it and never runs git against its `.git`.

### Capture container ⑤

- `--network none`, read-only mount of the work volume.
- Uses a **trusted `GIT_DIR`** that the seed step created outside the work volume, in a QB-owned volume.

### Capture steps

1. **Bounded pre-scan** (trusted scanner in the image):
   - `lstat` only; never follow symlinks.
   - Reject FIFOs, sockets, and device nodes.
   - Hard links: a regular file with `nlink>1` is recorded, and its content is captured by value only.
   - Caps on file count, total bytes, per-file bytes, path length and depth.
   - Exceeding any cap ends the run `UNRESOLVED: capture_limit_exceeded`, with the counts recorded.
   - Symlinks are captured as links (target text only). A symlink whose target is absolute or escapes the tree is captured but flagged, and blocks PASS.
2. **Git with no repository-controlled configuration:**
   - Environment: `GIT_DIR=<trusted>`, `GIT_WORK_TREE=/work`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`.
   - Flags: `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null`.
   - Run with `--no-ext-diff --no-textconv`.
   - The agent's `/work/.git` is excluded from the pathspec and treated as ordinary hostile data. It is neither read as config nor captured.
   - `.gitattributes` in the tree cannot invoke a program, because filter and diff drivers exist only in config, and the trusted config defines none.
3. **Output:** the patch, a `--name-status -z` list and the scan report go to stdout. The host reads at most `MAX_PATCH_BYTES`; overflow means `UNRESOLVED: patch_too_large`.

### Reproduced before the fix

Both of these executed on the host via the current `capture.snapshot()`:

- an agent-written `core.fsmonitor`;
- a clean-filter in `.git/config` with a `.gitattributes` entry.

They become the regression tests for this section; they are currently seeded as `todo`.

### Clarification on git hooks

A committed file cannot set `core.hooksPath`. The real risks are:

- (a) inherited system and global git config;
- (b) the agent writing `/work/.git/config` or `/work/.git/hooks/*`;
- (c) other git execution paths: fsmonitor, filters, `diff.external`, textconv, `core.sshCommand`, `core.pager`.

Disabling hooks on QB's own git calls does nothing for git commands the agent runs inside ③. That's acceptable, because those run contained. What matters is that **no git process on the host or in ⑤ consults agent-writable config**, which the trusted `GIT_DIR` plus null global/system config guarantees.

---

## 7. Images (decision 4)

### Agent image

- **Base:** a supported Node LTS, Debian slim, **digest-pinned**. Node 20 is EOL; the candidate is Node 24 LTS, chosen at implementation against the pinned Claude release's documented requirements.
- **Claude:** pinned to an exact version, installed either by `npm install -g @anthropic-ai/claude-code@X.Y.Z` with lockfile integrity, or by the native installer at a pinned version with its checksum verified.
- **Tools:** `git`, a minimal toolchain, the trusted socket forwarder and scanner, and the managed settings.

### Other images

| Image | Base / pin | Notes |
|---|---|---|
| verifier / deps / capture | Same base digest as the agent image | No Claude binary |
| proxy | Digest-pinned (§4.2) | |

### Recorded in every run manifest

- `runtime.image_digest`, `runtime.node_version`, `runtime.base_digest`
- `agent.claude_version` (from `claude --version` inside the image at build time)
- `proxy.image_digest`
- the policy hashes

The runtime/image identity and Claude's version are separate fields.

---

## 8. Resources, states and cleanup (blocking change 5)

### 8.1 Limits

| Resource | Bound |
|---|---|
| Workspace disk | `qb-<id>-work` is a `local` driver volume with `type=tmpfs,o=size=<N>,nr_inodes=<M>,uid=10001`. Writes beyond the cap fail with ENOSPC inside the container, never on the host disk. Cost: counts against host RAM, so the defaults are sized accordingly and the value is recorded. |
| Deps disk | Same mechanism, separate cap |
| Memory / CPU / PIDs | Per-container flags (§3); swap disabled |
| Logs | Docker `local` log driver, `max-size`; QB reads at most `MAX_LOG_BYTES` per stream and records truncation |
| Captured output | `MAX_PATCH_BYTES` (§6) |
| Time | Per-container wall clock from the host, plus an in-container backstop: the entrypoint runs the payload under `timeout -s KILL <deadline+grace>` as a child of `--init`. If QB dies, the container still terminates. |

### 8.2 Terminal states

These extend QB-22. Each records `exit_code`, `signal`, `oom_killed` and `duration`.

| State | Meaning |
|---|---|
| `completed` / `no_change` | Agent ended normally |
| `execution_error` | Nonzero exit |
| `timeout` | Host or backstop deadline hit |
| `oom` | `State.OOMKilled=true` |
| `cancelled` | User / SIGINT |
| `infra_error` | Docker daemon unavailable, image missing or digest mismatch, volume/network creation failure, proxy failed health check. Never reported as an agent or verification result. |
| `setup_failed` | Deps / seed failure |

### 8.3 Cleanup and crash recovery

- **Labels:** every container, volume and network gets `qb.run=<run_id>`, `qb.owner_pid`, `qb.created`.
- **Normal and failure paths:** `docker rm -f`, `docker network rm`, `docker volume rm` for that run, in a `finally`. The credential env file is deleted.
- **QB crash:**
  - The in-container backstop ends the payloads.
  - On the next start, the reaper (an extension of `run/store.reapAbandoned`) removes every `qb.run=*` resource whose run is terminal or whose owner PID is dead, and marks the run `ABANDONED`.
  - `qb doctor` lists any leftovers.
- `--rm` is not used. QB must inspect the stopped container first, and `--rm` does not kill a running container anyway.

### 8.4 Ordering guarantee

QB reads outputs (capture, logs, exit state) only after `docker inspect` reports `State.Running=false` and `State.Status=exited`. If the container is still running at the deadline, QB runs `docker kill` and waits for that state. If it never reaches it: `infra_error`.

---

## 9. User checkout and `qb apply` (blocking change 7)

### 9.1 Preservation: precise definition

QB **preserves the user's checkout**, meaning all of the following are identical before and after any QB run, on every path:

| Item | How it's compared |
|---|---|
| Working-tree file contents | Every path in `git ls-files -z --cached --others`, including ignored files: content hash |
| File type and executable bit | Each path |
| Symlink targets | Each symlink (target text) |
| Index | `git ls-files -s --debug` output; plus `.git/index` mtime/size |
| `HEAD`, all refs, packed-refs, stash, reflogs | Content |
| `.git/config`, `.git/hooks/`, `.git/info/` | Content |
| Objects | No new objects written (QB never runs a writing git command in the user's repo) |

Unrelated user edits *during* a run are the user's own and are not QB changes. The test harness distinguishes them by fingerprinting only between QB-controlled steps.

### 9.2 Reading the checkout

QB reads the checkout to seed the workspace, and **never writes**:

- `git ls-files -z --cached --others --exclude-standard`, run with `-c core.fsmonitor=false` and null global/system config, lists the paths. These are the user's own files, but no program is launched.
- QB then reads each file with `lstat` + bounded `read`, never following symlinks out of the tree, and streams a tar to the seed container.
- The current `capture.snapshot()` path, which writes objects through a temporary index, is **removed from the user-checkout path**.

### 9.3 `qb apply <run_id>`

The only way changes reach the checkout. It is never automatic.

1. **Load:** the run's patch, plus the **baseline**: per-path content hash, mode and type, recorded at seed time for every path the patch touches, plus `HEAD`.
2. **Validate paths**, refusing:
   - absolute paths, `..` segments, anything under `.git/`;
   - paths whose parent component in the *current* checkout is a symlink;
   - patch-created symlinks with absolute or escaping targets (unless `--allow-symlinks`, recorded);
   - submodule/gitlink entries.
3. **Detect drift:** for each touched path, the current content, mode and type must equal the baseline. Any mismatch is a conflict, and the command refuses and lists the conflicts. There are no silent overwrites. (A `--3way` option can come later.)
4. **Confirm:** show the diffstat and require an explicit `y`, or `--yes` for scripts.
5. **Apply atomically:** `git apply --check`, then `git apply` (all-or-nothing), with trusted config. It touches working-tree files only; the index changes only with `--index`.
6. **Record** an `apply.*` event in the run record: applied, refused-conflict (with paths) or failed (with git's message). Partial application is impossible by construction. If the process dies mid-apply, the event log shows `apply.started` without `apply.finished`, and `qb doctor` reports it.

---

## 10. Unavailable Docker / development harness (decision 5)

- **Docker missing, not running, version unsupported, or image digest mismatch:** `qb` exits non-zero with a specific message and the fix, e.g. "Start Docker Engine; `qb doctor` for details". The run is recorded as `BLOCKED: sandbox_unavailable`. There is no fallback.
- **The fake-agent harness** (`test/helpers/fake-agent.js` with `QB_AGENT_COMMAND`) is test-only:
  - It is not reachable from the supported CLI; `QB_AGENT_COMMAND` is honoured only when `NODE_ENV=test`, enforced in code.
  - It is marked `isolation: "none-test-only"` in manifests.
  - Its results cannot satisfy any gate.

---

## 11. Validation and support matrix

**Supported (after this suite passes):**

- Linux x86_64
- Docker Engine (minimum version fixed at validation)
- CI on `ubuntu-24.04`, pinned rather than `-latest`

Docker Desktop on macOS gets a separate job and is unsupported until it passes.

**Integration suite** (`QB_INTEGRATION=1`, real Docker, fixture payloads instead of Claude unless stated):

### T-NET (from inside ② or ③)

Each of these must fail:

- Connect to the host gateway, the host's LAN IP, `host.docker.internal`, `169.254.169.254`, a service listening on host loopback (via gateway), and an IPv6 target.
- Resolve any DNS name.
- Reach a second concurrent run's proxy.
- `CONNECT` to a non-allowlisted host, an IP literal, or an allowlisted name rebound to `10.x`.

These must succeed:

- Allowlisted host through the socket.

Inspect checks:

- No published ports, no host network/PID namespace, no Docker socket.

### T-FS

- Agent writes outside `/work` are confined to the container.
- The user-checkout fingerprint (§9.1) is identical after success, `execution_error`, `timeout`, `oom`, `cancelled`, and a QB SIGKILL mid-run.

### T-TREE (hostile output)

The agent leaves:

- `.git/config` with fsmonitor or a filter;
- an escaping symlink and an absolute symlink;
- a FIFO;
- a 10 GB sparse file;
- 10⁶ small files;
- a path with newlines or leading `-`.

Expected: no host execution, no hang, bounded time and memory, the correct `UNRESOLVED` reason, and `qb apply` refusing the escaping symlink.

### T-RES

Fork bomb, memory hog, disk fill, log flood, and sleeping past the deadline each produce the correct state, with no surviving containers, volumes or networks. After killing QB itself, the next start reaps everything.

### T-AUTH

- Mode S credential never present in ②④⑤ or on the host filesystem outside the volume.
- Mode K env file is removed.
- Agent-written config other than `.credentials.json` does not persist to the next run.

### T-POLICY

The pinned Claude version completes one fixture task under INFERENCE in each auth mode. The proxy log shows only the policy hosts.

---

## 12. Residual risk

- Kernel or container-runtime escapes. Keep the Docker Engine and kernel patched; optionally gVisor (`--runtime runsc`) later.
- Exfiltration through allowed endpoints:
  - the model API: prompt contents;
  - the npm registry during deps: request paths.
  Mitigated by the workspace containing only the repository, and by per-policy scoping.
- Credential theft within the agent container (§5).
- tmpfs-backed caps consume host RAM; the sizing trade-off is documented.
- Test tampering inside the workspace: Phase 2.

---

## 13. Decisions requested in this round

1. **Auth Mode S design (§5):** a QB-scoped credential volume, per-run copy, and validated write-back of `.credentials.json` only. Acceptable?
2. **Proxy candidate:** Squid (`ubuntu/squid`, derived image adding the socket bridge) as primary, Envoy as fallback, final choice contingent on T-NET.
3. **tmpfs-backed volumes** as the v1 disk bound (RAM cost), versus requiring an XFS/`pquota` host for `--storage-opt size`.
4. **Deps read-only mount:** agent-initiated dependency changes become `UNRESOLVED` in v1. Acceptable?
5. **Interim restriction:** until implementation lands, document "trusted repositories only" in the README and the CLI banner. Approve?
