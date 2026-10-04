#!/usr/bin/env bash
# QB-02 experiment E1: authentication (docs/security/agent-sandbox.md §5, §11.1).
#
# Runs on the developer's machine (needs a real Claude subscription login and
# Docker). Auth behaviour is server-side, so Docker Desktop is fine here.
#
#   run.sh login    one-time: official `claude auth login --claudeai` into the
#                   QB-scoped volume qb-e1-auth (never your ~/.claude)
#   run.sh probe    ~10 min of checks: required files, per-run copy → run →
#                   discard with no write-back, overwrite attack, concurrent
#                   runs with a pre-run refresh, and the auth lock
#   run.sh watch    unattended: every 15 min, copy → run → discard, until the
#                   access token has expired and been refreshed in-run, then
#                   tests whether the stored copy still works (refresh-token
#                   rotation) and the pre-run-refresh path
#   run.sh logout   official `claude auth logout`, then remove the volume
#
# Credential safety: no token is ever read or printed by this script. Files are
# described by credmeta.js inside a container: key names, expiry, and 12-char
# SHA-256 fingerprints only. Results are scanned for token-like strings before
# they are written; the run aborts if anything matches.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
IMG="qb-e1-claude"
AUTH_VOL="${E1_AUTH_VOL:-qb-e1-auth}"   # override only for harness self-tests
LOCKFILE="${TMPDIR:-/tmp}/qb-e1-auth.lock"
INTERVAL="${E1_INTERVAL_S:-900}"
MAX_HOURS="${E1_MAX_HOURS:-12}"
PROMPT='Reply with exactly the word OK and nothing else.'

has() { [ "$(grep -cE -- "$1")" != 0 ]; }

ENVS=(-e HOME=/tmp/home -e DISABLE_AUTOUPDATER=1 -e DISABLE_TELEMETRY=1 -e DISABLE_ERROR_REPORTING=1
      -e CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1)
HARDEN=(--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges --read-only
        --tmpfs /tmp:rw,size=64m,mode=1777 --label qb.spike=e1)

# ------------------------------------------------------------------ helpers
new_results() {
  RUN="e1-$1-$(date -u +%Y%m%dT%H%M%SZ)"
  OUT="$HERE/results/$RUN"; mkdir -p "$OUT"
  LOG="$OUT/raw.log"; TSV="$OUT/results.tsv"
  : > "$LOG"; printf 'id\tresult\tdetail\n' > "$TSV"
  {
    echo "run_id: $RUN"; echo "date_utc: $(date -u +%FT%TZ)"
    echo "host: $(uname -s) $(uname -m)"
    echo "docker_server: $(docker version --format '{{.Server.Version}}') ($(docker version --format '{{.Server.Platform.Name}}'))"
    echo "claude: $(docker run --rm "$IMG" claude --version)"
    echo "node: $(docker run --rm "$IMG" node --version)"
    echo "image_id: $(docker image inspect -f '{{.Id}}' "$IMG" | cut -c1-19)"
    echo "base: node:24-bookworm-slim"
    echo "network: default bridge (E1 tests auth lifecycle; egress policy is E3's)"
  } > "$OUT/env.txt"
}
log()    { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
result() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$TSV"; log "RESULT $1 $2 — $3"; }

need_image() { docker image inspect "$IMG" >/dev/null 2>&1 || docker build -q -t "$IMG" "$HERE/image" >/dev/null; }

# Volumes are created root-owned; a trusted init step hands them to uid 10001.
own_vol() { docker run --rm --user 0 -v "$1:/v" "$IMG" chown 10001:10001 /v; }

meta() {   # meta <volume> → credmeta JSON for its .credentials.json
  docker run --rm "${HARDEN[@]}" -v "$1:/c:ro" "$IMG" node /usr/local/bin/credmeta.js /c/.credentials.json
}
field() { node -e 'const j=JSON.parse(process.argv[1]); const v=j[process.argv[2]]; console.log(v==null?"":Array.isArray(v)?v.join(","):v)' "$1" "$2"; }

# make_copy <variant> → creates a per-run volume from the persistent one; echoes its name.
#   creds   .credentials.json only        creds+config   + .claude.json        full   whole dir
make_copy() {
  local v="qb-e1-run-$(date +%s)-$RANDOM" files
  docker volume create --label qb.spike=e1 "$v" >/dev/null; own_vol "$v"
  case "$1" in
    creds)        files='cp -p /src/.credentials.json /dst/' ;;
    creds+config) files='cp -p /src/.credentials.json /dst/; [ -f /src/.claude.json ] && cp -p /src/.claude.json /dst/; true' ;;
    full)         files='cp -a /src/. /dst/' ;;
  esac
  docker run --rm "${HARDEN[@]}" -v "$AUTH_VOL:/src:ro" -v "$v:/dst" "$IMG" sh -c "$files" >> "$LOG" 2>&1
  echo "$v"
}
drop() { docker volume rm -f "$1" >/dev/null 2>&1; }

