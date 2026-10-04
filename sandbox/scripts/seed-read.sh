#!/bin/sh
# Seed ①a: read the user's checkout (agent-sandbox.md §3.1, §9.2). Trusted code
# only, no network. Runs as the HOST user's uid:gid, so it can read exactly what
# the user can (Linux home directories are often 0700/0750) and nothing more.
#   /checkout  the user's checkout, mounted READ-ONLY
#   /scratch   intake for ①b: path list, user HEAD, qb-scan report and stream
# Lists the user's files with git (no program can be launched by their config)
# and reads them with qb-scan (race-safe, never follows symlinks).
set -eu
export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
unset GIT_DIR

# Paths: tracked + untracked-not-ignored, exactly what the user would commit.
git -C /checkout -c core.fsmonitor=false -c core.untrackedCache=false -c core.hooksPath=/dev/null -c safe.directory='*' \
  ls-files -z --cached --others --exclude-standard > /scratch/seed-list
git -C /checkout -c core.fsmonitor=false -c safe.directory='*' rev-parse --verify -q HEAD > /scratch/seed-user-head 2>/dev/null \
  || echo none > /scratch/seed-user-head

qb-scan --root /checkout --ref refs/qb/base --report /scratch/seed-report.json --list /scratch/seed-list --exclude .git \
  ${QB_SCAN_LIMITS:-} > /scratch/seed-stream
echo "read $(wc -c < /scratch/seed-list | tr -d ' ') bytes of path list"
