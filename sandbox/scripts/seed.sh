#!/bin/sh
# Seed ①b (agent-sandbox.md §3.1, §9.2). Trusted code only, no network, uid 10001.
#   /scratch   intake from ①a (seed-read.sh): path list, user HEAD, report, stream
#   /git       QB-owned volume: the trusted GIT_DIR (/git/repo) and reports
#   /work      the workspace volume
# Commits the tree ①a read as refs/qb/base in the trusted repo, then materialises
# /work from it and gives the agent a fresh .git holding only that commit (no
# remotes). It never sees the user's checkout.
set -eu
. /usr/local/lib/qb/git-env.sh

git init -q --bare "$GIT_DIR"
: > "$GIT_DIR/info/attributes"
tgit hash-object -w -t tree /dev/null >/dev/null      # make the empty tree available

tgit fast-import --quiet < /scratch/seed-stream
cp /scratch/seed-report.json /git/seed-report.json
cp /scratch/seed-user-head /git/user-head
list_bytes=$(wc -c < /scratch/seed-list | tr -d ' ')
# Leave /scratch empty for the dependency stage (②).
rm -f /scratch/seed-list /scratch/seed-user-head /scratch/seed-report.json /scratch/seed-stream

# Workspace = the base tree, byte for byte (no eol conversion, no filters).
[ "$(tgit rev-parse refs/qb/base^{tree})" = "$EMPTY_TREE" ] || tgit -c core.bare=false --work-tree=/work checkout -f refs/qb/base -- .
# The agent's own repository: one commit, no remotes, no link to the user's .git.
GIT_DIR=/work/.git tgit init -q
GIT_DIR=/work/.git tgit fetch -q "$GIT_DIR" refs/qb/base:refs/heads/main
GIT_DIR=/work/.git tgit symbolic-ref HEAD refs/heads/main
GIT_DIR=/work/.git tgit --work-tree=/work read-tree refs/heads/main
tgit rev-parse refs/qb/base^{tree} > /git/base-tree
echo "seeded ${list_bytes} bytes of path list; base tree $(cat /git/base-tree)"
