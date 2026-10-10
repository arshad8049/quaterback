#!/usr/bin/env bash
# QB-31 fresh-machine walkthrough, guided and recorded.
#
# Follows docs/onboarding.md on a clean Ubuntu 24.04 x86_64 machine (at least 16 GB RAM) and
# writes the evidence record of docs/review/qb31-walkthrough.md to ~/qb31-evidence/:
#   evidence.md   machine table, expected-vs-actual step table, run ids
#   logs/         one redacted log per step
#
# Usage (on the fresh VM, as a normal user with sudo):
#   curl -fsSL https://raw.githubusercontent.com/arshad8049/quaterback/<ref>/scripts/qb31-walkthrough.sh -o qb31.sh
#   bash qb31.sh --ref <ref>                 # the commit SHA you were given
#   bash qb31.sh --ref <ref> --from 4        # resume at step 4 (e.g. after re-login for docker)
#   bash qb31.sh --ref <ref> --with-checkpoint   # also rerun the Phase 4 Docker checkpoint
#
# You act in three places: the sudo password (step 1), re-login after joining the docker group,
# and `qb auth login` (step 4: open the URL, sign in, paste the code). That step is NOT recorded.
# Every log is redacted (keys, tokens, codes) before evidence.md is written. Review before sharing.
#
# It spends one real Claude Code task on your subscription per demo run (two: the demo, and the
# rerun after the Docker recovery). It never uses an API key unless you set one yourself.

set -uo pipefail

REF=""; FROM=1; WITH_CHECKPOINT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --from) FROM="${2:-1}"; shift 2 ;;
    --with-checkpoint) WITH_CHECKPOINT=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)"; exit 2 ;;
  esac
done
[ -n "$REF" ] || { echo "--ref <commit> is required: the QB commit you were given"; exit 2; }

REPO_URL="https://github.com/arshad8049/quaterback.git"
CHECKPOINT_REF="99682a6e83dc61ddcc4fbef99942b4ecde890970"
WORK="$HOME/qb31"; QBDIR="$WORK/quaterback"; DEMO="$WORK/qb-demo"
EV="$HOME/qb31-evidence"; LOGS="$EV/logs"; STEPS="$EV/steps.tsv"; RUNS="$EV/run-ids.txt"
QB_MODEL="${QB_MODEL:-deepseek-r1:7b}"
mkdir -p "$WORK" "$LOGS"; touch "$STEPS" "$RUNS"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
qb() { node "$QBDIR/qb.js" "$@"; }

# Remove anything credential-shaped from a log, in place.
redact() {
  sed -i -E \
    -e 's/sk-ant-[A-Za-z0-9_-]+/[REDACTED-KEY]/g' \
    -e 's/((code|token|key|secret|state)=)[A-Za-z0-9._~%-]+/\1[REDACTED]/Ig' \
    -e 's/((bearer|oauth)[[:space:]:]+)[A-Za-z0-9._-]{12,}/\1[REDACTED]/Ig' \
    -e 's/(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=[^[:space:]]+/\1=[REDACTED]/g' "$1"
}

# Run a command with a real terminal (prompts still work) and record its output to logs/<name>.log.
rec() { local name="$1"; shift; script -qefc "$*" "$LOGS/$name.log"; local rc=$?; redact "$LOGS/$name.log"; return $rc; }

# step <n> <name> <expected> <actual> <status> <seconds>
step() { sed -i "/^$1\t/d" "$STEPS"; printf '%s\t%s\t%s\t%s\t%s\t%ss\n' "$@" >> "$STEPS"; printf '  → %s: %s (%s)\n' "$2" "$5" "$4"; }
newest_run() { ls -t "${QB_RUNS_DIR:-$HOME/.qb/runs}" 2>/dev/null | head -1; }
# The run's final outcome, from the manifest `qb show` prints (VERIFIED, FAILED, …).
outcome_of() { (cd "$WORK" && qb show "$1" 2>/dev/null) | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s.slice(0,s.lastIndexOf('}')+1)).outcome)}catch{console.log('unknown')}})"; }

