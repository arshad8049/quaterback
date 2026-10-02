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

# Dependency manifest fingerprint of a tree (agent-sandbox.md §3.2): the
# install-relevant package.json fields (canonical JSON), the whole lockfile and
# .npmrc. Script or metadata edits do not change it; dependency edits do.
manifest_fp() {
  {
    tgit cat-file -p "$1:package.json" 2>/dev/null | jq -cS '{dependencies, devDependencies, optionalDependencies,
      peerDependencies, bundleDependencies, bundledDependencies, overrides, workspaces, packageManager, engines}' 2>/dev/null \
      || echo "(package.json missing or invalid)"
    tgit cat-file -p "$1:package-lock.json" 2>/dev/null || echo "(no package-lock.json)"
    tgit cat-file -p "$1:.npmrc" 2>/dev/null || echo "(no .npmrc)"
  } | sha256sum | cut -c1-64
}
