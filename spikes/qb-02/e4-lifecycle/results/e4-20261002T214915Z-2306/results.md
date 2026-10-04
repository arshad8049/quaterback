# E4 lifecycle results

```
run_id: e4-20261002T214915Z-2306
date_utc: 2026-10-02T21:49:16Z
host: Linux x86_64, kernel 6.17.0-1022-azure
os: Ubuntu 24.04.5 LTS
docker_server: 28.0.4 (Docker Engine - Community)
cgroup: v2 / systemd
node: v22.23.3
image: busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
timing_ms: renew=1000 lease_timeout=5000 kill_grace=3000 docker_op=10000 harness_slack=1500
evidence: yes
```

## Measured times (ms)

| Scenario | Trigger | Stopped after | Cleaned after | Bound | End state |
|---|---|---|---|---|---|
| s1 | cli_sigkill | 7565 | 8102 | 19500 | ABANDONED/supervisor/lease_expired |
| s2 | stage_deadline | 11143 | 11445 | 22500 | timeout/supervisor/stage_deadline |
| s4a | supervisor_sigkill | 540 | 812 | 12000 | infra_error/cli/supervisor_lost |
| s4b | reaper | 460 | 460 | - | ABANDONED/reaper/owners_dead |
| s8 | hung_docker | 19391 | 19734 | 30500 | timeout/supervisor/stage_deadline |

Stopped/Cleaned: S1, S4a measured live by this harness from the SIGKILL; S2, S8 from the supervisor's stage ack, using the supervisor's recorded kill and cleanup times (independently checked: 0 resources left); S4b from the reaper start.

## Checks

| Check | Result | Detail |
|---|---|---|
| s0.end_state | PASS | recorded completed/supervisor/cli_proposal:exit=0 oom=false |
| s0.cleanup | PASS | 0 containers, volumes or networks left |
| s1.bounded_termination | PASS | all containers stopped 7565 ms after CLI SIGKILL (bound 19500 ms = lease 5000 + grace 3000 + docker_op 10000 + slack 1500) |
| s1.bounded_cleanup | OBSERVED | all resources removed 8102 ms after CLI SIGKILL |
| s1.in_container_timeout_defeated | OBSERVED | payload killed its own 4 s timeout watcher and kept running; only the external lease ended it |
| s1.children | FAIL | children before=3 after=0 |
| s1.end_state | PASS | recorded ABANDONED/supervisor/lease_expired |
| s1.cleanup | PASS | 0 containers, volumes or networks left |
| s2.deadline_enforced | PASS | stopped 11143 ms after stage ack (deadline 8000 + grace 3000; bound 22500) while the lease kept renewing |
| s2.in_container_timeout_defeated | OBSERVED | payload outlived its own 4 s timeout; only the external deadline stopped it |
| s2.children | FAIL | children before=3 after=0 |
| s2.end_state | PASS | recorded timeout/supervisor/stage_deadline |
| s2.cleanup | PASS | 0 containers, volumes or networks left |
| s4a.cli_recovery | PASS | CLI detected the dead supervisor and stopped everything in 540 ms (bound 12000) |
| s4a.end_state | PASS | recorded infra_error/cli/supervisor_lost |
| s4a.cleanup | PASS | 0 containers, volumes or networks left |
| s4b.unbounded_until_restart | OBSERVED | 3 container(s) still running 10 s after both died: with no enforcer alive, termination waits for the next QB start (documented residual, G5b) |
| s4b.reaper | OBSERVED | reaper stopped everything 460 ms and removed it 460 ms after it started |
| s4b.end_state | PASS | recorded ABANDONED/reaper/owners_dead |
| s4b.cleanup | PASS | 0 containers, volumes or networks left |
| s4c.no_resources | PASS | CLI gave up after the readiness timeout, killed the supervisor, created no Docker resources |
| s4c.end_state | PASS | recorded infra_error/cli/supervisor_not_ready |
| s4c.cleanup | PASS | 0 containers, volumes or networks left |
| s8.hung_docker | PASS | first docker kill hung and was killed after 10000 ms; retry stopped everything 19391 ms after ack (bound 30500) |
| s8.end_state | PASS | recorded timeout/supervisor/stage_deadline |
| s8.cleanup | PASS | 0 containers, volumes or networks left |
| s6.single_terminal_writer | PASS | exactly one winner and a matching file in every round: {"rounds":200,"exactly_one_winner":200,"violations":[]} |
| s7.pid_reuse | PASS | same pid + different start time → reaped; same pid + same start time → left alone |

Raw: raw.log, cli-*.log, runs/<run>/ (events.jsonl, terminal.json, enforcement.json, logs-*.txt, state-*.json)
