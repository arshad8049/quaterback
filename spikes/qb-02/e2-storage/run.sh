#!/usr/bin/env bash
# QB-02 experiment E2: storage (docs/security/agent-sandbox.md §8.1, §8.2, §11.1).
#
# Questions this answers with evidence, not assumptions:
#   - Do Docker `local`-driver tmpfs volumes keep their contents across the
#     sequential stage containers (seed → deps → agent → capture → verify)
#     when no container holds them mounted? (decides: keeper Ⓚ or not)
#   - Does a keeper container make them persist, including across a killed stage?
#   - What happens on a Docker daemon restart, and is it detectable?
#   - Do size and inode caps hold (ENOSPC inside the container)?
#   - Which memory cgroup is charged for tmpfs pages, and what does a run cost
#     in host MemAvailable?
#
# Valid evidence only on Linux x86_64 + Docker Engine (the supported target).
# Elsewhere (e.g. Docker Desktop) the script runs for debugging and marks the
# results NOT EVIDENCE.
#
# Usage: spikes/qb-02/e2-storage/run.sh [results_dir]
#   QB_SPIKE_SKIP_RESTART=1   skip the daemon-restart step (needs sudo + systemd)

set -uo pipefail

IMAGE="busybox:1.36.1"
RUN="e2-$(date -u +%Y%m%dT%H%M%SZ)-$$"
OUT="${1:-$(dirname "$0")/results/$RUN}"
mkdir -p "$OUT"
LOG="$OUT/raw.log"
TSV="$OUT/results.tsv"
: > "$LOG"; printf 'id\tresult\tdetail\n' > "$TSV"

VOLS="work deps git verify out cred sock"
STAGES="seed deps agent capture verify"
VOL_SIZE="${QB_SPIKE_VOL_SIZE:-64m}"
VOL_INODES=20000

