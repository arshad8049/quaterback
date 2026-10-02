#!/usr/bin/env bash
# QB-02 experiment E4: lifecycle (docs/security/agent-sandbox.md §1 G5, §8.3, §11.1).
#
# Runs the §8.3 supervisor protocol (prototype in ./proto) against real Docker
# and demonstrates, with measured times:
#   1. SIGKILL of the QB CLI still ends in bounded termination and cleanup.
#   2. A payload that disables its own in-container timeout cannot defeat the
#      external deadline (the CLI keeps renewing the lease the whole time).
#   3. Child, background, setsid and nohup processes do not survive termination.
#   4. Supervisor failure has a defined outcome: CLI recovery (supervisor_lost),
#      both dead → next-start reaper, supervisor never ready → nothing created.
#   5. Cleanup removes containers, volumes and networks, and the recorded end
#      state is the expected one (exactly one terminal writer, PID-reuse safe).
#   Plus: a hung `docker` client cannot block enforcement forever.
#
# Valid evidence only on Linux x86_64 + Docker Engine.
# Usage: spikes/qb-02/e4-lifecycle/run.sh [results_dir]

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
P="$HERE/proto"
IMAGE="busybox:1.36.1"
RUN="e4-$(date -u +%Y%m%dT%H%M%SZ)-$$"
OUT="${1:-$HERE/results/$RUN}"
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
STATE="$OUT/runs"; mkdir -p "$STATE"
LOG="$OUT/raw.log"; TSV="$OUT/results.tsv"; TIM="$OUT/timings.tsv"
: > "$LOG"; printf 'id\tresult\tdetail\n' > "$TSV"
printf 'scenario\ttrigger\tstopped_after_ms\tclean_after_ms\tbound_ms\tend_state\n' > "$TIM"

export E4_RENEW_MS=1000 E4_LEASE_TIMEOUT_MS=5000 E4_KILL_GRACE_MS=3000 E4_DOCKER_OP_MS=10000 E4_READY_MS=10000 E4_IMAGE="$IMAGE"
LEASE=$E4_LEASE_TIMEOUT_MS GRACE=$E4_KILL_GRACE_MS DOP=$E4_DOCKER_OP_MS
SLACK=1500   # polling granularity of this harness (200 ms) + process start-up