# fixture <per-run volume> → runs one tiny prompt; echoes "rc ok" (ok=1 if the reply contains OK)
fixture() {
  local out rc
  out=$(docker run --rm "${HARDEN[@]}" "${ENVS[@]}" -e CLAUDE_CONFIG_DIR=/cfg -v "$1:/cfg" "$IMG" \
        timeout 180 claude -p "$PROMPT" --max-turns 1 2>&1); rc=$?
  printf -- '--- fixture on %s (rc=%s)\n%s\n' "$1" "$rc" "$(echo "$out" | tail -5)" >> "$LOG"
  echo "$rc $(echo "$out" | has '(^|[^A-Za-z])OK([^A-Za-z]|$)' && echo 1 || echo 0)"
}

lockrun()  { perl -MFcntl=:flock -e 'open(my $f,">>",shift) or die; flock($f,LOCK_EX) or die; system(@ARGV); exit($?>>8)' "$LOCKFILE" "$@"; }
locktry()  { perl -MFcntl=:flock -e 'open(my $f,">>",shift) or die; flock($f,LOCK_EX|LOCK_NB) or exit 75; system(@ARGV); exit($?>>8)' "$LOCKFILE" "$@"; }

# Pre-run refresh (§5.2 step 1): the official binary, in a clean auth container
# with no repository and no work volume, uses the persistent credential once and
# so refreshes it if it is near expiry. Always under the auth lock.
refresh_persistent() {
  docker run --rm "${HARDEN[@]}" "${ENVS[@]}" -e CLAUDE_CONFIG_DIR=/auth -v "$AUTH_VOL:/auth" "$IMG" \
    timeout 180 claude -p "$PROMPT" --max-turns 1 >> "$LOG" 2>&1
}

secret_scan() {   # refuse to keep results containing anything token-shaped
  if grep -rEl 'sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.|[A-Za-z0-9_-]{64,}' "$OUT" >/dev/null 2>&1; then
    local f; f=$(grep -rEl 'sk-ant-[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]{20,}\.|[A-Za-z0-9_-]{64,}' "$OUT")
    rm -rf "$OUT"
    echo "ABORTED: token-like content found in results ($f); results deleted, nothing kept." >&2
    exit 3
  fi
}

summarise() {
  secret_scan
  {
    echo "# E1 authentication results ($1)"; echo; echo '```'; cat "$OUT/env.txt"; echo '```'
    [ -f "$OUT/timeline.tsv" ] && { echo; echo "## Timeline"; echo
      echo "| time (UTC) | stored expires in (min) | run rc | reply OK | refreshed in-run | refresh token rotated | stored copy changed |"
      echo "|---|---|---|---|---|---|---|"
      tail -n +2 "$OUT/timeline.tsv" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6,$7}'; }
    echo; echo "## Checks"; echo; echo "| Check | Result | Detail |"; echo "|---|---|---|"
    tail -n +2 "$TSV" | awk -F'\t' '{printf "| %s | %s | %s |\n",$1,$2,$3}'
    echo; echo "No credential value appears in these files: only key names, expiry and 12-char SHA-256 fingerprints (scanned before saving)."
  } > "$OUT/results.md"
  secret_scan
  log "results: $OUT/results.md"
}

