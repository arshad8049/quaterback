# QB-02 sandbox experiments (E1–E4)

These are the gating experiments in [`docs/security/agent-sandbox.md`](../../docs/security/agent-sandbox.md) §11.1. Each one is a small script that records environment versions, raw output, and PASS / FAIL / OBSERVED / ERROR per criterion.

| Exp | Question | Where it runs | Status |
|---|---|---|---|
| E1 auth | Does subscription auth work with per-run copies and no write-back? | Your machine: needs a real `claude` login | not started |
| E2 storage | Do tmpfs volumes persist across stages? Keeper or not? Do caps hold? | CI `qb02-spikes` on `ubuntu-24.04` | script ready |
| E3 networking | Socket-only egress; do the Squid ACLs hold; does the checked IP equal the connected IP? | CI | not started |
| E4 lifecycle | Is the run still killed and cleaned up after QB dies and the timeout is disabled? | CI | not started |

## Evidence rules

- Only **Linux x86_64 + Docker Engine** counts. Runs anywhere else, such as Docker Desktop, mark themselves `evidence: no` and are for debugging scripts only.
- **ERROR** means the experiment itself didn't run cleanly, e.g. Docker refused to start a container. It is never read as a result. Only exit 0 (intact) and 3 (sentinels missing) count for the E2 sequences.
- `NOT_TESTABLE` marks criteria that need QB code that doesn't exist yet (e.g. admission). The measured inputs are still recorded.
- Reviewed results are committed under `<exp>/results/<run_id>/` (`env.txt`, `results.md`, `raw.log`) and linked from the design doc and KAN-2.

## Running E2

In CI: pushing a change under `spikes/qb-02/` runs it on `ubuntu-24.04`. Once the workflow is on `main`, it can also be started from *Actions → qb02-spikes → Run workflow*. Results appear in the job summary and as an artifact.

Locally, for debugging only: `QB_SPIKE_SKIP_RESTART=1 spikes/qb-02/e2-storage/run.sh /tmp/e2`.
