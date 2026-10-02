# Execution sandbox: threat model and design (QB-02)

Status: **v3.1: approved as the working design for experiments E1–E4 and incremental implementation. EXPERIMENTAL; not final; the sandbox is not shipped.** ([v2 review](reviews/agent-sandbox-v2-review.md), [v3 review](reviews/agent-sandbox-v3-review.md).) Every claim that depends on Docker/kernel behaviour not yet observed is gated on an experiment in §11.1 and marked **[gated: En]**. QB-02 is complete only when E1–E4 pass, their results are folded in here, and the implementation passes §11.2. v3.1 applies the eight targeted corrections from the v3 review (§0.1).
Ticket: QB-02 (High, Phase 1). Review reference: p.10, Phase 1 exit gate p.23.
Platform claims are limited to **Linux x86_64 + Docker Engine** until §11 validation passes. macOS (Docker Desktop) is unsupported until it is validated separately.

---

## 0. Review response (v2 → v3)

### Decisions

| Question | Ruling | v3 change | § |
|---|---|---|---|
| 1. Credential volume + write-back | Write-back rejected; direct login and per-run copies approved in principle | **No write-back.** Agent-run auth state is always discarded. The persistent credential changes only through the official binary in a clean auth container that has no repository code and no work volume. That includes a pre-run refresh. **[gated: E1]** | §5 |
| 2. Squid primary, Envoy fallback | Squid approved for a PoC; one proxy only | Squid only; Envoy work is dropped. Exact-host ACLs. The IP that is checked is the IP that is connected to. Consumers mount the socket read-only. **E3 passed with Squid alone (2026-10-02).** | §4 |
| 3. tmpfs-backed volumes | Conditional, small Linux beta | Lifecycle experiment E2 before any code. Every volume is budgeted. Host-level admission limit. Mount lifetime and swap behaviour are stated. | §8.1, §8.2 |
| 4. Read-only deps | Approved as a v1 limitation | Mechanical dependency fingerprint, checked before verification. Explicit supported project profile. Writable dependency build layout. | §3.2 |
| 5. "Trusted repositories only" | Insufficient alone | Warning text now says execution is **uncontained and runs with the user's privileges**. The current host-execution paths are excluded from the supported beta. | §10 |

### Required revisions