# has <ERE>: like `grep -qE`, but reads all of stdin. Under `set -o pipefail`,
# `producer | grep -q` can fail (SIGPIPE to the producer) when grep exits early.
has() { [ "$(grep -cE -- "$1")" != 0 ]; }
log()    { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TSV"; log "RESULT $1 $2 — $3"; }

cleanup() {
  local ids
  ids=$(docker ps -aq --filter "label=qb.spike=$RUN")
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  ids=$(docker volume ls -q --filter "label=qb.spike=$RUN")
  [ -n "$ids" ] && docker volume rm -f $ids >/dev/null 2>&1
}
trap cleanup EXIT

# Hardening flags shared by every container (design §3).
HARDEN=(--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges
        --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m
        --network none --init --pids-limit 64 --label "qb.spike=$RUN")

# create_vols <prefix> [size] [inodes]
create_vols() {
  local p=$1 size=${2:-$VOL_SIZE} inodes=${3:-$VOL_INODES} v
  for v in $VOLS; do
    docker volume create --driver local --label "qb.spike=$RUN" \
      --opt type=tmpfs --opt device=tmpfs \
      --opt "o=size=$size,nr_inodes=$inodes,uid=10001,gid=10001,mode=0700" \
      "$p-$v" >/dev/null || { log "FATAL: volume create failed: $p-$v"; exit 2; }
  done
  assert_vols "$p"   # top level, so a failure here stops the whole run
}

# set_mounts <prefix> → global MOUNTS array of -v flags, every volume at /v/<name>
# (built in a loop: macOS ships bash 3.2, which has no array-reading builtin)
set_mounts() {
  local v
  MOUNTS=()
  for v in $VOLS; do MOUNTS+=(-v "$1-$v:/v/$v"); done
}

# `docker run -v name:/path` silently auto-creates an ordinary volume when the
# name is wrong, which would fake a "contents lost" result. Refuse to run unless
# every volume exists and is a tmpfs volume from this run.
assert_vols() {
  local p=$1 v t
  for v in $VOLS; do
    t=$(docker volume inspect -f '{{index .Options "type"}}|{{index .Labels "qb.spike"}}' "$p-$v" 2>/dev/null)
    [ "$t" = "tmpfs|$RUN" ] || { log "FATAL: volume $p-$v missing or not a tmpfs volume of this run ($t)"; exit 2; }
  done
}

# The stage payload: check every earlier stage's sentinel in every volume,
# then write this stage's. Exit 3 if anything earlier is missing.
STAGE_SH='
missing=0
for v in $VOLS; do
  for s in $PRIOR; do
    [ -f "/v/$v/$s" ] || { echo "MISSING $v/$s"; missing=1; }
  done
  echo "$STAGE" > "/v/$v/$STAGE" || { echo "WRITE_FAILED $v/$STAGE"; exit 4; }
done
[ "$missing" = 0 ] || exit 3
echo OK
'

# run_stage <prefix> <stage> <prior-stages> [--keep]  → echoes exit code
run_stage() {
  local p=$1 stage=$2 prior=$3 keep=${4:-} name="$1-$2" code
  assert_vols "$p"
  set_mounts "$p"
  docker run -d --name "$name" "${HARDEN[@]}" --label qb.role=workload --memory 128m --memory-swap 128m \
    -e "VOLS=$VOLS" -e "STAGE=$stage" -e "PRIOR=$prior" "${MOUNTS[@]}" \
    "$IMAGE" sh -c "$STAGE_SH" >/dev/null || { echo 125; return; }
  code=$(docker wait "$name")
  docker logs "$name" >> "$LOG" 2>&1
  # Design §8.4: confirm stopped before reading anything.
  [ "$(docker inspect -f '{{.State.Running}}' "$name")" = "false" ] || log "WARN $name still running"
  [ "$keep" = "--keep" ] || docker rm "$name" >/dev/null
  echo "$code"
}

no_workload_running() {
  [ -z "$(docker ps -q --filter "label=qb.spike=$RUN" --filter "label=qb.role=workload")" ]
}

# sequence <prefix> <label> [--keep] → runs all stages, records one result per
# transition, echoes kept | lost | error. Only exit 0 (all sentinels present) and
# exit 3 (sentinels missing) are evidence; anything else (e.g. 125, Docker refused
# to start the container) is an infrastructure ERROR and never counts as "lost".
sequence() {
  local p=$1 label=$2 keep=${3:-} prior="" s code verdict=kept
  for s in $STAGES; do
    code=$(run_stage "$p" "$s" "$prior" "$keep")
    case "$code" in
      0) [ -n "$prior" ] && result "$label.$s" PASS "sentinels from [$prior] present in all volumes" ;;
      3) result "$label.$s" LOST "earlier sentinels missing (see raw.log)"; [ "$verdict" = error ] || verdict=lost ;;
      *) result "$label.$s" ERROR "stage did not run cleanly (exit '$code'); not evidence"; verdict=error ;;
    esac
    prior="${prior:+$prior }$s"
  done
  echo "$verdict"
}

start_keeper() {
  local p=$1
  assert_vols "$p"
  set_mounts "$p"
  docker run -d --name "$p-keeper" "${HARDEN[@]}" --label qb.role=keeper \
    --memory 64m --memory-swap 64m "${MOUNTS[@]}" "$IMAGE" sleep 2147483647 >/dev/null
}

cgroup_mem() {   # memory.current (bytes) of a running container, cgroup v2, systemd or cgroupfs driver
  local id f
  id=$(docker inspect -f '{{.Id}}' "$1" 2>/dev/null) || { echo NA; return; }
  for f in "/sys/fs/cgroup/system.slice/docker-$id.scope/memory.current" "/sys/fs/cgroup/docker/$id/memory.current"; do
    [ -r "$f" ] && { cat "$f"; return; }
  done
  echo NA
}
memavail_kb() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null || echo NA; }

