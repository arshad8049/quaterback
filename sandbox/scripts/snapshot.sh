#!/bin/sh
# Judgment material for a no-change run (QB-22). Trusted code only, no network.
# Reads the requested paths from refs/qb/candidate in the trusted GIT_DIR — the
# exact tree stage ⑤ tested — never from the user's live checkout.
#   stdin   NUL-terminated repository paths (at most QB_SNAPSHOT_MAX_FILES).
#           The host (workspace.snapshot) never sends a path containing a
#           control character; if one arrives anyway, the whole export fails
#           rather than splitting a name into different files.
#   /git    trusted GIT_DIR, read-only
#   /out    output: snapshot/index.ndjson and snapshot/f<N> (file contents)
# One index entry per requested path, in request order: a file or a skip.
# Paths are never read back from git output: git reports only mode, type and
# object id (ls-tree --format), cross-checked against an exact <tree>:<path>
# lookup. Only regular files (100644/100755) are exported; the size is read
# from the object database BEFORE the content; larger than the cap → skipped
# as too_large, never truncated.
set -eu
. /usr/local/lib/qb/git-env.sh
export GIT_INDEX_FILE=/tmp/snapshot.index GIT_LITERAL_PATHSPECS=1 LC_ALL=C
MAX_FILES=${QB_SNAPSHOT_MAX_FILES:-8}
MAX_BYTES=${QB_SNAPSHOT_MAX_BYTES:-65536}
OUT=/out/snapshot
rm -rf "$OUT"; mkdir -p "$OUT"

cat > /tmp/paths
# Any control character (other than the NUL terminators) means the request is
# not in the supported form: refuse it whole.
if [ "$(tr -d '\000\040-\176\200-\377' < /tmp/paths | wc -c)" -ne 0 ]; then
  echo "snapshot: control character in a requested path" >&2; exit 3
fi

TREE=$(tgit rev-parse refs/qb/candidate^{tree})
jq -cn --arg tree "$TREE" '{type:"tree", tree:$tree}' > "$OUT/index.ndjson"

i=0
tr '\000' '\n' < /tmp/paths | while IFS= read -r p; do
  [ "$i" -lt "$MAX_FILES" ] || break
  skip() { jq -cn --arg p "$p" --arg r "$1" '{type:"skip", path:$p, reason:$r}' >> "$OUT/index.ndjson"; }
  # Exact path lookup (no pattern matching), then the entry's mode/type from ls-tree.
  oid=$(tgit rev-parse --verify -q "$TREE:$p" 2>/dev/null || true)
  meta=$(tgit ls-tree -z --format='%(objectmode) %(objecttype) %(objectname)' "$TREE" -- "$p" | tr '\000' '\n')
  if [ -z "$oid" ] || [ -z "$meta" ]; then skip missing
  elif [ "$(printf '%s\n' "$meta" | wc -l)" -ne 1 ]; then skip ambiguous
  else
    set -- $meta
    if [ "$3" != "$oid" ]; then skip ambiguous
    elif [ "$2" != blob ] || { [ "$1" != 100644 ] && [ "$1" != 100755 ]; }; then skip not_regular
    else
      size=$(tgit cat-file -s "$oid")
      if [ "$size" -gt "$MAX_BYTES" ]; then skip too_large
      else
        tgit cat-file blob "$oid" > "$OUT/f$i"
        jq -cn --arg p "$p" --arg o "$oid" --argjson s "$size" --arg f "f$i" '{type:"file", path:$p, oid:$o, size:$s, file:$f}' >> "$OUT/index.ndjson"
      fi
    fi
  fi
  i=$((i + 1))
done
jq -cn '{type:"end"}' >> "$OUT/index.ndjson"