# -------------------------------------------------------------- commands
cmd_login() {
  need_image
  docker volume inspect "$AUTH_VOL" >/dev/null 2>&1 || { docker volume create --label qb.spike=e1 "$AUTH_VOL" >/dev/null; own_vol "$AUTH_VOL"; }
  echo
  echo "Logging in with the official Claude Code binary (subscription) into Docker volume $AUTH_VOL."
  echo "Your normal ~/.claude login is not used or touched."
  echo "It will print a URL: open it in your browser, sign in, then paste the code back here."
  echo
  lockrun docker run --rm -it "${HARDEN[@]}" "${ENVS[@]}" -e CLAUDE_CONFIG_DIR=/auth -v "$AUTH_VOL:/auth" "$IMG" \
    claude auth login --claudeai
  docker run --rm "${HARDEN[@]}" "${ENVS[@]}" -e CLAUDE_CONFIG_DIR=/auth -v "$AUTH_VOL:/auth" "$IMG" \
    claude auth status --text 2>&1 | grep -iE 'logged|method|subscription' | head -5
}

cmd_probe() {
  need_image; new_results probe
  docker volume inspect "$AUTH_VOL" >/dev/null 2>&1 || { log "no $AUTH_VOL volume: run '$0 login' first"; exit 2; }

  # P1 — what the official login wrote (names, sizes, modes only).
  docker run --rm "${HARDEN[@]}" -v "$AUTH_VOL:/a:ro" "$IMG" sh -c 'cd /a && find . -maxdepth 2 \( -type f -o -type d \) -exec stat -c "%A %s %n" {} \;' > "$OUT/auth-files.txt" 2>&1
  result P1.auth_files OBSERVED "login wrote: $(awk '{print $3"("$2"B)"}' "$OUT/auth-files.txt" | grep -v '^\.(' | tr '\n' ' ')"
  M0=$(meta "$AUTH_VOL"); echo "persistent: $M0" >> "$LOG"
  result P1.credential_shape OBSERVED "keys=[$(field "$M0" oauth_keys)] subscription=$(field "$M0" subscription) expires_in_min=$(field "$M0" expires_in_min) scopes=[$(field "$M0" scopes)]"
  FP0=$(field "$M0" file_fp)

  # P2 — which copy is enough (decides §5.2 step 2's "complete auth state").
  WORKS=""
  for variant in creds creds+config full; do
    V=$(make_copy "$variant"); read -r rc ok < <(fixture "$V"); drop "$V"
    if [ "$rc" = 0 ] && [ "$ok" = 1 ]; then result "P2.copy_$variant" PASS "run succeeded with per-run copy '$variant'"; [ -z "$WORKS" ] && WORKS=$variant
    else result "P2.copy_$variant" OBSERVED "run did not succeed with '$variant' (rc=$rc, reply_ok=$ok)"; fi
  done
  [ -n "$WORKS" ] && result P2.minimal_copy OBSERVED "smallest working per-run copy: $WORKS" \
                  || { result P2.minimal_copy ERROR "no copy variant worked; check raw.log (login expired?)"; summarise probe; exit 1; }

  # P3 — no write-back: the stored credential is byte-identical after runs.
  FP1=$(field "$(meta "$AUTH_VOL")" file_fp)
  [ "$FP0" = "$FP1" ] && result P3.no_write_back PASS "stored credential unchanged after 3 runs (fingerprint $FP0)" \
                      || result P3.no_write_back FAIL "stored credential changed ($FP0 → $FP1) without any write-back step"

  # P4 — an agent overwrites its copy with well-formed attacker values; nothing persists.
  V=$(make_copy "$WORKS")
  docker run --rm "${HARDEN[@]}" -v "$V:/cfg" "$IMG" node -e '
    const f="/cfg/.credentials.json", j=JSON.parse(require("fs").readFileSync(f,"utf8"));
    const o=j.claudeAiOauth||{}; for (const k of Object.keys(o)) if (/token/i.test(k)) o[k]="attacker-"+k;
    o.expiresAt=Date.now()+365*864e5; require("fs").writeFileSync(f, JSON.stringify(j));' >> "$LOG" 2>&1
  ATT=$(field "$(meta "$V")" access_fp); drop "$V"
  FP2=$(field "$(meta "$AUTH_VOL")" file_fp)
  V=$(make_copy "$WORKS"); read -r rc ok < <(fixture "$V"); drop "$V"
  if [ "$FP2" = "$FP0" ] && [ "$rc" = 0 ] && [ "$ok" = 1 ]; then
    result P4.overwrite_attack PASS "copy overwritten with attacker values (fp $ATT) and discarded; stored credential unchanged; next run used the original and succeeded"
  else
    result P4.overwrite_attack FAIL "stored fp $FP0 → $FP2; next run rc=$rc reply_ok=$ok"
  fi

  # P5 — two concurrent runs, with a pre-run refresh (under the lock) between their copies.
  VA=$(make_copy "$WORKS")
  ( fixture "$VA" > "$OUT/.runA" ) & PA=$!
  sleep 5
  E1_LOG="$LOG" lockrun "$0" _refresh
  RRC=$?
  VB=$(make_copy "$WORKS"); read -r rcb okb < <(fixture "$VB")
  wait "$PA"; read -r rca oka < "$OUT/.runA"; rm -f "$OUT/.runA"; drop "$VA"; drop "$VB"
  if [ "$rca" = 0 ] && [ "$oka" = 1 ] && [ "$rcb" = 0 ] && [ "$okb" = 1 ] && [ "$RRC" = 0 ]; then
    result P5.concurrent_with_refresh PASS "run A (copy before refresh) and run B (copy after) both succeeded; pre-run refresh rc=0"
  else
    result P5.concurrent_with_refresh FAIL "A rc=$rca ok=$oka; refresh rc=$RRC; B rc=$rcb ok=$okb"
  fi
  M3=$(meta "$AUTH_VOL"); echo "persistent after refresh: $M3" >> "$LOG"
  [ "$(field "$M3" file_fp)" = "$FP0" ] && result P5.refresh_effect OBSERVED "pre-run refresh did not change the stored credential (token not near expiry)" \
    || result P5.refresh_effect OBSERVED "pre-run refresh updated the stored credential (refresh_fp $(field "$M0" refresh_fp) → $(field "$M3" refresh_fp))"

  # P6 — the auth lock: a login attempted during refresh+copy waits or reports auth_busy.
  lockrun sleep 6 & HOLDER=$!
  sleep 1
  locktry true; LRC=$?
  wait "$HOLDER"
  [ "$LRC" = 75 ] && result P6.auth_lock PASS "a login attempted while refresh+copy holds the lock is refused (auth_busy) instead of interleaving" \
                  || result P6.auth_lock FAIL "lock not held: try returned $LRC"

  result P7.expiry_and_rotation PENDING "covered by '$0 watch' (needs the access token to expire)"
  summarise probe
}

