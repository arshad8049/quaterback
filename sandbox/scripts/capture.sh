#!/bin/sh
# Capture ④ (agent-sandbox.md §6). Trusted code only, no network; runs after the
# agent has stopped, so nothing can race it.
#   /work    the (hostile) workspace, mounted READ-ONLY
#   /git     the trusted GIT_DIR (refs/qb/base from seed)
#   /out     tmpfs output volume (its size is the patch cap)
#   /verify  the disposable verification checkout (§3.5)
# The agent's /work/.git is never read as git configuration: it is excluded from
# the scan and nothing here runs git against it. The candidate is a fresh tree
# built from exactly what qb-scan approved, so deletions are implicit and
# .gitignore plays no part.
set -eu
. /usr/local/lib/qb/git-env.sh

qb-scan --root /work --ref refs/qb/candidate --report /out/scan.json --exclude .git \
  ${QB_SCAN_LIMITS:-} | tgit fast-import --quiet --force

tgit rev-parse refs/qb/base^{tree} > /out/base.tree
tgit rev-parse refs/qb/candidate^{tree} > /out/candidate.tree
tgit diff --binary --full-index --no-renames --no-textconv --no-ext-diff refs/qb/base refs/qb/candidate > /out/patch.bin
tgit diff --name-status -z --no-renames refs/qb/base refs/qb/candidate > /out/name-status.z

# Verification gets its own writable copy of exactly the candidate tree.
[ "$(cat /out/candidate.tree)" = "$EMPTY_TREE" ] || tgit -c core.bare=false --work-tree=/verify checkout -f refs/qb/candidate -- .

cd /out && sha256sum base.tree candidate.tree patch.bin name-status.z scan.json > manifest.sha256
echo "captured candidate $(cat /out/candidate.tree)"