| Review item | v3 change | § |
|---|---|---|
| 1. Write-back crosses the trust boundary | Removed. The "QB never holds the credential" claim is corrected for Mode K. The authentication-obligations check is a beta blocker. | §5 |
| 2. Timeout backstop is not adversary-proof | Deadlines and the CLI-loss lease are enforced by a **detached host supervisor** outside every container. The in-container `timeout` is kept only as a convenience. G5 is rewritten with explicit bounds. | §1, §8.3 |
| 3. tmpfs lifecycle | Experiment E2 (the reviewer's exact steps) **ran 2026-10-02: keeper required**. Aggregate storage budget plus admission control, and a stage memory sizing rule from E2. | §8.1, §8.2, §11.1 |
| 4. "Partial application is impossible" | Removed. **`qb apply` is deferred.** v1 exports a patch plus a read-only preflight, and the user applies it manually. `--allow-symlinks` is removed; escaping symlinks are never exported. | §9.3 |
| 5. Deps consistency gate | Fingerprint of manifest, lockfile, package-manager version, runtime/platform and install options. Mismatch → `UNRESOLVED: dependency_change_required`, verification not run. | §3.2 |
| 6. Verifier scratch | Capture runs **before** verification. The verifier gets a disposable writable checkout of the captured tree, and its outputs are never captured. | §2, §3.5 |
| 7. Networking claims | "No external network interface." "Untrusted workload stages run sequentially; trusted support services may overlap." CONNECT allowlist limits destinations, not operations. Output channels added to credential residual risk. | §2, §4, §5.4, §12 |
| 8. Capture and output handling | Directory-relative no-follow traversal with identity checks. Streams are drained while running into bounded buffers. The patch travels via an output volume, not logs. Raw-content fidelity fixtures. The test hook moves out of the shipped CLI. | §6, §8.5, §9.2, §10 |

### Corrections to v2 statements

- **"QB never holds the credential in its own process"** was false for Mode K. Corrected in §5.3.
- **"`QB_AGENT_COMMAND` is honoured only when `NODE_ENV=test`, enforced in code"** was false twice over:
  - The landed `agent/runner.js:51` honours `QB_AGENT_COMMAND` unconditionally.
  - `NODE_ENV` is user-settable, so it could never have made the hook unreachable.

  §10 replaces it.
- **"No network interface"** was wrong. `--network none` leaves loopback.
- **"Containers run one at a time"** was wrong. The proxy (and the keeper, if E2 needs one) run alongside workloads.

### 0.1 v3 review: rulings and v3.1 corrections

| Decision (§13) | Ruling | Where it's reflected |
|---|---|---|
| Auth model | Approved for E1. The lock covers refresh **and** copy; login and logout take the same lock. Mode S is still conditional on E1 and §5.5. | §5.1, §5.2 |
| Supervisor | Detached host process approved. Docker access stays in the host control plane. Readiness handshake, bounded Docker commands, recovery after supervisor failure. | §8.3 |
| Defer `qb apply` | Confirmed | §9.3 |
| Project profile | Approved for a narrow beta, plus a lifecycle-script limitation | §3.2 |
| Capture before verify | Confirmed. The authoritative tree is inaccessible to test processes. | §2, §3.5 |
| Native helper | Approved, **Rust**. Narrow I/O protocol, isolated syscall handling, adversarial filesystem tests. | §6, §9.2 |

| Correction | v3.1 change | § |
|---|---|---|
| 1. `O_PATH` fds can't be `read()` | Three fd kinds: directory, symlink, and regular file reopened for reading. Same-inode in-place edits are detected separately. No global-snapshot claim. | §6, §9.2 |
| 2. Deletions and ignored files | Fresh candidate index built from the complete approved tree. `.gitignore` never hides files from capture. New fidelity cases. | §6, §11.2 |
| 3. Absolute credential claims | Mode K wording narrowed. Stage provisioning is stated as intent, and copied secrets are acknowledged. T-AUTH plants a fake credential. | §5.3, §5.4, §11.2 |
| 4. Supervisor protocol | Readiness ack, immutable stage deadlines, atomic leases, monotonic time, start-identity ownership, Docker timeouts, a single terminal-state writer. One G5a bound. No different-uid claim. | §1, §8.3, §11.1 |
| 5. Admission | Reservations under a lock. Scope is per installation. Beta: one run per installation. | §8.1 |
| 6. Lifecycle-script limitation | Projects whose install reads mutable source or writes outside `node_modules` are excluded, detected, and covered by a fixture | §3.2 |
| 7. Export must not harm the checkout | Default artifact dir, no overwrite, no following destination symlinks, diagnostics on stderr, honest status label, safe recovery advice | §9.3 |
| 8. DNS fallback contradiction | The fallback rejects the whole answer set if any answer is denied | §4.1 |

### Still open from v2 (QB-03)

`agent/capture.js` runs `git add` on the host using the workspace's own `.git/config`. Two attacks were reproduced against it: an agent-written `core.fsmonitor`, and a clean-filter plus `.gitattributes`. They are executable reproductions in `test/unit/hostile-tree-seeds.test.js` and are reported as **demonstrated defects**, not passing regressions. They become passing security regressions only when the §6 capture replaces `agent/capture.js`, and **QB-03 cannot close before then** (§11.2 T-TREE).

**Host-execution paths still in landed code.** The supported beta release contains none of these (§10):

- `qb.js` runs the agent directly in the user's checkout.
- `verify/checker.js` runs the repository's test command on the host.
- `agent/capture.js` runs git against the hostile workspace on the host.

---

## 1. Threat model

### Assets

- **The user's checkout:** working files, index, refs and `.git/` (§9.1 defines preservation precisely).
- **The host:** filesystem, processes, memory and network position, including LAN, cloud metadata and host services.
- **Credentials:**
  - the Claude login (Mode S) or API key/token (Mode K);
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
- anything the agent writes, including logs and generated files.

Inside an untrusted container the adversary has full control of every process running as uid 10001. That includes any supervisor running there under the same uid.

### Trusted

- QB's own code on the host, including the detached supervisor (§8.3).
- Pinned container images built by QB, and the trusted helpers in them, *when no untrusted process shares their container*.
- The Docker daemon and kernel. A breakout through them is residual risk, §12.

### Security goals (Phase 1)

| Goal | Statement |
|---|---|
| G1 | No repository-originated code executes on the host. |
| G2 | Untrusted containers have no external network interface. Their only egress is the per-run proxy, which connects only to policy-listed hostnames at public addresses. |
| G3 | QB provisions no host secrets to untrusted containers, and provisions the Claude credential only to the agent container (§5). Files the agent produces may contain copied secrets; detection is best-effort (§5.4). Nothing an agent run writes ever becomes persistent authentication state. |
| G4 | The user's checkout is preserved (§9.1) on every success, failure and crash path. |
| G5 | See below. |

**G5, lifecycle bounds:**

| | Bound |
|---|---|
| **G5a: termination** | While the supervisor and Docker daemon are running, a `docker kill` is issued to every workload container of a run no later than `T_end + KILL_GRACE`, and the containers are confirmed stopped within a further `DOCKER_OP_TIMEOUT`. `T_end` is the **earlier of** the stage deadline and the last lease renewal + `LEASE_TIMEOUT`. Defaults: `KILL_GRACE` 10 s, `LEASE_TIMEOUT` 30 s, `DOCKER_OP_TIMEOUT` 30 s. This is the one bound E4 and T-LIFE test. Nothing inside a container can extend it, and lease renewal cannot extend a stage deadline (§8.3). |
| **G5b: removal** | Stopped containers, the per-run network and all per-run volumes are removed by the supervisor as soon as the run is terminal. If the supervisor is not running, removal is **eventual**: at the next `qb` start, or by `qb doctor --reap`. |
| **G5c: Docker unavailable** | Nothing can be killed or removed. The supervisor retries with backoff and records `infra_error`. Under daemon `live-restore`, workloads can keep running until the daemon returns; QB warns at start if `live-restore` is enabled (§12). |
| **G5d: intentionally retained** | The `qb-claude-auth` volume (until `qb auth logout`), QB images, and run records under `run/`. Nothing else. |
| **G5e: recorded end** | Every run ends in a recorded terminal state. A run found by the reaper with no terminal state is marked `ABANDONED`. |

**Non-goal for Phase 1:** trustworthy acceptance. The agent can still edit tests inside the workspace. Test tampering is an explicitly **unresolved correctness** issue for Phase 2 (QB-09/16), not a containment issue.

---

## 2. Execution topology

```
HOST — QB CLI (trusted) ──spawns──► qb-supervisor (trusted, detached; §8.3)
        Never executes repository code; never runs git against a hostile .git.
 │
 │   docker run … (argv via lib/proc; labels qb.run=<id>)
 ▼
 per-run resources (all labelled; budgeted in §8.1)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ vol qb-<id>-work    tmpfs   workspace (candidate)                        │
 │ vol qb-<id>-deps    tmpfs   node_modules                                 │
 │ vol qb-<id>-git     tmpfs   trusted GIT_DIR (base + captured tree)       │
 │ vol qb-<id>-verify  tmpfs   disposable writable verification checkout    │
 │ vol qb-<id>-out     tmpfs   patch + capture manifest                     │
 │ vol qb-<id>-cred    tmpfs   per-run credential copy (Mode S)             │
 │ vol qb-<id>-sock    tmpfs   proxy Unix socket                            │
 │ net qb-<id>-egress  bridge  IPv6 off; proxy only                         │
 │                                                                          │
 │ untrusted workload stages — strictly sequential                          │
 │ ① seed     no ext. net  stdin tar → rw work, rw git                      │
 │ ② deps     no ext. net* scratch src copy → rw deps          policy DEPS  │
 │ ③ agent    no ext. net* rw work, ro deps, cred        policy INFERENCE   │
 │ ④ capture  no ext. net  ro work, rw git → rw out, rw verify (checkout)   │
 │ ⑤ verify   no ext. net  rw verify, ro deps only; no git/out/work; no creds│
 │                                                                          │
 │ trusted support services — may overlap workload stages                   │
 │ Ⓟ proxy    on qb-<id>-egress; rw sock; enforces policy (during ②, ③)     │
 │ Ⓚ keeper   required (E2); holds every tmpfs volume mounted (§8.2)       │
 └──────────────────────────────────────────────────────────────────────────┘
   "no ext. net" = --network none: loopback only.
   * Egress only via the read-only-mounted Unix socket to Ⓟ.
```

① and ④ are trusted code (QB image, fixed argv), but they handle hostile data, so they get the same hardening as the untrusted stages.

**Ordering.** Untrusted workload stages run sequentially; trusted support services may overlap. Each workload must be confirmed stopped (`docker inspect`: `State.Running=false`, `State.Status=exited`, exit code recorded) before the next one starts, and before any of its evidence is finalized (§8.5).

**Why capture comes before verify.** It fixes the candidate as a git tree id. Verification then runs against a fresh checkout of exactly that tree, so:

- the evidence names the snapshot it tested;
- files generated during verification are never captured into the patch.

---

## 3. Containers

Settings shared by every container:

| Setting | Value |
|---|---|
| User / privileges | `--user 10001:10001`, `--cap-drop ALL`, `--security-opt no-new-privileges` |
| Filesystem | `--read-only` rootfs; `--tmpfs /tmp:rw,nosuid,nodev,size=256m` |
| Process limits | `--pids-limit`; `--memory` with `--memory-swap` equal to it (no container swap; host swap of tmpfs pages: §8.2) |
| Init + cleanup | `--init`; `--restart no`; no `--rm` (QB inspects the exit first, then removes it) |
| Logs | `--log-driver local --log-opt max-size=… --log-opt max-file=1`. Diagnostic only, never an evidence transport (§8.5). |
| Never | `--privileged`, host network/PID/IPC/UTS namespaces, published ports, the Docker socket, any host bind mount, or `--add-host` |
| Environment | Built from an allowlist per container. Nothing is inherited from QB's process. |

### 3.1 Seed ①

- Builds the workspace inside `qb-<id>-work` from a tar stream that QB produced on the host by **reading** the user's checkout (§9.2).
- Initialises a trusted `GIT_DIR` in `qb-<id>-git`, outside the work volume, containing the base tree and no remotes. The user's `.git` is never copied.
- Records the **baseline** (§9.3) and the **dependency fingerprint** of the base (§3.2).

### 3.2 Dependencies ②

**Supported project profile (v1).** Anything outside it stops with `BLOCKED: setup_unsupported_project`, naming the unsupported feature and what to change:

- a single npm package at the repository root, with `package-lock.json` lockfileVersion 2 or 3;
- no npm workspaces, and no `file:`, `link:` or git-URL dependencies;
- install scripts and native builds are allowed, contained here, **subject to the lifecycle-script limitation below**.

**Lifecycle-script limitation (v1).** ② keeps only `node_modules`. The fingerprint covers manifests, not application source. So v1 **excludes** projects whose install:

- **writes outputs outside `node_modules`** (e.g. a root `postinstall` that generates `src/generated/…`), because those outputs would be discarded; or
- **reads mutable application source** (e.g. a root `prepare` that builds from `src/`), because the agent could change that source without changing the manifests, leaving stale dependency artifacts behind a matching fingerprint.

Detection is mechanical, not a promise about what scripts do:

- **Root scripts.** If the root `package.json` defines any of `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare` or `postprepare`, the run ends `BLOCKED: setup_unsupported_project (root lifecycle script)`.
- **Dependency scripts.** These still run, and nothing stops them reading the project's source. A dependency whose build output depends on the consumer's source is not detected. That is a documented residual of the v1 profile (§12). Writes are caught by the next check.
- **Outputs outside `node_modules`.** After `npm ci`, ② compares the scratch source copy with the seeded tree. Any created, changed or deleted path outside `node_modules` ends the run `BLOCKED: setup_unsupported_project (install modified the project tree)`, with the paths listed.

A controlled rebuild step, which would rerun the install against the candidate source before ⑤, is deferred. It would need its own design.

If the lockfile is missing, the run ends `BLOCKED: setup_missing_lockfile`. There is never an unlocked install.

**Layout.**

- ② gets a **disposable writable copy of the whole seeded source tree**, so root lifecycle scripts and native builds can read and write the project.
- It runs a fixed argv: `npm ci`, with fixed flags.
- Only the resulting `node_modules` is moved into `qb-<id>-deps`, and the scratch copy is discarded.
- Policy DEPS (registry only), no credentials, and its own time, memory and disk limits.
- Linux-native binaries are built here. Host `node_modules` are never used.

**Dependency fingerprint.** A SHA-256 over a canonical record of:

- the bytes of `package.json` and `package-lock.json`, plus `.npmrc` if present;
- the npm and Node versions;
- `process.platform`, `process.arch` and libc;
- the exact install argv and environment variables that affect the dependency tree.

It is computed in ① for the base and in ④ for the candidate.

**Gate.** If the candidate fingerprint differs from the one the deps were built from, the run ends `UNRESOLVED: dependency_change_required`:

- ⑤ is **not run**, because tests against the old dependency set would not verify the candidate;
- the changed inputs are listed;
- a later run can re-prepare from the new manifests.

**Mounting.** The deps volume is mounted **read-only** at `node_modules` in ③ and ⑤.

**Failure.** `setup_failed`, with bounded logs. It is never reported as a verification result.

### 3.3 Agent ③

- **Runs:** the pinned official Claude binary, non-interactive, with `--dangerously-skip-permissions`. That flag is acceptable only *because* of this boundary. The CLI refuses it as root, so uid 10001 is mandatory.
- **Credential:** per §5.
- **Network:** policy INFERENCE through the proxy (§4).
- **Environment:** `HOME=/tmp/home`, `CLAUDE_CONFIG_DIR` (per-run, §5), `HTTPS_PROXY=http://127.0.0.1:8888` (the in-container socket forwarder, §4.1), plus the settings in §4.3.

### 3.4 Capture ④

See §6.

### 3.5 Verify ⑤

- **Input:** a **disposable writable checkout** of the captured candidate tree, plus the read-only deps.
  - The checkout is materialised into `qb-<id>-verify` as the last step of ④, a trusted step with the attribute handling of §6, before any test process exists.
  - Build output, coverage, caches and generated files are written into this copy.
  - ⑤ mounts **only** `qb-<id>-verify` and the deps. `qb-<id>-git`, `qb-<id>-out` and `qb-<id>-work` are not mounted, so test processes cannot reach the authoritative candidate tree, the patch, or the agent's workspace. The candidate is immutable from here.
  - Nothing in `qb-<id>-verify` is ever captured or delivered.
- **Runs:** the test command as a fixed argv from the runner adapter. It never comes from the agent or the model.
- **Restrictions:** `--network none`, no credentials, its own limits.
- **Evidence:**
  - candidate tree id and dependency fingerprint;
  - exit code, signal, OOM flag, duration;
  - bounded stdout/stderr (§8.5).
- **Phase 2:** protected checks copied from the pinned base, and blocking on protected-path edits (QB-09/16).

---

## 4. Network isolation

### 4.1 Mechanism

**Untrusted containers have no external network interface.** Every workload runs with `--network none`, so its only interface is loopback. That removes, at the kernel level rather than by routing:

- the gateway, host services and the LAN;
- cloud metadata endpoints;
- external IPv4 and IPv6, and DNS;
- other runs.

`HTTPS_PROXY` is a client hint, and malicious code can ignore it. There is no other way out.

**The only egress is a Unix socket:**

- Ⓟ listens on a Unix socket in `qb-<id>-sock`, which it mounts read-write.
- ② and ③ mount that volume **read-only**, so they cannot unlink or replace the socket entry. Connecting to a socket does not need a writable filesystem; E3 confirms this on the pinned kernel/Docker.
- A trusted forwarder baked into the image bridges `127.0.0.1:8888` to the socket, because Claude Code needs a TCP proxy URL.
- Malicious code can bypass or kill the forwarder and talk to the socket directly. It still reaches only Ⓟ.

**Ⓟ (Squid, single implementation):**

- is the only container on a network: a fresh per-run bridge `qb-<id>-egress`, IPv6 disabled, with no cross-run reachability;
- allows `CONNECT` only to policy hostnames on port 443, using **exact** hostname match (`dstdomain` entries without a leading dot; no wildcards, no subdomains);
- denies IP-literal targets;
- denies any destination address in:
  - `127.0.0.0/8`
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`
  - `169.254.0.0/16`
  - `100.64.0.0/10`
  - `0.0.0.0/8`
  - `::1`, `fc00::/7`, `fe80::/10`
  - the docker bridge gateway
- has no access to credentials.

**The checked IP must be the connected IP.** E3 result: Squid alone satisfies (1)–(3); the resolver contingency is not needed. See the E3 result in §11.1.

Squid can resolve a name more than once, use a cached answer, or try further addresses after a failed connect. So an ACL check on "the destination" is not, by itself, proof that the socket went to a checked address. Requirements:

1. If **any** answer for an allowlisted name is in a denied range, the request is refused, and no fallback to other answers happens.
2. Retries and multi-answer failover connect only to addresses that passed the check.
3. If E3 shows Squid cannot guarantee (1) and (2) on its own, Ⓟ gets a trusted local filtering resolver as its only resolver. It applies **the same policy as (1)**: if any A/AAAA answer for a name is in a denied range, it returns **no addresses** for that name (SERVFAIL/empty), not the remaining public ones. It forwards only the allowlisted names. Squid's own `dst` ACL stays as a second layer. This is a contingency inside Ⓟ, not a second proxy.
   - Unbound's `private-address:` strips denied answers but keeps the rest, which is a different policy. So the resolver is either a small module or a script layered on it that rejects the whole set, or a purpose-built filter. E3 tests whichever is chosen against the mixed-answer case.

**Invariant:** every destination Ⓟ actually connects to satisfies the policy. (1)–(3) are the mechanisms; E3 and T-NET test the invariant directly, by observing the connect addresses.

**DNS exfiltration:**

- Untrusted containers cannot resolve anything.
- Ⓟ resolves only names that already passed the exact-host allowlist, so names chosen by a request never reach a resolver.

**What the allowlist does not do.** Ⓟ does no TLS interception. A CONNECT allowlist restricts **destinations** only. It does not restrict which API operations are called, and it does not show that the traffic is legitimate Claude inference. Code in ③ holding the credential can make any API call the credential allows, to the allowed hosts (§5.4).

### 4.2 Proxy image

| Criterion | Requirement |
|---|---|
| Maintenance | An actively maintained upstream with security advisories |
| Provenance | `ubuntu/squid` (Canonical) on an LTS base, digest-pinned. Signature or attestation verified at build time if published; otherwise documented as a gap. |
| Derived image | Adds only the Unix-socket listener bridge, the ACL config and, if E3 requires it, the filtering resolver |
| Limits | `--memory`, `--pids-limit`, connection and request-size limits, bounded access log |

Envoy is no longer an alternative in this round. If Squid fails E3 even with the resolver contingency, the proxy choice goes back to review.

**E3 validated** `ubuntu/squid` (Squid 6.13) with the derived socket bridge, hardened as follows:

- `--cap-drop ALL` plus only `SETUID`/`SETGID`, so Squid can drop to its `proxy` user;
- `no-new-privileges`, read-only root, `/tmp` tmpfs;
- 256 MiB memory and a pids limit.

Implementation notes from E3:

- **Logs:** Squid running as `proxy` cannot open `/dev/stdout`, so the entrypoint pre-creates its log files in `/tmp` and streams them.
- **ICMP:** the pinger needs raw ICMP sockets, so it is disabled (`pinger_enable off`).
- **Pinning:** the implementation must digest-pin the base. The E3 run recorded the Squid version but not the digest; the script has since been fixed to record it.

### 4.3 Endpoint policies

Hosts below are from Claude Code's network-requirements documentation. Each policy is **minimised empirically against the pinned Claude version**:

1. Run with deny-all plus proxy logging.
2. Add only hosts that are demonstrably required.
3. Record the final set in the image manifest.
4. Test that nothing else is reachable.

| Policy | Used by | Allowed (candidate, to be minimised) |
|---|---|---|
| **AUTH** | §5 auth container only (login, pre-run refresh, logout). Never with a work volume. | `platform.claude.com`; `api.anthropic.com` if the pinned version requires it. The browser step happens on the host. |
| **INFERENCE (Mode S)** | Agent ③ | `api.anthropic.com`. `platform.claude.com` is **excluded** if E1 shows the pre-run refresh model works, so in-run refresh is impossible (§5.2). |
| **INFERENCE (Mode K)** | Agent ③ | `api.anthropic.com` |
| **DEPS** | Deps ② | `registry.npmjs.org`, or one configured mirror; nothing else |
| **NONE** | ①, ④, ⑤ | `--network none`, no socket mounted |

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

---

## 5. Authentication

Authentication and containment are separate concerns. The rule:

> **Nothing written during an agent run can become persistent authentication state.**

### 5.1 Mode S: subscription login (default)

**`qb auth login`** starts a one-off **auth container**:

- the same pinned image, policy AUTH, the persistent volume `qb-claude-auth` mounted read-write as `CLAUDE_CONFIG_DIR`;
- **no** work, deps or repository volume. No repository code can be present.
- It runs the official binary's own login flow in the user's terminal (paste-code flow; the browser opens on the host).
- The credential is written by Claude Code itself.
- QB's Node process never reads, prints or transmits it, and never mounts the user's existing `~/.claude`.

### 5.2 Per run (Mode S)

**The auth lock.** One exclusive lock, `auth.lock` in the QB installation's state directory, guards every reader and writer of `qb-claude-auth`:

- `qb auth login`, `qb auth logout`, and steps 1–2 below;
- steps 1 and 2 hold it **together**, so no refresh, login or logout can interleave between refreshing and copying;
- it is released before ③ starts;
- acquisition has a timeout, failing with `BLOCKED: auth_busy`.

Steps:

1. **Pre-run refresh [gated: E1].** An auth container lets the official binary refresh the persistent credential if it is near expiry. This happens in the clean environment of §5.1.
2. **Per-run copy.** A trusted step copies the **complete** auth state that E1 identifies as required into `qb-<id>-cred`. "Complete" is decided by the experiment, not by assuming `.credentials.json` alone is enough. `qb-claude-auth` is mounted read-only for this step.
3. **Run.** ③ mounts only `qb-<id>-cred`. The lock is not held.
4. **Discard.** After ③ stops, `qb-<id>-cred` is deleted. There is **no write-back of any file**, whatever its shape, size or mode. Any in-run refresh, settings, hooks, MCP config and history are lost with it.

**What E1 must establish before this is final:**

- **(a) Session duration.** Runs succeed without write-back across the expected session length, and across the access-token expiry boundary.
- **(b) Refresh-token rotation.** If the server rotates refresh tokens, an in-run refresh would invalidate the persistent copy. In that case INFERENCE must exclude `platform.claude.com`, and step 1 must leave enough token lifetime for the longest run deadline. The run is refused with `BLOCKED: auth_refresh_required` otherwise.
- **(c) Concurrency.** Two concurrent runs, plus a refresh between them, leave both runs and the persistent state valid.
- **(d) Lifecycle.** The complete set of files the pinned version needs.

If E1 shows that persistent refresh *from execution* is unavoidable, that needs a stronger credential-isolation design and another review. It is not to be solved by validating more fields.

**`qb auth logout`** runs the official `/logout` in an auth container, then removes `qb-claude-auth`.

### 5.3 Mode K: API key or long-lived token (opt-in)

- The user supplies `ANTHROPIC_API_KEY`, or a `CLAUDE_CODE_OAUTH_TOKEN` from the official `claude setup-token`, in the environment they start QB with. QB does not prompt for it, store it or generate it.
- **QB's process does hold the credential in Mode K:** it is in QB's environment.
- It reaches ③ by name-only passthrough (`docker run --env ANTHROPIC_API_KEY`), which keeps the value out of command-line arguments. It is redacted from the run record.
- **QB creates no credential env file.** Mode K credentials enter the Docker container configuration and are accessible to Docker administrators (e.g. via `docker inspect`). This mode does not promise memory-only credential storage.

### 5.4 Residual risk (both modes)

Code inside ③ can read the credential, and Claude Code's own documentation warns of this for bypass-mode containers. What an attacker can do with it:

- **Network:** send it only to INFERENCE hosts, and use it there for any operation the credential allows (§4.1).
- **Output channels:** write it into the workspace, and so into the patch or generated files, or into stdout/stderr and logs that the user later reads or exports. The network policy does not cover these.
  - Mitigation: the captured patch, the capture manifest and exported logs get a best-effort scan for known credential formats. Matches are reported in the run record and by `qb patch` (on stderr). This is detection, not prevention.
- **Other stages:** QB does not intentionally provision credentials to ①, ②, ④ or ⑤. But agent-produced files may contain copied secrets, and those files are read by ④ and checked out for ⑤. Detection is best-effort.
- **Recommendation:** a dedicated account or workspace for QB use, stated in user docs.

### 5.5 Authentication obligations (beta blocker)

Anthropic's documentation distinguishes a user authenticating to the unmodified official binary from a third party collecting or intermediating credentials. Keeping credential bytes out of QB's Node process does not, by itself, settle which side of that line Mode S's lifecycle falls on:

- the per-run copy between QB-managed volumes;
- the QB-orchestrated pre-run refresh;
- headless use of a subscription login.

**Before beta**, this exact lifecycle must be checked against Anthropic's then-current terms and Claude Code documentation, and the conclusion recorded here with sources. If Mode S does not fit, Mode K remains. An Anthropic API key is not made mandatory by this design.

---

## 6. Hostile output tree: capture ④ (reopens QB-03)

After ③ stops, `qb-<id>-work` is hostile. The host never traverses it and never runs git against its `.git`.

### Container

- `--network none`.
- Work volume read-only; `qb-<id>-git`, `qb-<id>-out` and `qb-<id>-verify` read-write.
- **No untrusted process is running anywhere in the run while ④ runs** (§2 ordering). There is no concurrent writer to race against. The traversal is still race-safe by construction, as defence in depth.

### Steps

**1. Bounded pre-scan** (trusted scanner in the image):

- **Directory-relative, no-follow traversal:**
  - `openat2(dirfd, name, O_PATH|O_NOFOLLOW, RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)`, component by component from a root directory fd;
  - then `fstat` on the opened fd, and its `(st_dev, st_ino)` and type must equal the entry just listed;
  - Path-based `lstat`-then-`open` is not used, and nothing is reopened by path.
  - Requires Linux ≥ 5.6. Otherwise the scanner refuses to run and the run ends `infra_error`.
- **Three kinds of descriptor.** `read()` on an `O_PATH` fd fails with `EBADF`, so `O_PATH` is used only to classify an entry. Each kind then gets its own descriptor:

  | Kind | Opened as | Used for |
  |---|---|---|
  | Directory | `openat2(parent, name, O_RDONLY\|O_DIRECTORY\|O_NOFOLLOW\|O_CLOEXEC, RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS\|RESOLVE_NO_XDEV)` | Traversal (`getdents64`), and as the parent fd for children |
  | Symlink | The `O_PATH\|O_NOFOLLOW` fd itself | `readlinkat(fd, "", …)` for the target text only. Never followed. |
  | Regular file | `openat2(parent, name, O_RDONLY\|O_NOFOLLOW\|O_NONBLOCK\|O_NOCTTY\|O_CLOEXEC, RESOLVE_BENEATH\|RESOLVE_NO_SYMLINKS\|RESOLVE_NO_XDEV)`, opened only after the `O_PATH` fd's `fstat` says `S_ISREG` | Content |

  - After opening, `fstat` again: it must be `S_ISREG` with the same `(st_dev, st_ino)` as the classifying fd, or the entry is rejected. This, with `O_NONBLOCK` and `O_NOCTTY`, keeps a race from turning the open into a FIFO, device or tty open. Because classification happens first, special files are never opened for I/O at all.
  - Content is read only through the regular-file fd, up to the per-file cap.
  - This procedure lives in the Rust helper (§9.2), shared by ④ and the host, behind a narrow protocol: a root fd and limits in, a NUL-framed entry stream out. It is reviewed as security-critical code.
- **In-place edits are a separate problem.** An identity check catches a swapped entry, not the same inode being rewritten. In ④ nothing else is running (§2), so no edit can happen. For the host-side read, see §9.2.
- Reject FIFOs, sockets, device nodes, and anything on another filesystem.
- Hard links: a regular file with `nlink>1` is recorded, and its content is captured by value only.
- Caps on file count, total bytes, per-file bytes, path length and depth. Exceeding any cap ends the run `UNRESOLVED: capture_limit_exceeded`, with the counts recorded.
- Symlinks are captured as links (target text only). A symlink whose target is absolute or escapes the tree marks the run `UNRESOLVED: unsafe_symlink`, and the patch is not exported (§9.3).

**2. Git with no repository-controlled configuration and raw content.** Git ≥ 2.42 is pinned in the image.

| Kind | Setting |
|---|---|
| Environment | `GIT_DIR=<trusted>`, `GIT_WORK_TREE=/work`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` |
| Attributes | `GIT_ATTR_SOURCE=<empty tree>`, so in-tree `.gitattributes` are not consulted. `core.attributesFile=/dev/null`; `$GIT_DIR/info/attributes` empty and trusted. Blobs are written with `--no-filters` regardless. |
| Config flags | `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.autocrlf=false -c core.safecrlf=false -c core.filemode=true -c core.symlinks=true` |
| Diff flags | `--binary --no-ext-diff --no-textconv --no-renames` |

**Building the candidate tree.** The candidate is built in a **fresh, empty trusted index**, not by updating an index that starts from the base:

1. For every entry in the scanner's approved list:
   - regular files are written with `git hash-object -w --no-filters --stdin`, fed from the scanner's fd, never by path;
   - symlink target text is written as a blob.
2. Every entry is added with `git update-index --add --index-info` (mode `100644`, `100755` or `120000`, plus the blob id).
3. `git write-tree` produces the **candidate tree id**.

What this means:

- **Deletions are implicit.** Anything in the base that is absent from the approved tree is absent from the candidate. Deleting one file, deleting every file, and file↔directory replacements all come out of the base→candidate diff with no special casing.
- **Nothing is ignored.** `.gitignore`, `.git/info/exclude` and `core.excludesFile` play no part, because no `git add` or directory walk by git happens. A new file can't be hidden by adding it to `.gitignore`, and a tracked file that becomes ignored is still captured. Only the agent's `/work/.git` is excluded. It is treated as ordinary hostile data, neither read as config nor captured.
- **Size is controlled** by the scanner caps, not by ignore rules. Bulky generated directories count against the caps.
- **The deps mount is skipped by construction.** ④ does not mount `qb-<id>-deps`, so `/work/node_modules` is just an empty mount point. A non-empty `node_modules` written into the work volume is captured like any other directory, against the caps.

**3. Output.** ④ writes the following to `qb-<id>-out`, a tmpfs volume whose size is the hard cap:

- `patch.bin` (base tree → candidate tree);
- `name-status.z`;
- the scan report;
- the candidate dependency fingerprint;
- a manifest with SHA-256s of each.

QB transfers these after ④ has exited (§8.5), bounded by `MAX_PATCH_BYTES`. Overflow means `UNRESOLVED: patch_too_large`.

### Fidelity

Capture must reproduce bytes, not just avoid executing things. The §11 T-TREE fixtures check that applying the exported patch to the base reproduces the candidate byte-for-byte, mode-for-mode and link-for-link for:

- CRLF and mixed line endings;
- `.gitattributes` with `text=auto`, `eol=crlf` and `-text`;
- binary files, including NUL bytes and files with no trailing newline;
- executable-bit set and cleared;
- symlinks created, retargeted and removed;
- one file deleted, and every file deleted;
- file → directory and directory → file at the same path;
- a new source file hidden by a changed `.gitignore` (must be captured);
- a tracked file that becomes ignored (must be captured as is).

### Reproduced before the fix

Both of these executed on the host via the current `capture.snapshot()`:

- an agent-written `core.fsmonitor`;
- a clean-filter in `.git/config` with a `.gitattributes` entry.

They become executing regression tests for this section (§0, §11.2).

### Clarification on git hooks

A committed file cannot set `core.hooksPath`. The real risks are:

- (a) inherited system and global git config;
- (b) the agent writing `/work/.git/config` or `/work/.git/hooks/*`;
- (c) other git execution paths: fsmonitor, filters, `diff.external`, textconv, `core.sshCommand`, `core.pager`.

Git commands the agent runs inside ③ are contained. What matters is that **no git process on the host or in ④/⑤ consults agent-writable config or attributes**. The trusted `GIT_DIR`, null global/system config and the empty attribute source guarantee that.

---

## 7. Images

### Agent image

- **Base:** a supported Node LTS, Debian slim, **digest-pinned**. Node 20 is EOL; the candidate is Node 24 LTS, chosen at implementation against the pinned Claude release's documented requirements.
- **Claude:** pinned to an exact version, installed either by `npm install -g @anthropic-ai/claude-code@X.Y.Z` with lockfile integrity, or by the native installer at a pinned version with its checksum verified.
- **Tools:** git ≥ 2.42, a minimal toolchain, the trusted socket forwarder and scanner, and the managed settings.

### Other images

| Image | Base / pin | Notes |
|---|---|---|
| seed / deps / capture / verify | Same base digest as the agent image | No Claude binary |
| proxy | Digest-pinned (§4.2) | |

### Recorded in every run manifest

- `runtime.image_digest`, `runtime.node_version`, `runtime.base_digest`
- `agent.claude_version` (from `claude --version` inside the image at build time)
- `proxy.image_digest`
- the policy hashes
- `deps.fingerprint`, `candidate.tree`

The runtime/image identity and Claude's version are separate fields.

---

## 8. Resources, lifecycle and cleanup

### 8.1 Storage budget and admission

Every per-run byte that can live in host RAM is budgeted. Per-volume caps alone do not stop N concurrent runs from exhausting the host.

| Item | Backing | Default cap |
|---|---|---|
| `work` | tmpfs | 2 GiB / 200k inodes |
| `deps` | tmpfs | 2 GiB / 500k inodes |
| deps scratch source copy (② only, transient) | tmpfs | = `work` |
| `git` (trusted objects: base + candidate) | tmpfs | 1 GiB |
| `verify` (disposable checkout + build output) | tmpfs | 2 GiB |
| `out` | tmpfs | `MAX_PATCH_BYTES` + 1 MiB |
| `cred` | tmpfs | 1 MiB |
| `sock` | tmpfs | 1 MiB |
| per-container `/tmp` | tmpfs | 256 MiB × concurrently running containers (≤ 3: workload, Ⓟ, Ⓚ) |
| container memory limits | RAM | per stage: **caps of the volumes it can write + 2 GiB working allowance** (E2 sizing rule below); Ⓟ 256 MiB; Ⓚ 64 MiB |
| logs (disk) | `local` driver | 10 MiB per container |

**Per-run peak** is the sum of the volumes that coexist, plus the container memory and `/tmp` that run concurrently. QB computes it from the configured caps and records it. E2 measured about 9% kernel overhead on tmpfs data (two runs × 798 MiB written lowered host `MemAvailable` by 870 MiB), so volume caps are counted at **×1.1**. The peak counts a stage's writes twice (once as volume caps, once inside that stage's memory limit). That is deliberate: it errs high.

