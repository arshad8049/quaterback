#!/bin/sh
# Seed ① (agent-sandbox.md §3.1, §9.2). Trusted code only, no network.
#   /checkout  the user's checkout, mounted READ-ONLY
#   /git       QB-owned volume: the trusted GIT_DIR (/git/repo) and reports
#   /work      the workspace volume
# Lists the user's files with git (no program can be launched by their config),
# reads them with qb-scan (race-safe, never follows symlinks), commits that exact
# tree as refs/qb/base in the trusted repo, then materialises /work from it and
# gives the agent a fresh .git holding only that commit (no remotes).
set -eu
. /usr/local/lib/qb/git-env.sh

git init -q --bare "$GIT_DIR"
: > "$GIT_DIR/info/attributes"
tgit hash-object -w -t tree /dev/null >/dev/null      # make the empty tree available

# Paths: tracked + untracked-not-ignored, exactly what the user would commit.
# GIT_DIR points at the trusted repo, so these two calls must not inherit it.
env -u GIT_DIR git -C /checkout -c core.fsmonitor=false -c core.untrackedCache=false -c safe.directory='*' \
  ls-files -z --cached --others --exclude-standard > /tmp/list
env -u GIT_DIR git -C /checkout -c safe.directory='*' rev-parse --verify -q HEAD > /git/user-head 2>/dev/null || echo none > /git/user-head

qb-scan --root /checkout --ref refs/qb/base --report /git/seed-report.json --list /tmp/list --exclude .git \
  ${QB_SCAN_LIMITS:-} | tgit fast-import --quiet

# Workspace = the base tree, byte for byte (no eol conversion, no filters).
[ "$(tgit rev-parse refs/qb/base^{tree})" = "$EMPTY_TREE" ] || tgit -c core.bare=false --work-tree=/work checkout -f refs/qb/base -- .
# The agent's own repository: one commit, no remotes, no link to the user's .git.
GIT_DIR=/work/.git tgit init -q
GIT_DIR=/work/.git tgit fetch -q "$GIT_DIR" refs/qb/base:refs/heads/main
GIT_DIR=/work/.git tgit symbolic-ref HEAD refs/heads/main
GIT_DIR=/work/.git tgit --work-tree=/work read-tree refs/heads/main
tgit rev-parse refs/qb/base^{tree} > /git/base-tree
echo "seeded $(wc -c < /tmp/list | tr -d ' ') bytes of path list; base tree $(cat /git/base-tree)"