# ── 1. Prerequisites (onboarding §1) ─────────────────────────────────────────
s1() {
  bold "1/11 Prerequisites: git, Node 24, Docker Engine, Ollama (needs sudo)"
  local t=$SECONDS
  rec 01-prereqs "set -e
    sudo apt-get update && sudo apt-get install -y git curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
    sudo apt-get install -y nodejs
    sudo install -m 0755 -d /etc/apt/keyrings
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    sudo chmod a+r /etc/apt/keyrings/docker.asc
    echo \"deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$(. /etc/os-release && echo \"\$VERSION_CODENAME\") stable\" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
    sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
    sudo systemctl enable --now docker
    sudo usermod -aG docker \"\$USER\"
    curl -fsSL https://ollama.com/install.sh | sh"
  local rc=$?
  if [ $rc -ne 0 ]; then step 1 "Prerequisites (§1)" "all installed" "install failed (exit $rc; logs/01-prereqs.log)" FAIL $((SECONDS-t)); exit 1; fi
  if ! docker info >/dev/null 2>&1; then
    step 1 "Prerequisites (§1)" "git, Node 24, Docker, Ollama installed; docker works without sudo after re-login" "installed; docker needs re-login" "PENDING" $((SECONDS-t))
    bold "Log out and back in (so 'docker' works without sudo), then run:  bash $0 --ref $REF --from 2"
    exit 0
  fi
  step 1 "Prerequisites (§1)" "git, Node 24, Docker, Ollama installed; docker works without sudo after re-login" "installed; $(node --version); docker without sudo OK" PASS $((SECONDS-t))
}

# ── 2. QB at the given ref (§1) ──────────────────────────────────────────────
s2() {
  bold "2/11 QB install at $REF"
  local t=$SECONDS
  if docker info >/dev/null 2>&1; then :; else echo "docker still needs sudo: log out and back in first"; exit 1; fi
  # Step 1 ended PENDING (re-login for the docker group); docker now works without sudo.
  grep -q $'^1\t.*\tPENDING\t' "$STEPS" && sed -i -E $'s/^(1\t[^\t]*\t[^\t]*\t)[^\t]*\tPENDING/\\1installed; docker without sudo OK after re-login\tPASS/' "$STEPS"
  [ -d "$QBDIR/.git" ] || git clone -q "$REPO_URL" "$QBDIR"
  rec 02-install "set -e; cd '$QBDIR'; git fetch -q origin; git checkout -q '$REF'; git rev-parse HEAD; npm ci"
  local rc=$? head; head=$(git -C "$QBDIR" rev-parse HEAD 2>/dev/null)
  step 2 "QB install at the given SHA, npm ci (§1)" "succeeds" "HEAD $head; npm ci exit $rc" "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" $((SECONDS-t))
}

# ── 3. Local model (§1) ──────────────────────────────────────────────────────
s3() {
  bold "3/11 Local model: ollama pull $QB_MODEL"
  local t=$SECONDS
  rec 03-model "set -e; ollama pull '$QB_MODEL'; ollama list"
  if grep -q "${QB_MODEL%%:*}" "$LOGS/03-model.log"; then step 3 "ollama pull $QB_MODEL (§1)" "model listed by ollama list" "listed" PASS $((SECONDS-t))
  else step 3 "ollama pull $QB_MODEL (§1)" "model listed by ollama list" "not listed (logs/03-model.log)" FAIL $((SECONDS-t)); fi
}

# ── 4. Sign-in (§1) — interactive, NOT recorded ──────────────────────────────
s4() {
  bold "4/11 qb auth login: open the URL it prints, sign in, paste the code back. This step is not recorded."
  local t=$SECONDS
  (cd "$QBDIR" && qb auth login); local rc=$?
  rec 04-auth-status "cd '$QBDIR' && node qb.js auth status"
  step 4 "qb auth login (§1)" "signed in; qb auth status shows an expiry" "login exit $rc; status in logs/04-auth-status.log" "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" $((SECONDS-t))
}

# ── 5. qb doctor (§2) ────────────────────────────────────────────────────────
s5() {
  bold "5/11 qb doctor"
  local t=$SECONDS
  rec 05-doctor "cd '$QBDIR' && node qb.js doctor"; local rc=$?
  local mem; mem=$(grep -o 'memory.*' "$LOGS/05-doctor.log" | head -1 | tr -s ' ')
  step 5 "qb doctor (§2)" "exit 0; memory ✓; agent-auth validity not verified (!)" "exit $rc; $mem" "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" $((SECONDS-t))
}

# ── 6. Demo repository (§3) ──────────────────────────────────────────────────
s6() {
  bold "6/11 Demo repository + qb doctor --repo"
  local t=$SECONDS
  rm -rf "$DEMO"; mkdir -p "$DEMO/src" "$DEMO/test"
  ( cd "$DEMO" && git init -q && git config user.name "QB Demo" && git config user.email "demo@example.invalid"
    echo "module.exports = {};" > src/utils.js
    printf "const { test } = require('node:test');\ntest('placeholder', () => {});\n" > test/utils.test.js
    echo '{ "name": "qb-demo", "version": "1.0.0", "scripts": { "test": "node --test" } }' > package.json
    npm install --package-lock-only >/dev/null 2>&1 && git add -A && git commit -qm "demo base" )
  rec 06-doctor-repo "cd '$WORK' && node '$QBDIR/qb.js' doctor --repo qb-demo"; local rc=$?
  local ok=FAIL; grep -q '✓ repository' "$LOGS/06-doctor-repo.log" && grep -q '✓ test-runner.*node-test' "$LOGS/06-doctor-repo.log" && ok=PASS
  step 6 "Demo repo + qb doctor --repo qb-demo (§3)" "repository ✓, test-runner ✓ node-test" "doctor exit $rc" $ok $((SECONDS-t))
}

