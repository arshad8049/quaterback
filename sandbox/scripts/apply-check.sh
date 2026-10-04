#!/bin/sh
# Fidelity check (agent-sandbox.md §6): applying /out/patch.bin to refs/qb/base in
# a scratch index must reproduce refs/qb/candidate's tree exactly — bytes, modes
# and symlinks. Prints "ok <tree>" or "mismatch <got> <want>" and exits 0/1.
set -eu
. /usr/local/lib/qb/git-env.sh
export GIT_INDEX_FILE=/tmp/apply-check.index
tgit read-tree refs/qb/base
[ -s /out/patch.bin ] && tgit apply --cached --binary /out/patch.bin
got=$(tgit write-tree)
want=$(tgit rev-parse refs/qb/candidate^{tree})
if [ "$got" = "$want" ]; then echo "ok $got"; else echo "mismatch $got $want"; exit 1; fi