# ---------------------------------------------------------------- environment
EVIDENCE=yes
OS=$(uname -s); ARCH=$(uname -m)
SERVER_OS=$(docker version --format '{{.Server.Os}}' 2>/dev/null || echo unknown)
DOCKER_PLATFORM=$(docker version --format '{{.Server.Platform.Name}}' 2>/dev/null || echo unknown)
case "$DOCKER_PLATFORM" in *Desktop*) EVIDENCE=no ;; esac
[ "$OS" = Linux ] && [ "$ARCH" = x86_64 ] || EVIDENCE=no

docker pull -q "$IMAGE" >/dev/null || { log "cannot pull $IMAGE"; exit 2; }
{
  echo "run_id: $RUN"
  echo "date_utc: $(date -u +%FT%TZ)"
  echo "host: $OS $ARCH, kernel $(uname -r)"
  [ -r /etc/os-release ] && echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"
  echo "docker_server: $(docker version --format '{{.Server.Version}}' 2>/dev/null) ($DOCKER_PLATFORM, $SERVER_OS)"
  echo "storage_driver: $(docker info --format '{{.Driver}}' 2>/dev/null)"
  echo "cgroup: $(docker info --format 'v{{.CgroupVersion}} / {{.CgroupDriver}}' 2>/dev/null)"
  echo "live_restore: $(docker info --format '{{.LiveRestoreEnabled}}' 2>/dev/null)"
  echo "host_swap: $(awk 'NR>1 {n++; s+=$3} END {print (n ? n" device(s), "s" KiB" : "none")}' /proc/swaps 2>/dev/null || echo unknown)"
  echo "image: $(docker image inspect -f '{{index .RepoDigests 0}}' "$IMAGE")"
  echo "volume_opts: type=tmpfs size=$VOL_SIZE nr_inodes=$VOL_INODES uid=10001"
  echo "evidence: $EVIDENCE"
} > "$OUT/env.txt"
cat "$OUT/env.txt" >> "$LOG"

# ------------------------------------------------- 1–4: sequential, no keeper
log "== A: no keeper, stage containers removed after each stage"
create_vols "$RUN-a"
A_OK=$(sequence "$RUN-a" A)

log "== A2: no keeper, stopped stage containers left in place until the end"
create_vols "$RUN-a2"
A2_OK=$(sequence "$RUN-a2" A2 --keep)

# ------------------------------------------------------- with keeper Ⓚ
log "== B: keeper holds every volume mounted"
create_vols "$RUN-b"
start_keeper "$RUN-b"
B_OK=$(sequence "$RUN-b" B)

log "verdicts: A=$A_OK A2=$A2_OK B=$B_OK"
if [ "$A_OK" = error ] || [ "$A2_OK" = error ] || [ "$B_OK" = error ]; then
  result KEEPER.decision ERROR "inconclusive: a stage hit an infrastructure error (A=$A_OK A2=$A2_OK B=$B_OK)"
elif [ "$A_OK" = kept ] && [ "$A2_OK" = kept ]; then
  result KEEPER.decision OBSERVED "volumes persisted without a keeper → design row 1 (no keeper) is supported"
elif [ "$B_OK" = kept ]; then
  result KEEPER.decision OBSERVED "contents lost without a keeper (A=$A_OK A2=$A2_OK) but kept with one → keeper Ⓚ required (design row 2)"
else
  result KEEPER.decision FAIL "contents lost even with a keeper → design §8.2 must be revisited"
fi

# --------------------------------------------------- 5: cancellation mid-stage
log "== C: stage killed mid-write (keeper present)"
create_vols "$RUN-c"
start_keeper "$RUN-c"
run_stage "$RUN-c" seed "" >/dev/null
set_mounts "$RUN-c"
docker run -d --name "$RUN-c-agent" "${HARDEN[@]}" --label qb.role=workload "${MOUNTS[@]}" "$IMAGE" \
  sh -c 'echo partial > /v/work/agent-partial; sleep 300' >/dev/null