log()    { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TSV"; log "RESULT $1 $2 — $3"; }
now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time*1000'; }
running_count() { docker ps -q --filter "label=qb.run=$1" --filter status=running | wc -l | tr -d ' '; }
resource_count() {
  echo $(( $(docker ps -aq --filter "label=qb.run=$1" | wc -l) + $(docker volume ls -q --filter "label=qb.run=$1" | wc -l) + $(docker network ls -q --filter "label=qb.run=$1" | wc -l) ))
}
wait_file() { local i; for i in $(seq 1 150); do [ -e "$1" ] && return 0; sleep 0.2; done; return 1; }
term_state() { node -e 'const t=require(process.argv[1]); console.log(`${t.state}/${t.actor}/${t.reason}`)' "$STATE/$1/terminal.json" 2>/dev/null || echo none; }
host_procs() { [ "$(uname -s)" = Linux ] && { pgrep -fc '^sleep 700[1-4]$' || true; } || echo NA; }

# poll_end <run-id> <t0_ms> → sets STOP_MS and CLEAN_MS (elapsed since t0; -1 if never within 90 s)
poll_end() {
  local id=$1 t0=$2 t i; STOP_MS=-1; CLEAN_MS=-1
  for i in $(seq 1 450); do
    t=$(now_ms)
    [ "$STOP_MS" = -1 ] && [ "$(running_count "$id")" = 0 ] && STOP_MS=$((t - t0))
    [ "$(resource_count "$id")" = 0 ] && { CLEAN_MS=$((t - t0)); [ "$STOP_MS" = -1 ] && STOP_MS=$CLEAN_MS; return; }
    sleep 0.2
  done
}

cleanup_all() {
  local c v n
  c=$(docker ps -a --filter "label=qb.run" --format '{{.ID}} {{.Label "qb.run"}}' | awk -v p="$RUN" 'index($2,p)==1 {print $1}')
  [ -n "$c" ] && docker rm -f $c >/dev/null 2>&1
  for n in $(docker network ls -q --filter label=qb.run); do
    docker network inspect -f '{{index .Labels "qb.run"}}' "$n" | grep -q "^$RUN" && docker network rm "$n" >/dev/null 2>&1
  done
  for v in $(docker volume ls -q --filter label=qb.run); do
    docker volume inspect -f '{{index .Labels "qb.run"}}' "$v" | grep -q "^$RUN" && docker volume rm -f "$v" >/dev/null 2>&1
  done
  pkill -f "$P/(cli|supervisor).js $STATE" 2>/dev/null
  return 0
}
trap cleanup_all EXIT

# --- payloads -----------------------------------------------------------------
# Evasive: disables its own in-container `timeout`, spawns background /
# double-forked / setsid / nohup children, ignores TERM/INT/HUP, runs forever.
# busybox `timeout` execs the program and leaves a watcher child named
# "timeout" behind; it runs as the same uid, so the payload simply kills it.
cat > "$OUT/payload-evasive.sh" <<'EOS'
echo start
( trap '' TERM; exec sleep 7001 ) &
( sh -c 'sleep 7002 &' & )
setsid sleep 7003 &
nohup sleep 7004 >/dev/null 2>&1 &
pkill -KILL -x timeout && echo "killed in-container timeout watcher"
trap '' TERM INT HUP
i=0; while :; do sleep 1; i=$((i+1)); echo "alive $i"; done
EOS
printf 'echo working; echo done > /v/work/result; exit 0\n' > "$OUT/payload-normal.sh"

# start_cli <scenario> <payload> <deadline_ms> <in_container_timeout_s> → sets CLI_PID
start_cli() {
  local id="$RUN-$1"
  node "$P/cli.js" "$STATE/$id" "$OUT/payload-$2.sh" "$3" "$4" >> "$OUT/cli-$1.log" 2>&1 &
  CLI_PID=$!
}
sup_pid() { cat "$STATE/$RUN-$1/supervisor.pid" 2>/dev/null; }
ack_ms()  {  # wall-clock ms of the supervisor's stage ack, from its event log
  node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse).find(e=>e.what==="stage_ack"); console.log(l?Date.parse(l.t):-1)' "$STATE/$RUN-$1/events.jsonl"
}
# enf_times <scenario> <t0_ms> → STOP_MS/CLEAN_MS from the supervisor's own record
# (enforcement start + kill duration; time of its cleanup event), relative to t0.
enf_times() {
  read -r STOP_MS CLEAN_MS < <(node -e '
    const fs=require("fs"), d=process.argv[1], t0=+process.argv[2];
    const e=JSON.parse(fs.readFileSync(d+"/enforcement.json","utf8"));
    const ev=fs.readFileSync(d+"/events.jsonl","utf8").trim().split("\n").map(JSON.parse)
      .filter(x=>x.who==="supervisor"&&x.what==="cleanup").pop();
    console.log(Date.parse(e.enforce_at)+e.kill_ms-t0, ev?Date.parse(ev.t)-t0:-1);
  ' "$STATE/$RUN-$1" "$2" 2>/dev/null || echo "-1 -1")
}
timing() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$@" >> "$TIM"; }
logs_of() { cat "$STATE/$RUN-$1/logs-$RUN-$1-agent.txt" 2>/dev/null; }
check_clean() {   # check_clean <scenario> <expected state/actor/reason prefix>
  local s=$1 want=$2 got left
  got=$(term_state "$RUN-$s"); left=$(resource_count "$RUN-$s")
  case "$got" in "$want"*) result "$s.end_state" PASS "recorded $got" ;;
                 *) result "$s.end_state" FAIL "expected $want, recorded $got" ;; esac
  [ "$left" = 0 ] && result "$s.cleanup" PASS "0 containers, volumes or networks left" \
                  || result "$s.cleanup" FAIL "$left resources left"
}

# ---------------------------------------------------------------- environment
EVIDENCE=yes
DOCKER_PLATFORM=$(docker version --format '{{.Server.Platform.Name}}' 2>/dev/null || echo unknown)
case "$DOCKER_PLATFORM" in *Desktop*) EVIDENCE=no ;; esac
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || EVIDENCE=no
docker pull -q "$IMAGE" >/dev/null || { log "cannot pull $IMAGE"; exit 2; }
{
  echo "run_id: $RUN"
  echo "date_utc: $(date -u +%FT%TZ)"
  echo "host: $(uname -s) $(uname -m), kernel $(uname -r)"
  [ -r /etc/os-release ] && echo "os: $(. /etc/os-release; echo "$PRETTY_NAME")"
  echo "docker_server: $(docker version --format '{{.Server.Version}}') ($DOCKER_PLATFORM)"
  echo "cgroup: $(docker info --format 'v{{.CgroupVersion}} / {{.CgroupDriver}}')"
  echo "node: $(node --version)"
  echo "image: $(docker image inspect -f '{{index .RepoDigests 0}}' "$IMAGE")"
  echo "timing_ms: renew=$E4_RENEW_MS lease_timeout=$LEASE kill_grace=$GRACE docker_op=$DOP harness_slack=$SLACK"
  echo "evidence: $EVIDENCE"
} > "$OUT/env.txt"
cat "$OUT/env.txt" >> "$LOG"

