# QB-02 sandbox design v3: review

Reviewed document: [`../agent-sandbox.md`](../agent-sandbox.md) (v3).
Disposition: **approved as the working design for experiments E1–E4 and incremental implementation.** QB-02 is not complete, and the sandbox must not ship yet. The targeted corrections below go into the next commit (v3.1); no full rewrite is needed.

This review covers the document only. Uncommitted code was not inspected, and E1–E4 were not run.

## Decisions

| Decision | Ruling |
|---|---|
| a. Authentication model | **Approved for E1.** No write-back is the correct boundary. Hold the auth lock across refresh **and** copy; login and logout coordinate with the same lock. Subscription support stays conditional on E1 and the authentication-obligations check. |
| b. Supervisor location | **Detached host process approved.** Docker access stays in the trusted host control plane. Requires a readiness handshake before workloads, bounded Docker commands, and recovery after supervisor failure. |
| c. Defer `qb apply` | **Confirmed.** Export plus read-only preflight; fix the export and recovery details. |
| d. Supported project profile | **Approved for a narrow beta**, with the lifecycle-script limitation documented. |
| e. Capture before verification | **Confirmed.** Freeze the candidate, verify a disposable copy, keep the authoritative tree inaccessible to test processes. |
| f. Native helper | **Approved; prefer Rust.** Small, with a narrow I/O protocol and isolated syscall handling. Memory safety helps, but the filesystem semantics still need adversarial tests. |

## Corrections required

1. **`O_PATH` fds cannot be read** (`read()` returns `EBADF`). Distinguish directory fds for traversal, symlink fds for `readlink`, and validated regular-file fds opened for reading. Specify a reviewed no-follow, no-special-file open procedure, with no path-based reopen. Inode/device matching does not detect in-place edits: define concurrent-edit detection separately, and don't claim a globally consistent snapshot.
2. **Capture must represent deletions and ignored files.** Build a fresh candidate index from the complete approved tree, or explicitly remove baseline entries. `.gitignore` must not hide new files. Fixtures: delete one and all files; file↔directory replacements; a new file hidden by a changed `.gitignore`; a tracked file that becomes ignored.
3. **Remove absolute credential claims.**
   - Mode K: "QB creates no credential env file. Mode K credentials enter the Docker container configuration and are accessible to Docker administrators. This mode does not promise memory-only credential storage."
   - Stages: "QB does not intentionally provision credentials to seed, dependency, capture, or verification stages. Agent-produced files may contain copied secrets; detection is best-effort."
   - T-AUTH must plant a fake credential and exercise the reporting.
4. **Precise supervisor protocol:**
   - readiness ack;
   - immutable stage deadlines that heartbeats cannot extend;
   - atomic lease updates and monotonic time;
   - ownership by process start identity, not just PID;
   - Docker operation timeouts;
   - one authoritative terminal-state writer.

   Also: pick one G5a bound and test exactly that bound, and drop the "different uid" assertion.
5. **Admission needs reservations.** Budget calculation and reservation go under one lock, with the outstanding reservations recorded. The scope is per installation, not host-wide. One run per installation is acceptable for the beta. Document that unrelated applications can consume memory after admission.
6. **Lifecycle-script limitation.** Generated outputs outside `node_modules` are discarded, and install steps that read mutable source can go stale behind a matching fingerprint. Exclude such projects in v1 (or define a controlled rebuild), with a fixture.
7. **Export must not harm the checkout.**
   - Default to the artifact directory outside the checkout.
   - Never overwrite or follow destination symlinks.
   - Keep diagnostics off stdout when stdout carries the patch.
   - Label the patch with its actual verification status.
   - Drop `git checkout -- <paths>` advice: preserve state before applying, and inspect before restoring.
8. **DNS fallback contradiction.** "Reject if any answer is denied" and "strip denied answers" are different policies. Make the fallback reject the whole answer set, or deliberately revise the requirement and its test. Invariant: every actual connection destination satisfies policy.

## Next steps (in order)

1. Commit v3 with these corrections, marked experimental and gated.
2. A separate small commit: an accurate README/CLI warning, and removal of the production `QB_AGENT_COMMAND` override, with the injected test harness updated.
3. Executable reproductions of the two git attacks, reported as demonstrated defects, not passing regressions.
4. E1–E4 on Linux + Docker, recording versions, commands, sanitised output and pass/fail per criterion.
5. Finalise the sandbox implementation and release gates from those results.

A documentation commit or draft PR is fine. Publishing a supported beta remains gated.