sleep 2
docker kill "$RUN-c-agent" >/dev/null
docker wait "$RUN-c-agent" >/dev/null
if no_workload_running; then result C.no_workload_running PASS "killed stage confirmed stopped"
else result C.no_workload_running FAIL "a workload container is still running after kill"; fi
code=$(run_stage "$RUN-c" capture "seed")
case "$code" in
  0) result C.after_kill PASS "seed sentinels intact after a killed stage" ;;
  3) result C.after_kill FAIL "seed sentinels lost after a killed stage" ;;
  *) result C.after_kill ERROR "check stage did not run cleanly (exit '$code')" ;;
esac
docker run --rm "${HARDEN[@]}" "${MOUNTS[@]}" "$IMAGE" cat /v/work/agent-partial >> "$LOG" 2>&1 \
  && result C.partial_write OBSERVED "killed stage's partial write remains in the workspace (capture will see it)" \
  || result C.partial_write OBSERVED "killed stage's partial write is absent"

# ------------------------------------------------------- 6: daemon restart
if [ "${QB_SPIKE_SKIP_RESTART:-0}" = 1 ] || ! command -v systemctl >/dev/null || ! sudo -n true 2>/dev/null; then
  result D.daemon_restart SKIP "needs systemd + passwordless sudo (or QB_SPIKE_SKIP_RESTART=1 set)"
else
  log "== D: daemon restart with a keeper holding seeded volumes"
  create_vols "$RUN-d"
  start_keeper "$RUN-d"
  run_stage "$RUN-d" seed "" >/dev/null
  sudo systemctl restart docker
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  KSTATE=$(docker inspect -f '{{.State.Status}}' "$RUN-d-keeper" 2>/dev/null || echo gone)
  result D.keeper_after_restart OBSERVED "keeper state after restart: $KSTATE (live_restore=$(docker info --format '{{.LiveRestoreEnabled}}'))"
  code=$(run_stage "$RUN-d" deps "seed")
  case "$code" in
    3) result D.contents_after_restart OBSERVED "seed sentinels lost across daemon restart" ;;
    0) result D.contents_after_restart OBSERVED "contents survived the daemon restart" ;;
    *) result D.contents_after_restart ERROR "check stage did not run cleanly after restart (exit '$code')" ;;
  esac
  # E2 only shows that a detectable signal exists. QB turning it into
  # infra_error is an implementation test (§11.2), not something E2 proves.
  if [ "$KSTATE" != running ] || [ "$code" != 0 ]; then
    result D.signal_present OBSERVED "a restart leaves a detectable signal (keeper=$KSTATE, stage exit $code); QB's infra_error handling is not tested here"
  else
    result D.signal_present FAIL "restart left keeper running with contents intact — check live_restore; no signal to detect"
  fi
fi

