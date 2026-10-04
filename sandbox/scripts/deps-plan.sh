#!/bin/sh
# Dependencies, trusted half 1 (agent-sandbox.md §3.2). Runs BEFORE any
# repository code: decides whether the project fits the v1 profile, records
# the manifest fingerprint of the base tree, and prepares the scratch copy that
# the (untrusted) install stage will use.
#   /git      trusted GIT_DIR (read-write: plan output)
#   /scratch  scratch volume: receives a copy of the base tree
# Writes /git/deps-plan.json: {"status":"ready"|"skip"|"blocked", ...}
set -eu
. /usr/local/lib/qb/git-env.sh
plan() { printf '%s\n' "$1" > /git/deps-plan.json; echo "$1"; exit 0; }
blob() { tgit cat-file -p "refs/qb/base:$1" 2>/dev/null; }

blob package.json > /tmp/package.json || plan '{"status":"skip","reason":"no package.json"}'
jq -e 'type == "object"' /tmp/package.json >/dev/null 2>&1 || plan '{"status":"blocked","reason":"setup_unsupported_project","detail":"package.json is not a JSON object"}'
blob package-lock.json > /tmp/lock.json || plan '{"status":"blocked","reason":"setup_missing_lockfile"}'
LV=$(jq -r '.lockfileVersion // 0' /tmp/lock.json 2>/dev/null || echo 0)
case "$LV" in 2|3) ;; *) plan "{\"status\":\"blocked\",\"reason\":\"setup_unsupported_project\",\"detail\":\"lockfileVersion $LV (need 2 or 3)\"}" ;; esac
jq -e '.workspaces' /tmp/package.json >/dev/null 2>&1 && plan '{"status":"blocked","reason":"setup_unsupported_project","detail":"npm workspaces"}'
LOCAL=$(jq -r '[.packages // {} | to_entries[] | select(.value.link == true or ((.value.resolved // "") | test("^(file:|git|github:|link:)")))] | length' /tmp/lock.json)
[ "$LOCAL" = 0 ] || plan "{\"status\":\"blocked\",\"reason\":\"setup_unsupported_project\",\"detail\":\"$LOCAL file:/link:/git dependencies\"}"
SCRIPTS=$(jq -r '[.scripts // {} | keys[] | select(IN("preinstall","install","postinstall","prepublish","preprepare","prepare","postprepare"))] | join(",")' /tmp/package.json)
[ -z "$SCRIPTS" ] || plan "{\"status\":\"blocked\",\"reason\":\"setup_unsupported_project\",\"detail\":\"root lifecycle script(s): $SCRIPTS\"}"

# Manifest fingerprint: package.json, package-lock.json and .npmrc (if any).
manifest_fp refs/qb/base > /tmp/fp

# Scratch = the base tree (no .git), and a snapshot of it to compare after install.
tgit -c core.bare=false --work-tree=/scratch checkout -f refs/qb/base -- .
( cd /scratch && find . -path ./node_modules -prune -o \( -type f -o -type l \) -print0 | sort -z | xargs -0 -r sha256sum ) > /git/deps-snapshot.txt
plan "{\"status\":\"ready\",\"manifest_fp\":\"$(cat /tmp/fp)\"}"
