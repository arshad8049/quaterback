#!/bin/sh
# Verification prep (agent-sandbox.md §3.5; QB-02 done-when "trusted-test
# modification is denied"). Runs in the trusted tools image after capture, on
# the disposable /verify checkout of the candidate:
#   1. dependency gate: the candidate's manifests must match the ones the deps
#      were built from (else verification is not run);
#   2. protected tests: every path under the protected patterns is restored to
#      its base version, files the agent added there are removed, and the test
#      script is taken from the base package.json. Agent edits to these paths
#      therefore cannot change the verdict; they are reported.
#   /git     trusted GIT_DIR (refs/qb/base, refs/qb/candidate, deps-plan.json)
#   /verify  the verification checkout (read-write)
#   /out     report output
# Env: QB_PROTECTED (newline-separated git pathspecs; default below)
set -eu
. /usr/local/lib/qb/git-env.sh
# /git is mounted read-only here: checkouts use a throwaway index.
export GIT_INDEX_FILE=/tmp/verify-prep.index
PROTECTED="${QB_PROTECTED:-:(glob)test/**
:(glob)tests/**
:(glob)__tests__/**
:(glob)spec/**
:(glob)**/*.test.*
:(glob)**/*.spec.*}"

# 1. Dependency gate.
blob() { tgit cat-file -p "refs/qb/candidate:$1" 2>/dev/null; }
DEPS=$(jq -r '.status' /git/deps-plan.json 2>/dev/null || echo skip)
if [ "$DEPS" = ready ]; then
  CFP=$(manifest_fp refs/qb/candidate)
  BFP=$(jq -r '.manifest_fp' /git/deps-plan.json)
  if [ "$CFP" != "$BFP" ]; then
    CH=$(tgit diff --name-only refs/qb/base refs/qb/candidate -- package.json package-lock.json .npmrc | jq -R . | jq -sc .)
    echo "{\"status\":\"dependency_change_required\",\"changed\":$CH}" > /out/verify-prep.json
    cat /out/verify-prep.json; exit 0
  fi
fi

# 2. Protected tests.
printf '%s\n' "$PROTECTED" > /tmp/pathspec
# `git diff` has no --pathspec-from-file: pass the patterns as arguments.
set -f; OLDIFS=$IFS; IFS='
'; set -- $PROTECTED; IFS=$OLDIFS; set +f
MODIFIED=$(tgit diff --name-only -z --no-renames refs/qb/base refs/qb/candidate -- "$@" | tr '\0' '\n' | jq -R . | jq -sc 'map(select(length>0))')
ADDED=$(tgit diff --name-only -z --no-renames --diff-filter=A refs/qb/base refs/qb/candidate -- "$@" | tr '\0' '\n')
printf '%s\n' "$ADDED" | while IFS= read -r p; do if [ -n "$p" ]; then rm -f -- "/verify/$p"; fi; done
# Restore every protected file that exists in the base (failures are fatal).
tgit diff --name-only -z --no-renames "$EMPTY_TREE" refs/qb/base -- "$@" > /tmp/base-protected
if [ -s /tmp/base-protected ]; then
  tgit -c core.bare=false --work-tree=/verify checkout -f refs/qb/base --pathspec-from-file=/tmp/base-protected --pathspec-file-nul
fi
SCRIPT_CHANGED=false
if tgit cat-file -e refs/qb/base:package.json 2>/dev/null && [ -f /verify/package.json ]; then
  BASE_TEST=$(tgit cat-file -p refs/qb/base:package.json | jq -c '.scripts.test // null')
  CAND_TEST=$(jq -c '.scripts.test // null' /verify/package.json)
  if [ "$BASE_TEST" != "$CAND_TEST" ]; then
    SCRIPT_CHANGED=true
    jq --argjson t "$BASE_TEST" 'if $t == null then del(.scripts.test) else .scripts.test = $t end' /verify/package.json > /tmp/p.json
    cat /tmp/p.json > /verify/package.json
  fi
fi
echo "{\"status\":\"ready\",\"protected_modified\":$MODIFIED,\"test_script_changed\":$SCRIPT_CHANGED}" > /out/verify-prep.json
cat /out/verify-prep.json