cmd_watch() {
  # Keep a Mac awake for the whole watch (re-exec once under caffeinate).
  [ "$(uname -s)" = Darwin ] && [ -z "${E1_CAFFEINATED:-}" ] && { E1_CAFFEINATED=1 exec caffeinate -i "$0" watch; }
  need_image; new_results watch
  docker volume inspect "$AUTH_VOL" >/dev/null 2>&1 || { log "no $AUTH_VOL volume: run '$0 login' first"; exit 2; }
  printf 'time\tstored_expires_in_min\trun_rc\treply_ok\trefreshed_in_run\trotated\tstored_changed\n' > "$OUT/timeline.tsv"
  VARIANT="${E1_VARIANT:-creds}"
  START=$(date +%s); M0=$(meta "$AUTH_VOL"); FP_STORED=$(field "$M0" file_fp)
  result W0.start OBSERVED "stored token expires in $(field "$M0" expires_in_min) min; checking every $((INTERVAL/60)) min for up to $MAX_HOURS h with copy '$VARIANT'"
  SAW_REFRESH=0; AFTER_EXPIRY_TICKS=0; FAILS_AFTER_ROTATION=0; ROTATED=0
  while :; do
    MS=$(meta "$AUTH_VOL"); EXP=$(field "$MS" expires_in_min); FPS=$(field "$MS" file_fp)
    V=$(make_copy "$VARIANT"); MB=$(meta "$V")
    read -r rc ok < <(fixture "$V")
    MA=$(meta "$V"); drop "$V"
    REF=0; [ "$(field "$MB" access_fp)" != "$(field "$MA" access_fp)" ] && REF=1
    ROT=0; [ "$(field "$MB" refresh_fp)" != "$(field "$MA" refresh_fp)" ] && ROT=1
    CHG=0; [ "$FPS" != "$FP_STORED" ] && CHG=1
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%H:%M)" "$EXP" "$rc" "$ok" "$REF" "$ROT" "$CHG" >> "$OUT/timeline.tsv"
    log "tick: stored_exp=${EXP}min rc=$rc ok=$ok refreshed=$REF rotated=$ROT stored_changed=$CHG"
    [ "$REF" = 1 ] && SAW_REFRESH=1
    [ "$ROT" = 1 ] && ROTATED=1
    [ "$ROTATED" = 1 ] && [ "$REF" = 0 ] && { [ "$rc" != 0 ] || [ "$ok" != 1 ]; } && FAILS_AFTER_ROTATION=$((FAILS_AFTER_ROTATION + 1))
    [ -n "$EXP" ] && [ "$EXP" -lt 0 ] && AFTER_EXPIRY_TICKS=$((AFTER_EXPIRY_TICKS + 1))
    # Stop once the stored token has been expired for 2 ticks (each of which had to refresh in-run),
    # or after MAX_HOURS.
    [ "$AFTER_EXPIRY_TICKS" -ge 2 ] && break
    [ $(( $(date +%s) - START )) -ge $(( MAX_HOURS * 3600 )) ] && break
    sleep "$INTERVAL"
  done

  # Conclusions for §5.2 (a)–(b).
  if [ "$AFTER_EXPIRY_TICKS" -lt 2 ]; then
    result W1.session_length OBSERVED "stored access token did not expire within $MAX_HOURS h (last: $EXP min left). Session length ≥ $MAX_HOURS h without any refresh."
  else
    result W1.session_length OBSERVED "stored access token expired; runs after expiry had to refresh in-run (refreshed_in_run=$SAW_REFRESH)"
  fi
  if [ "$ROTATED" = 1 ] && [ "$FAILS_AFTER_ROTATION" -gt 0 ]; then
    result W2.rotation FAIL "in-run refresh rotated the refresh token AND later runs from the unchanged stored copy failed: no-write-back + in-run refresh is not viable → INFERENCE must exclude the OAuth host and use pre-run refresh (§5.2 b)"
  elif [ "$ROTATED" = 1 ]; then
    result W2.rotation OBSERVED "in-run refresh rotated the refresh token, but later runs from the unchanged stored copy still succeeded (old refresh token remained valid during this window)"
  elif [ "$SAW_REFRESH" = 1 ]; then
    result W2.rotation PASS "in-run refresh did not rotate the refresh token; runs from the unchanged stored copy keep working"
  else
    result W2.rotation PENDING "no in-run refresh happened in this window; rerun with a longer E1_MAX_HOURS"
  fi
  # The pre-run refresh path, under the lock, then one run.
  E1_LOG="$LOG" lockrun "$0" _refresh
  RRC=$?; MR=$(meta "$AUTH_VOL")
  V=$(make_copy "$VARIANT"); read -r rc ok < <(fixture "$V"); drop "$V"
  [ "$RRC" = 0 ] && [ "$rc" = 0 ] && [ "$ok" = 1 ] \
    && result W3.pre_run_refresh PASS "clean-container refresh rc=0 (stored now expires in $(field "$MR" expires_in_min) min); run from the fresh copy succeeded" \
    || result W3.pre_run_refresh FAIL "pre-run refresh rc=$RRC; following run rc=$rc reply_ok=$ok (stored login may need 'run.sh login' again)"
  summarise watch
}

cmd_logout() {
  need_image
  docker run --rm "${HARDEN[@]}" "${ENVS[@]}" -e CLAUDE_CONFIG_DIR=/auth -v "$AUTH_VOL:/auth" "$IMG" claude auth logout
  docker volume rm "$AUTH_VOL" >/dev/null && echo "removed volume $AUTH_VOL"
}

case "${1:-}" in
  login) cmd_login ;; probe) cmd_probe ;; watch) cmd_watch ;; logout) cmd_logout ;;
  _refresh) LOG="${E1_LOG:-/dev/null}"; refresh_persistent ;;   # internal: run under lockrun
  *) echo "usage: $0 login | probe | watch | logout"; exit 2 ;;
esac
