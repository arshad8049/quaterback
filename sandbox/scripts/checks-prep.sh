#!/bin/sh
# Checks input (QB-16, stage ⑥a). Trusted code only, no network.
# Builds a FRESH checkout of the pinned candidate for the executable checks —
# never the /verify copy the repository's own tests ran on (a setup/build/test
# script may rewrite files there). Stage ⑥b mounts the result read-only.
#   /git      trusted GIT_DIR, read-only
#   /scratch  emptied, then refs/qb/candidate checked out into it
# stdout: {"status":"ready","tree":"<candidate tree>"} once the checkout is
# confirmed byte-identical to that tree (clean status, nothing untracked).
set -eu
. /usr/local/lib/qb/git-env.sh
export GIT_INDEX_FILE=/tmp/checks-prep.index
find /scratch -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
TREE=$(tgit rev-parse refs/qb/candidate^{tree})
if [ "$TREE" != "$EMPTY_TREE" ]; then
  tgit -c core.bare=false --work-tree=/scratch checkout -f refs/qb/candidate -- .
fi
# Byte identity: the working copy must equal the candidate tree (content and modes),
# with no extra file. Compared with the tree itself, not with HEAD.
if ! tgit -c core.bare=false --work-tree=/scratch diff --quiet --no-renames "$TREE" -- ; then
  echo "checks-prep: checkout differs from the candidate tree" >&2
  tgit -c core.bare=false --work-tree=/scratch diff --name-status --no-renames "$TREE" -- | head -c 4096 >&2; exit 4
fi
# Untracked = not in the index just checked out from the tree. No exclude rules: every extra file counts.
tgit -c core.bare=false --work-tree=/scratch ls-files --others > /tmp/extra
if [ -s /tmp/extra ]; then echo "checks-prep: files outside the candidate tree:" >&2; head -c 4096 /tmp/extra >&2; exit 4; fi
# Mount point for the read-only dependency volume in ⑥b (an empty directory adds no file).
[ -e /scratch/node_modules ] || mkdir /scratch/node_modules
printf '{"status":"ready","tree":"%s"}\n' "$TREE"
