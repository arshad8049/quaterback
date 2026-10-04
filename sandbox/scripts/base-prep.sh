#!/bin/sh
# Baseline test input (QB-10, stage ⑤b). Trusted code only, no network.
# Builds a FRESH checkout of the pinned BASE tree, so the repository tests can run on
# the code before the change and new failures can be told apart from old ones.
# Stage ⑤b runs npm test there (it may write; it is discarded afterwards).
#   /git      trusted GIT_DIR, read-only
#   /scratch  emptied, then refs/qb/base checked out into it
# stdout: {"status":"ready","tree":"<base tree>"} once the checkout is
# confirmed identical to that tree (git diff <tree> empty, nothing untracked).
set -eu
. /usr/local/lib/qb/git-env.sh
export GIT_INDEX_FILE=/tmp/base-prep.index
find /scratch -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
TREE=$(tgit rev-parse refs/qb/base^{tree})
if [ "$TREE" != "$EMPTY_TREE" ]; then
  tgit -c core.bare=false --work-tree=/scratch checkout -f refs/qb/base -- .
fi
# Byte identity: the working copy must equal the candidate tree (content and modes),
# with no extra file. Compared with the tree itself, not with HEAD.
if ! tgit -c core.bare=false --work-tree=/scratch diff --quiet --no-renames "$TREE" -- ; then
  echo "base-prep: checkout differs from the candidate tree" >&2
  tgit -c core.bare=false --work-tree=/scratch diff --name-status --no-renames "$TREE" -- | head -c 4096 >&2; exit 4
fi
# Untracked = not in the index just checked out from the tree. No exclude rules: every extra file counts.
tgit -c core.bare=false --work-tree=/scratch ls-files --others > /tmp/extra
if [ -s /tmp/extra ]; then echo "base-prep: files outside the candidate tree:" >&2; head -c 4096 /tmp/extra >&2; exit 4; fi
# Mount point for the read-only dependency volume in ⑥b (an empty directory adds no file).
[ -e /scratch/node_modules ] || mkdir /scratch/node_modules
printf '{"status":"ready","tree":"%s"}\n' "$TREE"
