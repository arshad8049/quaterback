# E2 storage results

```
run_id: e2-20261002T221147Z-2272
date_utc: 2026-10-02T22:11:48Z
host: Linux x86_64, kernel 6.17.0-1022-azure
os: Ubuntu 24.04.5 LTS
docker_server: 28.0.4 (Docker Engine - Community, linux)
storage_driver: overlay2
cgroup: v2 / systemd
live_restore: false
host_swap: 1 device(s), 3145724 KiB
image: busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662
volume_opts: type=tmpfs size=64m nr_inodes=20000 uid=10001
evidence: yes
```

| Check | Result | Detail |
|---|---|---|
| A.deps | LOST | earlier sentinels missing (see raw.log) |
| A.agent | LOST | earlier sentinels missing (see raw.log) |
| A.capture | LOST | earlier sentinels missing (see raw.log) |
| A.verify | LOST | earlier sentinels missing (see raw.log) |
| A2.deps | LOST | earlier sentinels missing (see raw.log) |
| A2.agent | LOST | earlier sentinels missing (see raw.log) |
| A2.capture | LOST | earlier sentinels missing (see raw.log) |
| A2.verify | LOST | earlier sentinels missing (see raw.log) |
| B.deps | PASS | sentinels from [seed] present in all volumes |
| B.agent | PASS | sentinels from [seed deps] present in all volumes |
| B.capture | PASS | sentinels from [seed deps agent] present in all volumes |
| B.verify | PASS | sentinels from [seed deps agent capture] present in all volumes |
| KEEPER.decision | OBSERVED | contents lost without a keeper (A=lost A2=lost) but kept with one → keeper Ⓚ required (design row 2) |
| C.no_workload_running | PASS | killed stage confirmed stopped |
| C.after_kill | PASS | seed sentinels intact after a killed stage |
| C.partial_write | OBSERVED | killed stage's partial write remains in the workspace (capture will see it) |
| D.keeper_after_restart | OBSERVED | keeper state after restart: exited (live_restore=false) |
| D.contents_after_restart | OBSERVED | seed sentinels lost across daemon restart |
| D.signal_present | OBSERVED | a restart leaves a detectable signal (keeper=exited, stage exit 3); QB's infra_error handling is not tested here |
| E.size_cap | PASS | 64 MiB write into a 32 MiB volume: ENOSPC; file reached 33554432 of 33554432 bytes; 0 blocks free |
| E.inode_cap | PASS | creation stopped at file 499 with ENOSPC; 0 free inodes while 8192 of 8192 blocks still free (inode exhaustion, not space) |
| F.writer_cgroup | OBSERVED | writer memory.current while holding 96 MiB in tmpfs: 101986304 bytes |
| F.keeper_cgroup | OBSERVED | keeper memory.current before/after: 1069056 / 630784 bytes |
| F.host_memavail | OBSERVED | host MemAvailable before/after (writer exited, data retained): 15271484 / 15316752 KiB |
| F.limit_bounds_tmpfs | OBSERVED | 96 MiB tmpfs write under --memory 48m: the writing child was killed (dd_exit=137); the stage's memory limit bounds what it can write |
| F.oom_reporting | OBSERVED | State.OOMKilled=true with ExitCode=0: classification must use OOMKilled, not the exit code |
| G.footprint | OBSERVED | two runs × 7 volumes × 57 MiB: MemAvailable dropped 857 MiB (data written 798 MiB) |
| G.admission | NOT_TESTABLE | QB admission (§8.1) is not implemented yet; G.footprint is the input it will use |
| H.cleanup | PASS | 0 containers, 0 volumes, 0 networks left after cleanup (1s) |

Raw output: raw.log