**Stage memory sizing rule (E2).** tmpfs pages are charged to the memory cgroup of the container that *writes* them. A container whose `--memory` limit is below what it can write into the volumes is OOM-killed before it reaches the volume cap, and a full disk would then look like a memory failure. So each stage's limit covers three things:

> **limit = (1.1 × caps of the volumes the stage can write + the stage's application working set) × 1.25 headroom**

- 1.1 is the measured tmpfs overhead.
- The working set is the memory of the stage's own processes (npm, Claude Code, git, the test runner). The values below are **estimates** until the implementation measures peak usage per stage on the §11.2 fixtures.

| Stage | Writable volumes (caps) | Working set (estimate) | Limit at default caps |
|---|---|---|---|
| ① seed | `work` 2 GiB, `git` 1 GiB | 0.5 GiB | 5 GiB |
| ② deps | scratch copy 2 GiB, `deps` 2 GiB | 2 GiB | 8 GiB |
| ③ agent | `work` 2 GiB | 2 GiB | 5.5 GiB |
| ④ capture | `git` 1 GiB, `verify` 2 GiB, `out` (small) | 1 GiB | 5.5 GiB |
| ⑤ verify | `verify` 2 GiB | 2 GiB | 5.5 GiB |

**Sizing alone does not make failures report correctly.** E2 observed a stage whose writing child was OOM-killed while the container's main process **exited 0** (`State.OOMKilled=true`, `ExitCode=0`). A stage classified by exit code would have been reported as a success. Classification therefore follows §8.4's precedence: `OOMKilled=true` means `oom` whatever the exit code. ENOSPC reported by the stage is a cap hit (`capture_limit_exceeded` or `setup_failed`), not `oom`.

**Admission: beta.** **One run per QB installation.** An exclusive admission lock in the installation's state directory is taken before any per-run resource is created and held until G5b removal. A second `qb run` fails fast with `BLOCKED: run_in_progress`. At admission QB also checks that `MemAvailable` (from `/proc/meminfo`) is at least the per-run peak plus a host reserve (default 2 GiB). Otherwise the run ends `BLOCKED: insufficient_host_resources`, with the numbers.

**Admission: configurable concurrency (post-beta).** Free slots are not enough: two processes can each see enough `MemAvailable` before either allocates. So budget calculation and reservation happen together, under one exclusive lock:

1. Read the ledger `reservations.json`: run id, owner identity (§8.3), reserved bytes.
2. Drop entries whose owner is dead.
3. Admit only if `MemAvailable − Σ(outstanding reservations) ≥ peak + reserve`.
4. Atomically write the new reservation (write temp, `fsync`, `rename`).
5. Release the lock.

The reservation is removed at G5b, or by the reaper.

**Scope, stated precisely:**

- The lock and ledger are **per QB installation** (its state directory). They do not coordinate with other installations, other users, or other checkouts with their own state.
- Admission is a point-in-time check. Unrelated host applications can consume memory after a run is admitted. The per-container `--memory` limits and tmpfs caps still hold, but the host can come under memory pressure anyway (§12).

A slot or reservation is released by the supervisor at G5b removal, or reclaimed by the reaper when its owner is dead.

### 8.2 tmpfs volume lifetime [E2: resolved, keeper required]

The work and other volumes are Docker **`local`-driver volumes with `type=tmpfs`**. This is not a container `--tmpfs` mount, and its lifetime has to be shown, not assumed:

- An ordinary `--tmpfs` mount loses its contents when removed.
- Whether a `local`/tmpfs named volume keeps contents after the last container using it exits (the daemon may unmount it) is what **E2** tests.

| E2 outcome | Design |
|---|---|
| ~~Contents survive between sequential containers, cancellation, and stage failure~~ | ~~No keeper.~~ Ruled out by E2. |
| **Contents are lost when no container has the volume mounted** (observed) | **Keeper Ⓚ.** A trusted, persistent per-run service. It mounts every per-run tmpfs volume and runs a sleep-only trusted entrypoint, with no network, no socket and no repository code. It starts before ① and is removed last at G5b, under the same labels, supervisor and reaper rules as Ⓟ. |

**E2 result (Linux x86_64, Docker Engine 28.0.4, Ubuntu 24.04, cgroup v2; [evidence](../../spikes/qb-02/e2-storage/results/e2-20261002T183010Z-2325/results.md)):**

- Without a keeper, every volume's contents were gone at the next stage. That held both when stage containers were removed and when they were left stopped.
- With a keeper, all seven volumes kept their contents through all five stages.
- A stage killed mid-write left earlier contents intact. Its partial writes stay in the workspace, so capture sees them.

**Daemon restart.** A tmpfs volume's contents do not survive a daemon or host restart.

- **What E2 proves:** with `live-restore` off, a restart stops the keeper and the volume contents disappear. So a detectable signal exists.
- **What E2 does not prove:** that QB turns that signal into `infra_error`. That is implementation behaviour, tested in §11.2 T-RES.
- **Design:** before starting each stage, the CLI checks that the keeper is running and that the `seed` sentinel is present. If either check fails, the run ends `infra_error`, its volumes are reaped, and nothing is resumed.

**Swap and memory accounting.** tmpfs pages can be swapped to host swap if the host has it, so workspace contents and the Mode S credential copy can reach the host's swap device. The E2 CI host had 3 GiB of swap. QB records whether host swap is enabled, warns about it, and does not try to control it.

E2 measured where tmpfs pages are charged:

- **While the writer runs:** to the writer's cgroup. A writer holding 96 MiB showed `memory.current` of 97 MiB. A writer limited to 48 MiB was OOM-killed when it tried to write 96 MiB, so a stage's `--memory` does bound what it can write (hence the §8.1 sizing rule).
- **After the writer exits:** the pages stay allocated (the keeper holds the mount), but they are **not** charged to the keeper. Its `memory.current` stayed under 2 MiB.
- **Consequence:** across stages, only the §8.1 per-run peak and admission bound the total. The single-run `MemAvailable` reading in E2 was within noise of the host's own activity; the two-run measurement is the one used.

### 8.3 Deadlines and the detached supervisor

**`qb-supervisor`** is QB's own code, spawned by the CLI before the first per-run resource is created:

- detached (`setsid`), with its own log file;
- one per run.

It runs on the host as **the same user as the CLI**. What protects it is that container processes run in their own PID namespace, so they cannot see or signal host processes. Docker access stays in the trusted host control plane, in the CLI and the supervisor; no container gets the Docker socket.

**Protocol.**

- **Identity.** A process is identified by `(pid, start_time)`, where `start_time` is field 22 of `/proc/<pid>/stat`. Liveness checks compare both, so a reused PID is never mistaken for a live owner. Run ownership, the reaper and admission all use this identity.
- **Readiness handshake.**
  - The CLI spawns the supervisor and waits, bounded at 10 s, for it to write `ready` (its identity and protocol version) to `run/<id>/supervisor.json`.
  - No per-run Docker resource is created before `ready`.
  - With no `ready` in time, the CLI kills the supervisor and the run ends `infra_error`.
- **Stage deadlines are immutable.** Before starting a stage, the CLI writes a stage record with its `deadline_ms`, a duration that is never edited afterwards. The supervisor acknowledges the record, and the stage starts only after the ack.
  - The supervisor measures the deadline from its **own** monotonic clock (`CLOCK_MONOTONIC`, read when it acks). The CLI's clock and wall-clock time play no part.
  - Lease renewal carries no deadline field, so it cannot extend a deadline.
- **Lease.** The CLI renews `run/<id>/lease.json` every 5 s with a sequence number. Every write is atomic (write temp, `fsync`, `rename`). The supervisor tracks renewal age on its monotonic clock.
- **Enforcement.** At `T_end + KILL_GRACE` (G5a), the supervisor sends `docker kill` to every `qb.run=<id>` workload container, then stops Ⓟ/Ⓚ. `T_end` is the earlier of the stage deadline and the last renewal + `LEASE_TIMEOUT`.
- **Bounded Docker operations.** Every Docker command the supervisor (or CLI) runs has a hard timeout (`DOCKER_OP_TIMEOUT`) and is killed on expiry. A hung Docker client or daemon is retried with backoff, recorded as `infra_error`, and can never block enforcement forever. This is the G5c case.
- **Single terminal-state writer.**
  - The supervisor is the only writer of a run's terminal state while it is alive. The CLI *proposes* an outcome (`completed`, `execution_error`, `cancelled`, …) through a stage-result record.
  - The supervisor commits exactly one terminal state, with a create-exclusive `O_CREAT|O_EXCL` write of `run/<id>/terminal.json`. The first committed state wins; later proposals are recorded as events but cannot change it.
  - The reaper uses the same create-exclusive write when the supervisor is dead, so a terminal state can never be written twice.
- **Normal end.** The supervisor commits the terminal state, performs G5b removal, confirms it, and exits.

**Recovery after supervisor failure.** The CLI watches the supervisor's identity. If the supervisor dies mid-run while the CLI is alive, the CLI:

1. kills all workloads, with bounded Docker commands;
2. ends the run `infra_error (supervisor_lost)`, committed by the same create-exclusive write;
3. performs G5b removal itself.

If both are dead, see "Supervisor failure" below.

**In-container `timeout`.** Kept as a convenience, so the payload usually ends itself cleanly. It is **not** a security control: same-uid code can kill or evade it.

**Supervisor failure** (e.g. the user kills it as well, or the host reboots):

- A reboot stops the containers, and `--restart no` keeps them stopped.
- The next `qb` start runs the reaper. It removes every `qb.run=*` resource whose run is terminal or whose supervisor and owner identities (§8.3: PID + start time) are both dead. It commits `ABANDONED` with the create-exclusive terminal write; if a state is already committed, it keeps that one.
- `qb doctor` lists any leftovers; `qb doctor --reap` removes them.

This is eventual recovery, as G5b states.

### 8.4 Terminal states

These extend QB-22. Each records `exit_code`, `signal`, `oom_killed`, `duration`, and which actor ended it (`self`, `cli`, `supervisor`, `reaper`).

**Precedence.** A stage's state is decided from `docker inspect` in this order, never from the exit code alone:

1. `infra_error`
2. `timeout` (killed by the supervisor's deadline)
3. `cancelled`
4. `oom` (`State.OOMKilled=true`, even when `ExitCode` is 0; observed in E2)
5. `execution_error` (nonzero exit)
6. `completed` / `no_change`

| State | Meaning |
|---|---|
| `completed` / `no_change` | Agent ended normally |
| `execution_error` | Nonzero exit |
| `timeout` | Supervisor deadline hit |
| `oom` | `State.OOMKilled=true`, regardless of exit code |
| `cancelled` | User / SIGINT |
| `infra_error` | Docker daemon unavailable or restarted, image missing or digest mismatch, volume/network creation failure, proxy failed health check, scanner unsupported kernel. Never reported as an agent or verification result. |
| `setup_failed` | Seed or deps failure |
| `ABANDONED` | CLI lost (lease expiry) or found by the reaper |
| `BLOCKED: …` / `UNRESOLVED: …` | Setup or capture gates named in §3.2, §5.2, §6, §8.1 |

### 8.5 Output streams and evidence

**Draining.** Container stdout/stderr are **streamed** from an attached `docker start -a` child while it runs. They are drained continuously into bounded buffers (head + tail, `MAX_LOG_BYTES` per stream). Once a buffer is full, further bytes are read and discarded, and the truncation is recorded. Reading never stops, so the child can never block on a full pipe.

The landed `lib/proc.run()` uses `spawnSync` with `maxBuffer`, which kills the child on overflow. Container stages need a streaming runner instead.

**Finalizing.** Evidence (exit state, buffers, patch) is finalized only after `docker inspect` reports `State.Running=false` and `State.Status=exited`. If the container is still running at the deadline, the supervisor kills it (§8.3). If it never reaches `exited`, the run is `infra_error`.

**Patch transport.** The patch never travels through stdout or Docker logs, which rotate and are diagnostic only.

1. After ④ exits, QB copies `qb-<id>-out` out of the stopped ④ container with `docker cp <ctr>:/out -`.
2. It reads the tar stream with a byte cap and a strict parser: regular files only, the expected names, no links.
3. It verifies each file against the manifest's SHA-256s. A mismatch is `infra_error`.

---

## 9. User checkout and patch delivery

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

v1 has no command that writes to the checkout, so this holds by construction (§9.3).

### 9.2 Reading the checkout

QB reads the checkout to seed the workspace, and **never writes**:

- `git ls-files -z --cached --others --exclude-standard` lists the paths. It runs with `-c core.fsmonitor=false` and null global/system config, so no program is launched.
- The **Rust helper** (`qb-fsread`, Linux only) reads each listed path using the three-descriptor procedure of §6. It streams a tar to ① and records the baseline hash/mode/type of every path.
  - Node's path-based `fs` cannot express this, which is why it is a separate helper.
  - Interface: a root path, the NUL-separated path list and limits on stdin; a tar plus a NUL-framed baseline record on stdout; errors on stderr. Nothing else.
  - Its syscall wrappers are isolated in one module, and it has its own adversarial filesystem tests: entry swaps, symlinked parents, FIFOs and devices placed at listed paths, and mount points.
  - A path that changes type or identity during the read aborts seeding with `setup_failed: checkout_changed_during_read`.
- **Concurrent edits.** The identity check catches entries being swapped, not a file being rewritten in place. Separately, the helper:
  - records `(size, mtime_ns, ctime_ns)` from `fstat` before and after reading each file, and aborts with the same reason if they differ;
  - after the stream, re-checks every path's identity and `ctime_ns`.

  This catches most concurrent edits. It **does not** give a globally consistent snapshot of the checkout: two files edited between their individual reads, or an edit that restores identical metadata, can still produce a seed that never existed as a whole. A consistent snapshot would need a mechanism like a filesystem snapshot or the user committing first, and v1 has none. The run record says so, and the baseline (§9.3) is "what QB read", not "the checkout at time T".
- The current `capture.snapshot()` path, which writes objects through a temporary index, is **removed from the user-checkout path**.

### 9.3 Patch delivery (v1): `qb patch <run_id>`; `qb apply` deferred

v1 delivers a patch for **manual** application. QB does not modify the checkout.

**`qb patch <run_id>`** exports the run's `patch.bin`. "Export" must not become a way to damage the checkout.

**Destination:**

- **Default:** `<run artifact dir>/<run_id>.patch`, in QB's state directory, which is outside the source checkout.
- `--out <path>`:
  - the file is created with `O_CREAT|O_EXCL|O_NOFOLLOW`, so an existing file is never overwritten and a destination symlink is never followed;
  - the parent directory is opened with `O_DIRECTORY|O_NOFOLLOW`;
  - a destination inside the checkout being preserved (§9.1) is refused.
- `--stdout`: stdout carries **only** patch bytes. Every diagnostic, preflight result and warning goes to stderr.

**Status label.** The patch header and the stderr summary give the run's **actual** status: the verification state (`passed`, `failed`, `not_run: dependency_change_required`, …), the candidate tree id, and any credential-scan or drift findings. Phase 1 does not establish trustworthy acceptance (§1), so nothing is labelled "verified". A passing run is labelled "tests passed in sandbox (Phase 1: tests were agent-editable)".

Before writing, it runs a **read-only preflight** against the current checkout:

1. **Path validation.** It refuses to export a patch that contains:
   - absolute paths, `..` segments, or anything under `.git/`;
   - submodule/gitlink entries;
   - patch-created symlinks with absolute or escaping targets. There is no override flag; such runs are already `UNRESOLVED: unsafe_symlink`.
2. **Drift report.** For each touched path, it compares current content, mode and type with the baseline from §9.2, and lists mismatches.
   - It also reports paths whose parent component in the current checkout is a symlink.
   - It does not refuse on drift (it isn't writing), but it prints the conflicts.
3. **Instructions** (on stderr). The diffstat, then:
   - **Before applying, preserve your current state**, e.g. commit, or `git stash push --include-untracked` (pop it afterwards), or copy the working tree.
   - Then `git apply --check <file> && git apply <file>`.

It does not claim that `git apply` is atomic. A failed or interrupted manual apply can leave some files changed. If that happens, **inspect before restoring** (`git status`, `git diff`), and restore from the state you preserved. QB does **not** suggest `git checkout -- <paths>` or any other command that would discard uncommitted work the user had before applying.

**Deferred: `qb apply`.** It returns only with a separate design and review that includes:

- durable preimages of touched files;
- a write-ahead journal;
- recovery that detects concurrent user edits before restoring anything;
- an explicit `apply_incomplete` state;
- fault-injection tests between individual file writes.

Global atomicity is not promised.

---

## 10. Unsupported paths and the test harness

**Docker unavailable.** Docker missing, not running, version unsupported, or image digest mismatch: `qb` exits non-zero with a specific message and the fix, e.g. "Start Docker Engine; `qb doctor` for details". The run is recorded as `BLOCKED: sandbox_unavailable`. There is no fallback.

**Test harness.** The fake agent is injected only through a **dependency-injected harness in `test/`**:

- `test/helpers/` constructs the runner with a fake agent object.
- The shipped CLI entry point (`qb.js`) has no environment variable, flag or config key that selects a host-executed agent.
- `QB_AGENT_COMMAND` support is deleted from `agent/runner.js`.
- A unit test asserts that the shipped CLI ignores `QB_AGENT_COMMAND` and `NODE_ENV`.
- Harness results are marked `isolation: "none-test-only"` and cannot satisfy any gate.

**Interim warning, until this ticket's implementation lands.** In the README and the CLI banner on every run:

> **QB does not yet contain repository code.** It runs the coding agent and your project's test command directly on this machine, with your user's privileges, file access and network access. Use it only on repositories you fully trust.

**Beta release gate.** The supported beta release must not contain the uncontained execution paths listed in §0: host agent execution in `qb.js`, host test execution in `verify/checker.js`, host git capture in `agent/capture.js`. Until they are replaced, the build is a development preview, not the beta.

---

## 11. Validation

### 11.1 Gating experiments (before implementation proceeds)

Four small, separately reviewable spikes, each on Linux x86_64 + Docker Engine (`ubuntu-24.04`). Each produces:

- a script under `spikes/qb-02/eN-*/`;
- a short results file: Docker, kernel and Claude versions, raw output, pass/fail per criterion.

v3 is revised from those results before QB-02 is marked final.

**E1: Authentication** (unblocks §5.2, §4.3 INFERENCE)

1. `qb auth login` via the official binary into `qb-claude-auth`.
2. Per-run copy; run a fixture task; discard. No write-back.
3. Repeat the runs across the access-token expiry boundary, and over the expected session length.
4. Observe whether an in-run refresh happens and whether refresh tokens rotate. If they do, check that the persistent copy still works afterwards.
5. Two concurrent runs, with a pre-run refresh between them; plus `qb auth login` attempted during a refresh+copy (must serialise on the lock).
6. Enumerate the auth files the pinned version actually needs.

**Pass:** all runs authenticate, the persistent state never needed agent output, and the required file set is recorded.

**E2: Storage** (unblocks §8.1, §8.2) — the reviewer's procedure, per volume type:

1. ① writes a sentinel to each volume and exits.
2. Confirm no workload container is running.
3. ② mounts each volume and checks the sentinels.
4. Repeat through ③, ④ and ⑤.
5. Repeat after cancelling mid-stage (supervisor `docker kill`).
6. Repeat after `systemctl restart docker`, and confirm the run is detected as `infra_error`, not continued.
7. Fill each volume to its cap and confirm ENOSPC inside the container. Measure host `MemAvailable` and the memory cgroup charges.
8. Run two concurrent runs at full caps against the admission check.

**Pass:** the keeper decision is made from evidence, every cap holds, and admission refuses a run that would exceed the budget.

**Result (2026-10-02, [run 2 evidence](../../spikes/qb-02/e2-storage/results/e2-20261002T214917Z-2322/results.md), which supersedes run 1 after stricter checks):** the **experiment** is complete.

- **Size cap:** the file filled exactly the cap, with ENOSPC and 0 blocks free.
- **Inode cap:** ENOSPC with 0 free inodes and all blocks still free.
- **Cleanup:** 0 resources left.

- **Keeper:** required.
- **Caps:** size and inode caps hold with ENOSPC.
- **Killed stage:** earlier contents intact.
- **Restart:** stops the keeper and loses the contents.
- **tmpfs charging:** to the writing container's memory cgroup.

**The product's storage protections are not complete.** Each of these is an implementation item with a §11.2 test:

- admission control (not testable until built; E2 recorded its inputs);
- enforcing the stage memory limits;
- classifying `oom` by `OOMKilled`;
- turning a restart into `infra_error`.

**E3: Networking** (unblocks §4)

1. From ② and ③: every T-NET "must fail" case fails, and the allowlisted host succeeds via the read-only-mounted socket.
2. An attempt to unlink or replace the socket from a consumer fails.
3. With a test resolver serving an allowlisted name:
   - mixed public and denied-range answers → refused;
   - a TTL-0 answer that flips to a denied address between requests → refused;
   - first public address unreachable, second in a denied range → no connection to the second.
4. Squid resource limits hold under a connection flood.

**Pass:** all of the above with Squid alone, or with the §4.1 resolver contingency (recorded which).

**Result (2026-10-02, [evidence](../../spikes/qb-02/e3-network/results/e3-20261002T221147Z-2455/results.md); CI run 37071150968, ubuntu-24.04, Docker Engine 28.0.4, Squid 6.13): passed with Squid alone, 39/39 checks.**

- **No way out but the proxy:** the consumer had no route except loopback, and every non-lo device was down. The host gateway, host LAN IP, `host.docker.internal`, cloud metadata, IPv6, the internet, DNS (including 8.8.8.8 directly) and the other run's proxy were all unreachable.
- **Socket:** could not be unlinked or replaced, and remained in place.
- **CONNECT policy:** only exact allowlisted names on 443 (`api.anthropic.com` → 200). Refused with 403:
  - non-listed names, subdomains and IP literals;
  - `169.254.169.254` and `host.docker.internal`;
  - port 80 and plain HTTP;
  - raw requests written straight to the socket.
- **Attacker-chosen names:** refused **without ever reaching the resolver**. The resolver's log contains only allowlisted names.
- **Rebinding:** an allowlisted name that flipped to an internal address (TTL 0), a mixed public+denied answer set, and an unreachable-public+denied answer set were all refused.
  - The internal canary on the proxy's own network received **0 connections**.
  - Every allowed tunnel in Squid's access log went to the checked public address.
- **Flood:** 100 concurrent CONNECTs all answered; the proxy stayed healthy at 24 MiB of its 256 MiB limit.

**What E3 does not cover:**

- Mixed or flipped answers were tested with **A records**; the fixture served no AAAA records. IPv6 is disabled on the proxy network.
- Squid's behaviour depends on the tested config (`positive_dns_ttl 1 seconds`, the hostname check before the `dst` check). The implementation must ship exactly this policy, and T-NET must re-run it.
- As designed, there is no TLS inspection: the allowlist restricts destinations, not API operations (§4.1).

**E4: Lifecycle** (unblocks §8.3, G5)

1. A payload tries to disable the in-container timeout: kills `timeout`, ignores SIGTERM, forks and double-forks, `setsid`.
2. Then `kill -9` the QB CLI.
3. Exactly the G5a bound: `docker kill` is issued by last renewal + `LEASE_TIMEOUT` + `KILL_GRACE`, and all containers are stopped within a further `DOCKER_OP_TIMEOUT`. Then all per-run resources are removed.
4. Variants:
   - deadline expiry with the CLI alive, with the CLI still renewing the lease (renewal must not extend it);
   - a host wall-clock jump during a stage (must not change the deadline);
   - supervisor killed while the CLI is alive → `infra_error (supervisor_lost)`, CLI cleans up;
   - supervisor never writes `ready` → no Docker resources created;
   - PID reuse: the reaper must not treat a new process with the old PID as the owner;
   - a `docker` command that hangs (e.g. a stub client) → enforcement continues after `DOCKER_OP_TIMEOUT`;
   - CLI proposes `completed` while the supervisor commits `timeout` → exactly one terminal state;
   - supervisor killed as well → the next `qb` start reaps;
   - Docker stopped during the run → `infra_error`, with retries logged.

**Pass:** G5a–G5e observed as written.

**Result (2026-10-02, [run 2 evidence](../../spikes/qb-02/e4-lifecycle/results/e4-20261002T215833Z-2397/results.md); CI run 37069919604, ubuntu-24.04, Docker Engine 28.0.4):** passed. The test used a **prototype** of the §8.3 protocol (`spikes/qb-02/e4-lifecycle/proto/`), not product code, with shortened timings: lease 5 s, grace 3 s, Docker op timeout 10 s.

| Scenario | Stopped after | Bound | Recorded end state |
|---|---|---|---|
| CLI SIGKILL | 7.7 s | 19.5 s | `ABANDONED` (supervisor, lease expired) |
| Payload kills its own timeout; CLI keeps renewing | 11.2 s after stage ack | 22.5 s (not before 9.5 s) | `timeout` (supervisor, stage deadline) |
| Supervisor SIGKILL, CLI alive | 0.5 s | 12 s | `infra_error` (cli, supervisor_lost) |
| Both dead | still running 10 s later; 0.5 s after the reaper starts | eventual (G5b) | `ABANDONED` (reaper) |
| First `docker kill` hangs | 19.4 s after stage ack | 30.5 s | `timeout` |

- **Children:** all four evasive children (background, double-fork, setsid, nohup) were seen running. All six container processes were snapshotted by host PID + start time, and none survived.
- **Cleanup:** 0 containers, volumes or networks left in every scenario.
- **Supervisor never ready:** no Docker resources were created.
- **Single terminal writer:** 200/200 rounds.
- **PID reuse:** a reused PID with a different start time was not treated as the owner.
- Run 1 differed only in a harness defect in the child-process check, described in `spikes/qb-02/README.md`.

**Not covered by E4:**

- the wall-clock-jump variant (the deadline uses the supervisor's monotonic clock; untested);
- Docker stopped mid-run.

Both move to §11.2 T-LIFE. **The product supervisor must re-pass every scenario above as T-LIFE regressions.** E4 validates the protocol, not the implementation.

### 11.2 Integration suite

`QB_INTEGRATION=1`, real Docker, fixture payloads instead of Claude unless stated.

**Support matrix (after this suite passes):** Linux x86_64 (kernel ≥ 5.6); Docker Engine (minimum version fixed at validation); CI on `ubuntu-24.04`, pinned rather than `-latest`. Docker Desktop on macOS gets a separate job and is unsupported until it passes.

#### T-NET

From inside ② or ③, each of these must fail:

- connecting to the host gateway, the host's LAN IP, `host.docker.internal`, `169.254.169.254`, a service on host loopback (via gateway), and an IPv6 target;
- resolving any DNS name;
- reaching a second concurrent run's proxy;
- `CONNECT` to a non-allowlisted host, a subdomain of an allowlisted host, or an IP literal;
- the E3 rebinding cases;
- writing to the socket directory.

These must succeed:

- an allowlisted host through the socket.

Inspect checks:

- no published ports, no host network/PID namespace, no Docker socket.

#### T-FS

- Agent writes outside `/work` are confined to the container.
- The user-checkout fingerprint (§9.1) is identical after success, `execution_error`, `timeout`, `oom`, `cancelled`, CLI SIGKILL mid-run, and `qb patch`.
- `qb patch --out` refuses: an existing file; a symlink pointing at a checkout file; a path inside the checkout. `--stdout` output is byte-identical to `patch.bin`, with every diagnostic on stderr.

#### T-TREE (hostile output and fidelity)

The **two reproduced git attacks** (fsmonitor; clean-filter + `.gitattributes`) run as executing tests and must not execute. This replaces the `todo` seeds and is required to close QB-03.

The agent also leaves:

- `.git/config` with filters, `diff.external` and textconv;
- an escaping symlink and an absolute symlink;
- a FIFO;
- a 10 GB sparse file;
- 10⁶ small files;
- a path with newlines or a leading `-`;
- a directory swapped for a symlink (traversal identity check).

Expected: no host execution, no hang, bounded time and memory, the correct `UNRESOLVED` reason, and `qb patch` refusing to export the escaping symlink.

Fidelity fixtures (§6): exported patch applied to the base reproduces the candidate exactly.

#### T-DEPS

- Unsupported layouts (workspaces, `file:` deps, missing lockfile) → the correct `BLOCKED` reason with an explanation.
- A native addon build in a dependency succeeds.
- A root `postinstall` → `BLOCKED (root lifecycle script)`.
- A dependency install script that writes into the project root → `BLOCKED (install modified the project tree)`, with the path listed.
- An agent edit to `package.json`, to the lockfile, or to `.npmrc` → `UNRESOLVED: dependency_change_required`, and ⑤ is not run.

#### T-VERIFY

- A test command that writes build output, coverage and a cache succeeds.
- None of those files appear in the patch.
- The evidence names the candidate tree id and the dependency fingerprint.

#### T-RES

- Fork bomb, memory hog, disk fill on each volume, log flood (the CLI must not block or lose the exit state), and sleeping past the deadline each produce the correct state, with no surviving resources (G5).
- A child OOM-killed under a main process that exits 0 is reported `oom`, not `completed` (E2 observation).
- A disk fill in each stage is reported as a cap hit (ENOSPC), not `oom`, at the §8.1 stage limits.
- A daemon restart mid-run ends `infra_error`, with no stage continuing on lost contents.
- Admission refuses an over-budget run.

#### T-LIFE

The E4 cases, as regressions.

#### T-AUTH

- **Provisioning.** QB mounts or passes no credential to ①②④⑤. Checked by inspecting each container's mounts and environment, not by searching contents.
- **No write-back.** Nothing written to `qb-<id>-cred` during a run is present in `qb-claude-auth` afterwards. A fixture overwrites every auth file with well-formed attacker values, and the next run uses the original credential.
- **Copied-secret reporting.** A fixture agent writes a fake credential, in a known format, into a source file and into stdout. The run record and `qb patch` report both. The patch is still exported, because the scan is detection, not a block.
- **Mode K.** QB writes no env file or other credential file on the host.
- **Lock.** Login during a run's refresh+copy waits, or fails with `auth_busy`. Concurrent runs follow E1 case 5.

#### T-POLICY

The pinned Claude version completes one fixture task under INFERENCE in each auth mode. The proxy log shows only the policy hosts.

#### T-HARNESS

The shipped CLI ignores `QB_AGENT_COMMAND` and `NODE_ENV=test` (§10).

---

## 12. Residual risk

- **Kernel or container-runtime escapes.** Keep the Docker Engine and kernel patched; optionally gVisor (`--runtime runsc`) later.
- **Exfiltration through allowed channels:**
  - the model API: prompt contents, and any API operation the credential allows (§4.1);
  - the npm registry during deps: request paths;
  - **output channels:** the patch, generated files, stdout/stderr and logs, including a stolen credential written into them (§5.4).

  Mitigated by the workspace containing only the repository, per-policy scoping, the best-effort credential scan, user review of the patch, and the dedicated-account recommendation.
- **Credential theft within the agent container** (§5.4).
- **tmpfs-backed caps consume host RAM.** Contents may reach host swap (§8.2). Bounded by admission (§8.1), which is per installation and point-in-time: other users, other installations, and unrelated applications can still push the host into memory pressure.
- **Docker `live-restore`.** Workloads can outlive a daemon outage beyond G5a's bound (G5c). QB warns when it is enabled.
- **Supervisor killed by the user or a host-level fault.** Cleanup becomes eventual (G5b).
- **Manual patch application** is not atomic (§9.3).
- **Dependency builds that read application source** are not detected (§3.2). Stale artifacts behind a matching fingerprint are possible for such packages.
- **Test tampering** inside the workspace: Phase 2.

---

## 13. Status of decisions and next evidence

All six v3 decisions were ruled on in the v3 review (§0.1). There are no open architecture questions this round.

The next approval needs evidence, not another document round. In order:

1. This v3.1 design, committed as experimental and gated.
2. The accurate README/CLI warning (§10), and removal of the production `QB_AGENT_COMMAND` override in favour of the injected test harness.
3. Executable reproductions of the two git attacks, reported as demonstrated defects (§0).
4. E1–E4 on Linux + Docker Engine (§11.1), with exact versions, commands, sanitised output and pass/fail per criterion.
5. The implementation, finalised from those results, with the §11.2 suite as its release gate.

Shipping a supported beta stays gated on all of the above, plus the §5.5 authentication-obligations check for Mode S.