demo_run() {  # demo_run <log name> → prints the new run id, or "none" if no run record was created
  local before; before=$(newest_run)
  rec "$1" "cd '$WORK' && node '$QBDIR/qb.js' 'Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]' --repo qb-demo --agent claude-code --contract-file quaterback/docs/demo/clamp-contract.json" >&2   # show progress and any question on the terminal; stdout carries only the id
  local after; after=$(newest_run)
  if [ -n "$after" ] && [ "$after" != "$before" ]; then echo "$after"; else echo none; fi
}

# ── 7. Demo run (§3) ─────────────────────────────────────────────────────────
s7() {
  bold "7/11 Demo run with the reviewed contract (one real Claude Code task)"
  local t=$SECONDS id outcome
  id=$(demo_run 07-demo-run); echo "demo: $id" >> "$RUNS"
  outcome=$(outcome_of "$id")
  step 7 "Demo run with the reviewed contract (§3)" "authenticated agent call succeeds; checks pass; verdict pass; run id printed" "run $id; outcome ${outcome:-unknown}" "$([ "$outcome" = VERIFIED ] && echo PASS || echo FAIL)" $((SECONDS-t))
}

# ── 8. Checkout unchanged (§3) ───────────────────────────────────────────────
s8() {
  bold "8/11 git status --porcelain on the demo checkout"
  local t=$SECONDS out; out=$(git -C "$DEMO" status --porcelain); printf '%s\n' "$out" > "$LOGS/08-status.log"
  step 8 "git -C qb-demo status --porcelain (§3)" "empty: checkout unchanged" "$([ -z "$out" ] && echo empty || echo "changed: $(echo "$out" | wc -l) entries")" "$([ -z "$out" ] && echo PASS || echo FAIL)" $((SECONDS-t))
}

# ── 9. Recovery: stop Docker, doctor, start, doctor, rerun (§4) ──────────────
s9() {
  bold "9/11 Recovery drill: stop Docker → qb doctor → start → qb doctor → rerun the demo (needs sudo)"
  local t=$SECONDS
  sudo systemctl stop docker docker.socket
  rec 09a-doctor-docker-down "cd '$QBDIR' && node qb.js doctor"; local down=$?
  sudo systemctl start docker
  rec 09b-doctor-docker-up "cd '$QBDIR' && node qb.js doctor"; local up=$?
  local id outcome; id=$(demo_run 09c-demo-rerun); echo "rerun after recovery: $id" >> "$RUNS"
  outcome=$(outcome_of "$id")
  local ok=FAIL; [ $down -ne 0 ] && grep -q '✗ docker' "$LOGS/09a-doctor-docker-down.log" && [ $up -eq 0 ] && [ "$id" != none ] && ok=PASS
  step 9 "Docker stop → doctor → start → doctor → rerun (§4)" "✗ docker, then ✓; the rerun completes" "doctor exit $down then $up; rerun $id ${outcome:-unknown}" $ok $((SECONDS-t))
}

# ── 10. Inspect (§5) ─────────────────────────────────────────────────────────
s10() {
  bold "10/11 qb runs, qb show, qb replay"
  local t=$SECONDS id; id=$(head -1 "$RUNS" | awk '{print $2}')
  rec 10-inspect "cd '$WORK' && node '$QBDIR/qb.js' runs && node '$QBDIR/qb.js' show '$id' && node '$QBDIR/qb.js' replay '$id'"; local rc=$?
  local ok=FAIL; [ $rc -eq 0 ] && grep -q 'outcome=.* reproduced' "$LOGS/10-inspect.log" && ! grep -q 'NOT reproduced' "$LOGS/10-inspect.log" && ok=PASS
  step 10 "qb runs, qb show, qb replay (§5)" "run listed; replay reproduces the verdict" "exit $rc for run $id; $(grep -o 'outcome=[A-Z_]* *[A-Za-z ]*reproduced' "$LOGS/10-inspect.log" | tail -1)" $ok $((SECONDS-t))
}