# ------------------------------------------------- S0: baseline normal completion
log "== S0 baseline: payload completes"
start_cli s0 normal 20000 30
wait "$CLI_PID"
poll_end "$RUN-s0" "$(now_ms)"
check_clean s0 "completed/supervisor"

# ------------------------------------------------- S1: SIGKILL the CLI
log "== S1 CLI SIGKILLed mid-stage (payload evasive, deadline far away)"
start_cli s1 evasive 120000 4
wait_file "$STATE/$RUN-s1/workload_started"; sleep 6     # past the 4 s in-container timeout
P_BEFORE=$(host_procs)
T0=$(now_ms); kill -9 "$CLI_PID"; log "S1 CLI killed"
poll_end "$RUN-s1" "$T0"
BOUND=$((LEASE + GRACE + DOP + SLACK))
timing s1 cli_sigkill "$STOP_MS" "$CLEAN_MS" "$BOUND" "$(term_state "$RUN-s1")"
[ "$STOP_MS" -ge 0 ] && [ "$STOP_MS" -le "$BOUND" ] \
  && result s1.bounded_termination PASS "all containers stopped ${STOP_MS} ms after CLI SIGKILL (bound ${BOUND} ms = lease ${LEASE} + grace ${GRACE} + docker_op ${DOP} + slack ${SLACK})" \
  || result s1.bounded_termination FAIL "stopped after ${STOP_MS} ms (bound ${BOUND} ms)"
[ "$CLEAN_MS" -ge 0 ] && result s1.bounded_cleanup OBSERVED "all resources removed ${CLEAN_MS} ms after CLI SIGKILL" \
                      || result s1.bounded_cleanup FAIL "resources still present after 90 s"
logs_of s1 | grep -q "alive 6" && result s1.in_container_timeout_defeated OBSERVED "payload killed its own 4 s timeout watcher and kept running; only the external lease ended it" \
                                || result s1.in_container_timeout_defeated ERROR "could not confirm the payload outlived its own timeout (see logs)"
P_AFTER=$(host_procs)
if [ "$P_BEFORE" = NA ]; then result s1.children SKIP "host process check needs Linux"
elif [ "$P_BEFORE" -ge 4 ] && [ "$P_AFTER" = 0 ]; then result s1.children PASS "$P_BEFORE child processes (bg, double-fork, setsid, nohup) visible from host before; 0 after"
else result s1.children FAIL "children before=$P_BEFORE after=$P_AFTER"; fi
check_clean s1 "ABANDONED/supervisor/lease_expired"

# ------------------------------------------------- S2: deadline vs disabled timeout
log "== S2 deadline: payload disables its timeout, CLI alive and renewing"
DEADLINE=8000
start_cli s2 evasive "$DEADLINE" 4
wait_file "$STATE/$RUN-s2/workload_started"; sleep 6
P_BEFORE=$(host_procs)
wait "$CLI_PID"
A=$(ack_ms s2); enf_times s2 "$A"
BOUND=$((DEADLINE + GRACE + DOP + SLACK)); EARLIEST=$((DEADLINE + GRACE - SLACK))
timing s2 stage_deadline "$STOP_MS" "$CLEAN_MS" "$BOUND" "$(term_state "$RUN-s2")"
if [ "$STOP_MS" -ge "$EARLIEST" ] && [ "$STOP_MS" -le "$BOUND" ]; then
  result s2.deadline_enforced PASS "stopped ${STOP_MS} ms after stage ack (deadline ${DEADLINE} + grace ${GRACE}; bound ${BOUND}) while the lease kept renewing"
else
  result s2.deadline_enforced FAIL "stopped ${STOP_MS} ms after ack; expected between ${EARLIEST} and ${BOUND}"
fi
logs_of s2 | grep -q "alive 6" && result s2.in_container_timeout_defeated OBSERVED "payload outlived its own 4 s timeout; only the external deadline stopped it" \
                                || result s2.in_container_timeout_defeated ERROR "could not confirm the payload outlived its own timeout"
