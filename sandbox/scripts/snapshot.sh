#!/bin/sh
# Judgment material for a no-change run (QB-22). Trusted code only, no network.
# Reads the requested paths from refs/qb/candidate in the trusted GIT_DIR — the
# exact tree stage ⑤ tested — never from the user's live checkout.
#   stdin   NUL-separated repository paths (at most QB_SNAPSHOT_MAX_FILES)
#   /git    trusted GIT_DIR, read-only
#   /out    output: snapshot/index.ndjson and snapshot/f<N> (file contents)
# Only regular files (mode 100644/100755) are exported. A file's size is read
# from the object database BEFORE its content; larger than the cap → skipped
# as too_large, never truncated. Missing paths, directories, symlinks and
# submodules are recorded with a reason and not exported.
set -eu
. /usr/local/lib/qb/git-env.sh
export GIT_INDEX_FILE=/tmp/snapshot.index GIT_LITERAL_PATHSPECS=1
MAX_FILES=${QB_SNAPSHOT_MAX_FILES:-8}
MAX_BYTES=${QB_SNAPSHOT_MAX_BYTES:-65536}
OUT=/out/snapshot
rm -rf "$OUT"; mkdir -p "$OUT"
TREE=$(tgit rev-parse refs/qb/candidate^{tree})
jq -cn --arg tree "$TREE" '{type:"tree", tree:$tree}' > "$OUT/index.ndjson"

cat > /tmp/paths
i=0
tr '\0' '\n' < /tmp/paths | while IFS= read -r p; do
  [ -n "$p" ] || continue
  [ "$i" -lt "$MAX_FILES" ] || break
  entry=$(tgit -c core.quotePath=false ls-tree "$TREE" -- "$p" | head -n 1)        # "<mode> <type> <oid>\t<path>"
  meta=${entry%%	*}; name=${entry#*	}
  set -- $meta
  if [ -z "$entry" ] || [ "$name" != "$p" ]; then
    jq -cn --arg p "$p" '{type:"skip", path:$p, reason:"missing"}' >> "$OUT/index.ndjson"
  elif [ "$2" != blob ] || { [ "$1" != 100644 ] && [ "$1" != 100755 ]; }; then
    jq -cn --arg p "$p" --arg m "$1" '{type:"skip", path:$p, reason:"not_regular", mode:$m}' >> "$OUT/index.ndjson"
  else
    size=$(tgit cat-file -s "$3")
    if [ "$size" -gt "$MAX_BYTES" ]; then
      jq -cn --arg p "$p" --argjson s "$size" '{type:"skip", path:$p, reason:"too_large", size:$s}' >> "$OUT/index.ndjson"
    else
      tgit cat-file blob "$3" > "$OUT/f$i"
      jq -cn --arg p "$p" --arg o "$3" --argjson s "$size" --arg f "f$i" '{type:"file", path:$p, oid:$o, size:$s, file:$f}' >> "$OUT/index.ndjson"
    fi
  fi
  i=$((i + 1))
done
jq -cn '{type:"end"}' >> "$OUT/index.ndjson"