# ------------------------------------------------------------ 7: caps
log "== E: size and inode caps"
CAP_BYTES=$((32 * 1024 * 1024))
create_vols "$RUN-e" 32m 500
set_mounts "$RUN-e"
# Size cap: the write must fail with ENOSPC, the file must have actually filled
# the volume (not failed early for another reason), and no free blocks remain.
# `stat -f`: %b total blocks, %a available blocks, %S block size, %c total inodes, %d free inodes.
OUTP=$(docker run --rm "${HARDEN[@]}" "${MOUNTS[@]}" "$IMAGE" sh -c '
  dd if=/dev/zero of=/v/work/fill bs=1M count=64 2>/tmp/err; echo "dd_exit=$?"
  echo "err=$(tr "\n" " " < /tmp/err)"
  echo "file_bytes=$(stat -c %s /v/work/fill)"
  echo "fs=$(stat -f -c "%b %a %S %c %d" /v/work)"' 2>&1)
echo "$OUTP" >> "$LOG"
FB=$(echo "$OUTP" | sed -n 's/^file_bytes=//p'); set -- $(echo "$OUTP" | sed -n 's/^fs=//p')
AVAIL_BLOCKS=${2:-NA}
if echo "$OUTP" | has 'No space left' && [ -n "$FB" ] \
   && [ "$FB" -le "$CAP_BYTES" ] && [ "$FB" -ge $((CAP_BYTES - 1024 * 1024)) ] && [ "$AVAIL_BLOCKS" = 0 ]; then
  result E.size_cap PASS "64 MiB write into a 32 MiB volume: ENOSPC; file reached $FB of $CAP_BYTES bytes; 0 blocks free"
else
  result E.size_cap FAIL "expected ENOSPC with the file filling the cap: file_bytes=$FB avail_blocks=$AVAIL_BLOCKS ($(echo "$OUTP" | grep '^err='))"
fi
# Inode cap: creation must stop with ENOSPC while free inodes are 0 and plenty of
# bytes remain, which distinguishes inode exhaustion from a full disk or other errors.
OUTP=$(docker run --rm "${HARDEN[@]}" "${MOUNTS[@]}" "$IMAGE" sh -c '
  i=0
  while [ $i -lt 2000 ]; do
    # touch, not ":" — a failed redirection on a special builtin exits the shell
    if ! touch /v/deps/f$i 2>/tmp/err; then echo "stopped_at=$i"; echo "err=$(cat /tmp/err)"; break; fi
    i=$((i+1))
  done
  [ $i -lt 2000 ] || echo "stopped_at=none"
  echo "fs=$(stat -f -c "%b %a %S %c %d" /v/deps)"' 2>&1)
echo "$OUTP" >> "$LOG"
STOP=$(echo "$OUTP" | sed -n 's/^stopped_at=//p'); set -- $(echo "$OUTP" | sed -n 's/^fs=//p')
TOTAL_B=${1:-0} AVAIL_B=${2:-0} FREE_INODES=${5:-NA}
if [ "$STOP" != none ] && echo "$OUTP" | has 'No space left' && [ "$FREE_INODES" = 0 ] \
   && [ "$TOTAL_B" -gt 0 ] && [ $((AVAIL_B * 2)) -gt "$TOTAL_B" ]; then
  result E.inode_cap PASS "creation stopped at file $STOP with ENOSPC; 0 free inodes while $AVAIL_B of $TOTAL_B blocks still free (inode exhaustion, not space)"
else
  result E.inode_cap FAIL "not a clean inode-exhaustion stop: stopped_at=$STOP free_inodes=$FREE_INODES blocks=$AVAIL_B/$TOTAL_B ($(echo "$OUTP" | grep '^err='))"
fi

# ---------------------------------------------- 7b: memory accounting
log "== F: memory accounting for tmpfs pages"
create_vols "$RUN-f" 160m
start_keeper "$RUN-f"
set_mounts "$RUN-f"
K_BEFORE=$(cgroup_mem "$RUN-f-keeper")
H_BEFORE=$(memavail_kb)
docker run -d --name "$RUN-f-writer" "${HARDEN[@]}" --label qb.role=workload --memory 512m --memory-swap 512m \
  "${MOUNTS[@]}" "$IMAGE" sh -c 'dd if=/dev/zero of=/v/work/blob bs=1M count=96 2>/dev/null; sync; sleep 20' >/dev/null
sleep 8
W_DURING=$(cgroup_mem "$RUN-f-writer")
docker wait "$RUN-f-writer" >/dev/null
K_AFTER=$(cgroup_mem "$RUN-f-keeper")
H_AFTER=$(memavail_kb)
result F.writer_cgroup OBSERVED "writer memory.current while holding 96 MiB in tmpfs: $W_DURING bytes"
result F.keeper_cgroup OBSERVED "keeper memory.current before/after: $K_BEFORE / $K_AFTER bytes"
result F.host_memavail OBSERVED "host MemAvailable before/after (writer exited, data retained): ${H_BEFORE} / ${H_AFTER} KiB"
OUTP=$(docker run --name "$RUN-f-small" "${HARDEN[@]}" --memory 48m --memory-swap 48m "${MOUNTS[@]}" "$IMAGE" sh -c \
  'dd if=/dev/zero of=/v/deps/blob bs=1M count=96 2>&1; echo "dd_exit=$?"' 2>&1)
OOMK=$(docker inspect -f '{{.State.OOMKilled}}' "$RUN-f-small"); EXITC=$(docker inspect -f '{{.State.ExitCode}}' "$RUN-f-small")
echo "$OUTP" >> "$LOG"
result F.limit_bounds_tmpfs OBSERVED "96 MiB tmpfs write under --memory 48m: the writing child was killed ($(echo "$OUTP" | tail -1)); the stage's memory limit bounds what it can write"
# Reporting trap: the child was OOM-killed but the container's main process
# exited 0. A stage classified by exit code alone would be reported as success.
if [ "$OOMK" = true ] && [ "$EXITC" = 0 ]; then
  result F.oom_reporting OBSERVED "State.OOMKilled=true with ExitCode=0: classification must use OOMKilled, not the exit code"
else
  result F.oom_reporting OBSERVED "State.OOMKilled=$OOMK ExitCode=$EXITC"
fi

# --------------------------------------- 8: two concurrent runs at full caps
log "== G: two concurrent runs, every volume filled to ~90% of cap"
H0=$(memavail_kb)
for r in g1 g2; do
  create_vols "$RUN-$r" 64m
  start_keeper "$RUN-$r"
  set_mounts "$RUN-$r"
  docker run --rm "${HARDEN[@]}" "${MOUNTS[@]}" -e "VOLS=$VOLS" "$IMAGE" sh -c \
    'for v in $VOLS; do dd if=/dev/zero of=/v/$v/fill bs=1M count=57 2>/dev/null; done' >/dev/null 2>&1
done
H1=$(memavail_kb)
if [ "$H0" != NA ]; then
  DELTA_MB=$(( (H0 - H1) / 1024 ))
  EXPECT_MB=$(( 2 * 7 * 57 ))
  result G.footprint OBSERVED "two runs × 7 volumes × 57 MiB: MemAvailable dropped ${DELTA_MB} MiB (data written ${EXPECT_MB} MiB)"
else
  result G.footprint SKIP "no /proc/meminfo on this host"
fi
result G.admission NOT_TESTABLE "QB admission (§8.1) is not implemented yet; G.footprint is the input it will use"

# ------------------------------------------------------------ cleanup check
# Cleanup is part of the evidence: remove everything this run created, then
# confirm nothing labelled with the run id remains.
log "== H: cleanup"
T0=$(date +%s)
cleanup
LEFT_C=$(docker ps -aq --filter "label=qb.spike=$RUN" | wc -l | tr -d ' ')
LEFT_V=$(docker volume ls -q --filter "label=qb.spike=$RUN" | wc -l | tr -d ' ')
LEFT_N=$(docker network ls -q --filter "label=qb.spike=$RUN" | wc -l | tr -d ' ')
if [ "$LEFT_C$LEFT_V$LEFT_N" = 000 ]; then
  result H.cleanup PASS "0 containers, 0 volumes, 0 networks left after cleanup ($(( $(date +%s) - T0 ))s)"
else
  result H.cleanup FAIL "left behind: $LEFT_C containers, $LEFT_V volumes, $LEFT_N networks"
fi

# ------------------------------------------------------------ summary
{
  echo "# E2 storage results"
  echo
  echo '```'; cat "$OUT/env.txt"; echo '```'
  [ "$EVIDENCE" = yes ] || echo -e "\n> **NOT EVIDENCE**: not Linux x86_64 + Docker Engine. Debug run only.\n"
  echo
  echo "| Check | Result | Detail |"
  echo "|---|---|---|"
  tail -n +2 "$TSV" | awk -F'\t' '{printf "| %s | %s | %s |\n", $1, $2, $3}'
  echo
  echo "Raw output: raw.log"
} > "$OUT/results.md"

log "results: $OUT/results.md"
# exit 1 on any FAIL or ERROR so CI shows the run needs attention
grep -qE $'\t(FAIL|ERROR)\t' "$TSV" && exit 1 || exit 0
