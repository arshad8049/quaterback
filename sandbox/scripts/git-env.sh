# Shared by seed.sh and capture.sh. Every git call goes through tgit, which uses
# only trusted configuration (agent-sandbox.md §6): no system or global config,
# no hooks, no fsmonitor, no filters or diff drivers (none are configured), no
# in-tree .gitattributes (attributes come from the empty tree), raw bytes.
export HOME=/tmp GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_DIR=/git/repo
EMPTY_TREE=4b825dc642cb6eb9a060e54bf8d69288fbee4904
tgit() {
  GIT_ATTR_SOURCE=$EMPTY_TREE git \
    -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null \
    -c core.autocrlf=false -c core.safecrlf=false -c core.filemode=true -c core.symlinks=true \
    -c core.untrackedCache=false -c core.pager=cat -c safe.directory='*' "$@"
}
