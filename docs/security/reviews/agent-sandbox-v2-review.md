# QB-02 sandbox design v2: review

Reviewed document: [`../agent-sandbox.md`](../agent-sandbox.md) (v2, commit `d03a2b0`).
Disposition: **changes requested.** Implementation spikes approved; QB-02 is not yet a finalized design.

This is a review of the design, not verification that the implementation or the reported exploit reproductions work.

## Answers to the five questions (§13)

| Question | Decision | Conditions |
|---|---|---|
| 1. Subscription credential volume and write-back | **Reject write-back as designed.** Approve direct login and isolated per-run copies in principle. | Never promote agent-writable credentials into trusted persistent auth state based only on JSON validation. |
| 2. Squid primary, Envoy fallback | **Approve Squid for a proof of concept.** | Verify the selected image, actual ACL behaviour, Unix-socket bridge, DNS handling and resource limits. Don't implement two proxies initially. |
| 3. tmpfs-backed volumes | **Conditionally approve for a deliberately small Linux beta.** | Prove data survives stage transitions; enforce an aggregate memory/concurrency budget; define mount lifetime and swap behaviour. |
| 4. Read-only deps; dependency changes unresolved | **Approve as a documented v1 limitation.** | Detect changes mechanically; tie verification to the exact manifest/lockfile used to build deps. |
| 5. "Trusted repositories only" until implementation | **Approve the warning; insufficient alone.** | State that current execution is uncontained and runs with the user's privileges. Keep the unsafe implementation out of the supported beta. |

## Required revisions

### 1. Credential write-back crosses the trust boundary (§5)

- Copying back a refreshed `.credentials.json` after shape/size/mode checks proves formatting, not authenticity. Repo code running as the agent user can write well-formed, attacker-chosen contents.
- Concurrent runs can overwrite each other's refreshed credentials.
- Copying only `.credentials.json` may omit state the pinned Claude version needs; requires a real auth test.
- **Revision:** discard auth-state changes from agent runs. Refresh/reauth of persistent state happens only via the official binary in a clean auth environment with no repo code. Prove this supports expected session duration. Any persistent refresh from execution needs a stronger isolation design and another review.
- **Correct:** "QB never holds the credential in its own process" is false for Mode K (env → env file).
- The credential-copy lifecycle must fit Anthropic's published conditions distinguishing users authenticating to the unmodified binary from third-party credential collection/intermediation. An API key need not be mandatory.

### 2. Timeout backstop is not protected from the adversary (§8)

- Everything runs as UID 10001; a payload can signal or interfere with an in-container `timeout` under the same UID. "If QB dies, the container still terminates" is not established.
- **Revision:** enforce the lease/deadline from a supervisor outside the untrusted container, independent of the QB CLI's lifetime. Keep the in-container timeout as a convenience.
- Fixture: payload attempts to disable timeout machinery, then QB is killed; the independent supervisor must still terminate the run.
- Rewrite G5: max time before running workloads are terminated; when stopped containers/volumes are removed; behaviour while Docker is unavailable; which persistent auth volume is intentionally retained. Next-start cleanup is eventual recovery, not "no resources remain".

### 3. tmpfs volumes need a lifecycle experiment (§8.1)

The design uses a local-driver volume backed by tmpfs, not `--tmpfs`. Experiment:

1. Seed writes a sentinel and exits.
2. No workload container remains running.
3. Deps prep mounts the volume and checks the sentinel.
4. Repeat through agent, verifier and capture.
5. Repeat after cancellation and daemon restart.

If a trusted keeper container is needed to retain mounts, document it as a persistent per-run service with its own cleanup rules. Budget **all** storage (work, deps, verifier copy, trusted Git objects, auth copy, socket volume, logs) with a concurrent-run admission limit.

### 4. Remove "partial application is impossible" (§9.3)

`git apply --check` then `git apply` is not a crash-safe multi-file transaction; `apply.started` detects but does not undo.

- **Simplest v1:** deliver a patch for manual application; defer `qb apply`.
- If kept: durable preimages, write-ahead journal, recovery that detects concurrent user edits before restoring, explicit `apply_incomplete`, fault-injection tests between file writes. No global atomicity promise.
- Remove `--allow-symlinks` for escaping targets in v1.

### 5. Read-only deps need a consistency gate (§3.2)

- Fingerprint: manifest + lockfile, package-manager version, runtime/platform, install options affecting the tree. On change → `UNRESOLVED: dependency_change_required` before treating tests as verification.
- `npm ci` with only read-only manifests won't support root lifecycle scripts, workspaces, local deps, native builds. Define the supported project profile; unsupported layouts stop with a setup explanation.

### 6. Verifier needs writable scratch (§3.4)

Use a disposable writable verification copy (or explicit writable output mounts); keep the candidate immutable. Evidence identifies the candidate snapshot; verification-generated files never become the delivered patch.

### 7. Networking claims (§2, §4)

- `--network none` leaves loopback: say "no external network interface".
- Replace "containers run one at a time" with "untrusted workload stages run sequentially; trusted support services may overlap".
- A CONNECT allowlist restricts destinations, not API operations; without TLS inspection it doesn't guarantee legitimate Claude inference.
- Exact hostname matching; the IP checked must be the IP connected to (multiple answers, retries). Mount the socket dir read-only in consumers where supported.
- "Stolen credential can only be sent to Anthropic endpoints" is too broad: it can be written to generated files/logs that are exported. Add those output channels to residual risk.

### 8. Source capture and output handling (§6, §8.4, §9.2, §10)

- `lstat` then normal read is not race-safe. Specify directory-relative, no-follow traversal with identity checks (or equivalent).
- Don't wait for exit before draining stdout/stderr; stream into bounded buffers while running, finalize after confirmed exit. A rotating Docker log is not a reliable transport for a complete patch.
- Test raw-content fidelity: CRLF, binary, exec-bit changes, symlinks; Git attributes can affect normalization without filter programs.
- `NODE_ENV=test` is user-settable; it doesn't make a host-execution hook unreachable. Move test injection to a separate test entry point or DI harness.

## Next steps

Four small, reviewable experiments, then revise the design from their results:

1. **Authentication:** direct login, per-run copy, no write-back; test expiry and concurrent runs.
2. **Storage:** sequential tmpfs-volume persistence and aggregate resource bounds.
3. **Networking:** socket-only egress and the selected Squid ACLs.
4. **Lifecycle:** kill QB and attempt to disable the in-container timeout; prove independent termination and recovery.

Convert the reported Git attacks from `todo` seeds into executable regressions before closing QB-03.