# ── 11. Patch, apply to the demo, behaviour check (§5) ───────────────────────
s11() {
  bold "11/11 qb patch → apply to qb-demo → behaviour check"
  local t=$SECONDS id; id=$(head -1 "$RUNS" | awk '{print $2}')
  rec 11-patch "set -e; cd '$WORK'; node '$QBDIR/qb.js' patch '$id' --out clamp.patch; git -C qb-demo apply --check ../clamp.patch; git -C qb-demo apply ../clamp.patch; node -e \"const { clamp } = require('./qb-demo/src/utils'); console.log(clamp(-5, 0, 10), clamp(50, 0, 10), clamp(7, 0, 10))\""
  local ok=FAIL; grep -q '^0 10 7' "$LOGS/11-patch.log" && ok=PASS
  step 11 "qb patch --out, apply to qb-demo, behaviour check (§5)" "applies cleanly; prints 0 10 7" "$(tail -1 "$LOGS/11-patch.log" | tr -d '\r')" $ok $((SECONDS-t))
}

# ── Optional: rerun the 2026-10-08 Phase 4 checkpoint on a host that can admit it ──
checkpoint() {
  bold "Checkpoint rerun at ${CHECKPOINT_REF:0:7}: unit tests + Docker integration (scripted agent, mocked model; no paid task)"
  local d="$WORK/checkpoint"; [ -d "$d/.git" ] || git clone -q "$REPO_URL" "$d"
  rec cp-unit "set -e; cd '$d'; git checkout -q '$CHECKPOINT_REF'; node --version; npm ci >/dev/null; env -u QB_SANDBOX_TOOLS_IMAGE -u QB_SANDBOX_AGENT_IMAGE -u QB_SANDBOX_PROXY_IMAGE npm test"
  rec cp-integration "cd '$d'; env -u QB_SANDBOX_TOOLS_IMAGE -u QB_SANDBOX_AGENT_IMAGE -u QB_SANDBOX_PROXY_IMAGE QB_INTEGRATION=1 node --test --test-concurrency=1 test/integration/qb28-experiment.test.js test/integration/qb29-image-binding.test.js"
  echo "  unit:        $(grep -E '^ℹ (pass|fail) ' "$LOGS/cp-unit.log" | tr '\n' ' ')"
  echo "  integration: $(grep -E '^ℹ (pass|fail) ' "$LOGS/cp-integration.log" | tr '\n' ' ')"
}

machine_table() {
  local agentv; agentv=$(cd "$QBDIR" 2>/dev/null && node -e "console.log(require('./lib/sandbox/agent').AGENT_VERSION)" 2>/dev/null)
  cat <<EOF
| | Value |
|---|---|
| Date / operator | $(date -u +%Y-%m-%dT%H:%MZ) / (fill in) |
| VM / provider, CPU, RAM, disk | (provider: fill in); $(nproc) vCPU $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | xargs); $(free -h | awk '/^Mem:/{print $2}') RAM; $(df -h / | awk 'NR==2{print $2" disk, "$4" free"}') |
| \`uname -a\`, \`lsb_release -d\` | $(uname -a); $(lsb_release -ds 2>/dev/null) |
| \`node --version\` | $(node --version 2>/dev/null) (npm $(npm --version 2>/dev/null)) |
| \`docker version --format '{{.Server.Version}}'\` | $(docker version --format '{{.Server.Version}}' 2>/dev/null) |
| \`ollama --version\`, \`QB_MODEL\` | $(ollama --version 2>/dev/null | tail -1); $QB_MODEL |
| QB ref given, \`git rev-parse HEAD\` | $REF; $(git -C "$QBDIR" rev-parse HEAD 2>/dev/null) |
| Claude Code version in the sandbox (\`AGENT_VERSION\`) | ${agentv:-unknown} |
| Login route | \`qb auth login\` (subscription) |
EOF
}

write_evidence() {
  {
    echo "# QB-31 fresh-machine walkthrough: evidence (generated by scripts/qb31-walkthrough.sh)"
    echo; echo "Logs are redacted automatically; review them before sharing. The sign-in step was not recorded."
    echo; echo "## Machine"; echo; machine_table
    echo; echo "## Steps (expected vs actual)"; echo
    echo "| # | Step (onboarding §) | Expected | Actual | Result | Elapsed |"; echo "|---|---|---|---|---|---|"
    sort -t$'\t' -k1,1n "$STEPS" | awk -F'\t' '{printf "| %s | %s | %s | %s | %s | %s |\n",$1,$2,$3,$4,$5,$6}'
    echo; echo "**Run ids:**"; sed 's/^/- /' "$RUNS"
    echo; echo "## Documentation gaps found"; echo; echo "(fill in: each gap, and where the docs were unclear)"
  } > "$EV/evidence.md"
  bold "Evidence written to $EV/evidence.md (logs in $LOGS). Review it, then send it with the logs."
}

for n in 1 2 3 4 5 6 7 8 9 10 11; do [ "$n" -ge "$FROM" ] && "s$n"; done
[ "$WITH_CHECKPOINT" -eq 1 ] && checkpoint
write_evidence
