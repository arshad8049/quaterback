# QB-02 sandbox experiments (E1–E4)

These are the gating experiments in [`docs/security/agent-sandbox.md`](../../docs/security/agent-sandbox.md) §11.1. Each one is a small script that records environment versions, raw output, and PASS / FAIL / OBSERVED / ERROR per criterion.

| Exp | Question | Where it runs | Status |
|---|---|---|---|
| E1 auth | Does subscription auth work with per-run copies and no write-back? | Your machine: needs a real `claude` login | not started |
| E2 storage | Do tmpfs volumes persist across stages? Keeper or not? Do caps hold? | CI `qb02-spikes` on `ubuntu-24.04` **Done 2026-10-02.** [Run 2](e2-storage/results/e2-20261002T214917Z-2322/results.md) (stricter checks) passes; it supersedes [run 1](e2-storage/results/e2-20261002T183010Z-2325/results.md). Keeper required; caps hold; cleanup verified. Admission still pending (product). |
| E3 networking | Socket-only egress; do the Squid ACLs hold; does the checked IP equal the connected IP? | CI | script ready (Squid 6.13 + socket bridge, test resolver, internal canary); debug run 39/39; **Linux run pending** |
| E4 lifecycle | Is the run still killed and cleaned up after QB dies and the timeout is disabled? | CI | **Done 2026-10-02.** [Run 2](e4-lifecycle/results/e4-20261002T215833Z-2397/results.md) passes every check on Linux; it supersedes [run 1](e4-lifecycle/results/e4-20261002T214915Z-2306/results.md). Uses the §8.3 prototype. Not covered: wall-clock jump, Docker stopped mid-run (moved to T-LIFE). |

## Evidence rules

- Only **Linux x86_64 + Docker Engine** counts. Runs anywhere else, such as Docker Desktop, mark themselves `evidence: no` and are for debugging scripts only.
- **ERROR** means the experiment itself didn't run cleanly, e.g. Docker refused to start a container. It is never read as a result. Only exit 0 (intact) and 3 (sentinels missing) count for the E2 sequences.
- `NOT_TESTABLE` marks criteria that need QB code that doesn't exist yet (e.g. admission). The measured inputs are still recorded.
- Reviewed results are committed under `<exp>/results/<run_id>/` (`env.txt`, `results.md`, `raw.log`) and linked from the design doc and KAN-2.

## Running E2

In CI: pushing a change under `spikes/qb-02/` runs it on `ubuntu-24.04`. Once the workflow is on `main`, it can also be started from *Actions → qb02-spikes → Run workflow*. Results appear in the job summary and as an artifact.

Locally, for debugging only: `QB_SPIKE_SKIP_RESTART=1 spikes/qb-02/e2-storage/run.sh /tmp/e2`.

### E2 run 1 → run 2

Run 1's conclusions on persistence, the keeper and restart stand. Two of its checks were weaker than their PASS suggested, and run 2 replaces them:

- **Inode cap:** the loop used the shell builtin `:`, and a failed redirection on it exits the shell. So run 1 only showed that the run did not create all 2000 files. Run 2 requires ENOSPC, 0 free inodes, and most blocks still free.
- **Size cap:** run 1 only matched the ENOSPC message. Run 2 also requires the file to reach the cap and 0 free blocks.

Run 2 also adds the `OOMKilled`-with-exit-0 observation and a recorded cleanup check, and words the restart result as a detectable signal rather than proof of QB's `infra_error` handling.

## Running E4

`spikes/qb-02/e4-lifecycle/run.sh [results_dir]`. It uses a **prototype** of the §8.3 protocol in `e4-lifecycle/proto/`: a stand-in CLI, the detached supervisor and the next-start reaper. That is spike code for testing the protocol against real Docker, not the product implementation. Timings are shortened for CI (lease 5 s, grace 3 s, Docker op timeout 10 s) and recorded in `env.txt`. The child-process checks need Linux.

### E4 run 1 → run 2

Run 1 failed only `s1.children` and `s2.children`, with "before=3 after=0". No child survived, but the check could see only 3 of the 4 evasive children beforehand. busybox shows the double-forked child as `sh -c sleep 7002 &`, not `sleep 7002`, so the name pattern missed it. The child was there, reparented to the container's init.

Run 2 replaces the name match with a name-independent check. Every process in the container (host PID + start time) is snapshotted while it runs, and none may exist afterwards. All four children must still be seen beforehand, by a pattern that matches both forms.

## Running E3

`spikes/qb-02/e3-network/run.sh [results_dir]` builds two images:

- `proxy/`: `ubuntu/squid` with the §4.1 policy in `squid.conf`, plus a socat Unix-socket bridge.
- `client/`: alpine with curl, socat, dnsmasq and dig.

It then starts two per-run proxy networks, a test resolver (Squid's only resolver) and an internal canary. Every check runs from a `--network none` consumer that has the socket volume mounted read-only. Each command and its output is in `raw.log`. The canary's connection log (`canary-r0.log`) must stay empty.

Harness notes from the debug runs:

- **Fallback tunnel devices:** kernels with tunnel modules create devices like `tunl0` and `gre0` in every namespace. So "no external network interface" is checked as no routes except loopback and every non-lo device down, not "only `lo` exists". A container with a network fails this check.
- **`pipefail` and `grep -q`:** under `set -o pipefail`, `producer | grep -q` can report failure through SIGPIPE when grep exits early. In one E3 check that would have turned a real failure into a PASS. All three scripts now use a `has` helper that reads its whole input.