P_AFTER=$(host_procs)
if [ "$P_BEFORE" = NA ]; then result s2.children SKIP "host process check needs Linux"
elif [ "$P_BEFORE" -ge 4 ] && [ "$P_AFTER" = 0 ]; then result s2.children PASS "$P_BEFORE child processes before; 0 after"
else result s2.children FAIL "children before=$P_BEFORE after=$P_AFTER"; fi
check_clean s2 "timeout/supervisor/stage_deadline"

# ------------------------------------------------- S4a: supervisor dies, CLI alive
log "== S4a supervisor SIGKILLed, CLI alive"
start_cli s4a evasive 120000 4
wait_file "$STATE/$RUN-s4a/workload_started"; sleep 2
T0=$(now_ms); kill -9 "$(sup_pid s4a)"; log "S4a supervisor killed"
poll_end "$RUN-s4a" "$T0"
BOUND=$((500 + DOP + SLACK))
timing s4a supervisor_sigkill "$STOP_MS" "$CLEAN_MS" "$BOUND" "$(term_state "$RUN-s4a")"
[ "$STOP_MS" -ge 0 ] && [ "$STOP_MS" -le "$BOUND" ] \
  && result s4a.cli_recovery PASS "CLI detected the dead supervisor and stopped everything in ${STOP_MS} ms (bound ${BOUND})" \
  || result s4a.cli_recovery FAIL "stopped after ${STOP_MS} ms (bound ${BOUND})"
wait "$CLI_PID" 2>/dev/null
check_clean s4a "infra_error/cli/supervisor_lost"

# ------------------------------------------------- S4b: both dead → reaper
log "== S4b CLI and supervisor both SIGKILLed; reaper at next start"
start_cli s4b evasive 120000 4
wait_file "$STATE/$RUN-s4b/workload_started"; sleep 2
kill -9 "$(sup_pid s4b)" "$CLI_PID"; log "S4b both killed"
sleep 10
STILL=$(running_count "$RUN-s4b")
result s4b.unbounded_until_restart OBSERVED "${STILL} container(s) still running 10 s after both died: with no enforcer alive, termination waits for the next QB start (documented residual, G5b)"
T0=$(now_ms)
node "$P/reaper.js" "$STATE" "$RUN-s4b" >> "$LOG" 2>&1
poll_end "$RUN-s4b" "$T0"
timing s4b reaper "$STOP_MS" "$CLEAN_MS" "-" "$(term_state "$RUN-s4b")"
result s4b.reaper OBSERVED "reaper stopped everything ${STOP_MS} ms and removed it ${CLEAN_MS} ms after it started"
check_clean s4b "ABANDONED/reaper/owners_dead"

# ------------------------------------------------- S4c: supervisor never ready
log "== S4c supervisor never becomes ready"
E4_SUP_NO_READY=1 node "$P/cli.js" "$STATE/$RUN-s4c" "$OUT/payload-normal.sh" 20000 30 >> "$OUT/cli-s4c.log" 2>&1
CODE=$?
CREATED=$(node -e 'console.log(require(process.argv[1]).created_resources)' "$STATE/$RUN-s4c/run.json")
SP=$(sup_pid s4c); SUP_GONE=yes; kill -0 "$SP" 2>/dev/null && SUP_GONE=no
if [ "$CODE" = 3 ] && [ "$CREATED" = false ] && [ "$(resource_count "$RUN-s4c")" = 0 ] && [ "$SUP_GONE" = yes ]; then
  result s4c.no_resources PASS "CLI gave up after the readiness timeout, killed the supervisor, created no Docker resources"
else
  result s4c.no_resources FAIL "exit=$CODE created_resources=$CREATED resources=$(resource_count "$RUN-s4c") supervisor_gone=$SUP_GONE"
fi
check_clean s4c "infra_error/cli/supervisor_not_ready"

