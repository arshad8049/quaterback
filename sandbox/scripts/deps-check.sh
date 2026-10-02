#!/bin/sh
# Dependencies, trusted half 2 (agent-sandbox.md §3.2). Runs AFTER the
# untrusted install stage has stopped: the install may only have produced
# node_modules. Any created, changed or deleted path elsewhere in the scratch
# copy means the project needs install outputs outside node_modules (or reads
# mutable source), which v1 does not support.
#   /git      trusted GIT_DIR (snapshot in; result out)
#   /scratch  the scratch copy, mounted READ-ONLY
set -eu
( cd /scratch && find . -path ./node_modules -prune -o \( -type f -o -type l \) -print0 | sort -z | xargs -0 -r sha256sum ) > /tmp/after.txt
if cmp -s /git/deps-snapshot.txt /tmp/after.txt; then
  echo '{"status":"ok"}' > /git/deps-check.json
else
  CHANGED=$(diff /git/deps-snapshot.txt /tmp/after.txt | grep '^[<>]' | awk '{print $3}' | sort -u | head -20 | jq -R . | jq -sc .)
  echo "{\"status\":\"blocked\",\"reason\":\"setup_unsupported_project\",\"detail\":\"install modified the project tree\",\"paths\":$CHANGED}" > /git/deps-check.json
fi
cat /git/deps-check.json