# ------------------------------------------------- S8: hung docker client
log "== S8 first 'docker kill' hangs; enforcement must continue after docker_op timeout"
mkdir -p "$OUT/stub"
cat > "$OUT/stub/docker" <<EOS
#!/usr/bin/env bash
if [ "\$1" = kill ] && [ ! -e "$OUT/stub/hung-once" ]; then touch "$OUT/stub/hung-once"; exec sleep 60; fi
exec $(command -v docker) "\$@"
EOS
chmod +x "$OUT/stub/docker"
DEADLINE=6000
E4_DOCKER="$OUT/stub/docker" node "$P/cli.js" "$STATE/$RUN-s8" "$OUT/payload-evasive.sh" "$DEADLINE" 4 >> "$OUT/cli-s8.log" 2>&1
A=$(ack_ms s8); enf_times s8 "$A"
BOUND=$((DEADLINE + GRACE + 2 * DOP + SLACK))
timing s8 hung_docker "$STOP_MS" "$CLEAN_MS" "$BOUND" "$(term_state "$RUN-s8")"
HUNG=$(grep -c '"timedOut":true' "$STATE/$RUN-s8/events.jsonl" 2>/dev/null); HUNG=${HUNG:-0}
if [ "$HUNG" -ge 1 ] && [ "$STOP_MS" -ge 0 ] && [ "$STOP_MS" -le "$BOUND" ]; then
  result s8.hung_docker PASS "first docker kill hung and was killed after ${DOP} ms; retry stopped everything ${STOP_MS} ms after ack (bound ${BOUND})"
else
  result s8.hung_docker FAIL "timed-out docker ops seen=$HUNG; stopped ${STOP_MS} ms after ack (bound ${BOUND})"
fi
check_clean s8 "timeout/supervisor/stage_deadline"

# ------------------------------------------------- S6: single terminal writer
log "== S6 two writers commit different terminal states at the same instant (200 rounds)"
R=$(node "$P/terminal-race.js" "$OUT/race" 200); echo "$R" >> "$LOG"; rm -rf "$OUT/race"
node -e 'const r=JSON.parse(process.argv[1]); process.exit(r.exactly_one_winner===r.rounds?0:1)' "$R" \
  && result s6.single_terminal_writer PASS "exactly one winner and a matching file in every round: $R" \
  || result s6.single_terminal_writer FAIL "$R"

# ------------------------------------------------- S7: PID reuse
log "== S7 a live process with the recorded pid but a different start time is not the owner"
sleep 300 & DECOY=$!
mkdir -p "$STATE/$RUN-s7a" "$STATE/$RUN-s7b"
node -e '
  const C=require(process.argv[1]); const fs=require("fs"); const pid=+process.argv[2];
  const real=C.identity(pid), fake={pid, start:"not-" + real.start};
  fs.writeFileSync(process.argv[3]+"/run.json", JSON.stringify({cli:fake, supervisor:fake}));
  fs.writeFileSync(process.argv[4]+"/run.json", JSON.stringify({cli:real, supervisor:real}));
' "$P/common.js" "$DECOY" "$STATE/$RUN-s7a" "$STATE/$RUN-s7b"
D1=$(node "$P/reaper.js" "$STATE" "$RUN-s7a"); D2=$(node "$P/reaper.js" "$STATE" "$RUN-s7b")
echo "$D1"$'\n'"$D2" >> "$LOG"
kill "$DECOY" 2>/dev/null
case "$D1$D2" in *'"decision":"reaped"'*'"decision":"owner_alive"'*)
  result s7.pid_reuse PASS "same pid + different start time → reaped; same pid + same start time → left alone" ;;
  *) result s7.pid_reuse FAIL "decisions: $D1 / $D2" ;; esac

# ------------------------------------------------------------ summary
for d in "$STATE"/*; do [ -d "$d" ] && rm -f "$d"/*.tmp-* ; done
{
  echo "# E4 lifecycle results"
  echo; echo '```'; cat "$OUT/env.txt"; echo '```'
  [ "$EVIDENCE" = yes ] || echo -e "\n> **NOT EVIDENCE**: not Linux x86_64 + Docker Engine. Debug run only.\n"
  echo; echo "## Measured times (ms)"; echo
  echo "| Scenario | Trigger | Stopped after | Cleaned after | Bound | End state |"; echo "|---|---|---|---|---|---|"
  tail -n +2 "$TIM" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6}'
  echo; echo "Stopped/Cleaned: S1, S4a measured live by this harness from the SIGKILL; S2, S8 from the supervisor's stage ack, using the supervisor's recorded kill and cleanup times (independently checked: 0 resources left); S4b from the reaper start."
  echo; echo "## Checks"; echo
  echo "| Check | Result | Detail |"; echo "|---|---|---|"
  tail -n +2 "$TSV" | awk -F'\t' '{printf "| %s | %s | %s |\n",$1,$2,$3}'
  echo; echo "Raw: raw.log, cli-*.log, runs/<run>/ (events.jsonl, terminal.json, enforcement.json, logs-*.txt, state-*.json)"
} > "$OUT/results.md"
log "results: $OUT/results.md"
grep -qE $'\t(FAIL|ERROR)\t' "$TSV" && exit 1 || exit 0
