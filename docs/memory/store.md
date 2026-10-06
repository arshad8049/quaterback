# Memory store: lifecycle and concurrency (QB-25)

**Status:** implemented on `phase-3-context-memory`, in review.

## Why
- **The store path was captured at import.** `memory/store.js` read `QB_MEMORY_DIR` once at `require()`. The demo (`memory/sandbox/run.js`) set it *after* importing, so it wrote to the real `~/.quarterback/memory`.
- **Stats used an unlocked read-modify-write.** Concurrent runs on one repository lost updates to `file_stats.json`.
- **Corrupt lines were silently discarded.** A record truncated by a crash was also glued onto the next append, losing that record too.
- **Recall read every record, with no retention.**

Pre-fix (`7433d8c`), `test/unit/qb25-store.test.js` fails **9 of 9**. In particular, 6 processes × 30 `remember()` calls on one repository kept **6** of 180 file-stat hits.

## Design
- **Path injection.**
  - `createMemory({ root })` / `createStore({ root })` take the store directory at construction.
  - The default memory resolves `QB_MEMORY_DIR` (default `~/.quarterback/memory`) **each time it is used**, never at import.
  - The demo uses its own `mkdtemp` directory and removes it afterwards.
- **A per-repository lock** (`memory/lock.js`). It uses the same claim pattern as the judge cache (QB-15), synchronous because each critical section is a short file update:
  - **Claim:** `<repo dir>/.lock` is created exclusively (`O_EXCL`) with `{ pid, host, token }`.
  - **Wait:** bounded (10 s), polling every 5 ms.
  - **Stale takeover:** a claim whose owner is dead (same host) or older than 30 s is taken over by atomic rename, with a token check.
  - **Release:** the lock is removed only if it still carries our token.
  - **Scope:** every append, stats update and compaction runs under it.
- **Atomic replacement.** `file_stats.json` and compacted JSONL files are written to a temp file and renamed into place.
- **Corruption is reported, never dropped.**
  - Unparsable and truncated records are reported with their **line, byte offset and reason**, in `stats(repo).corrupt` and through `onWarning` (stderr by default, once per message).
  - An append first completes a missing final newline, so a crashed tail never swallows the next record.
  - A corrupt `file_stats.json` is moved aside to `file_stats.json.corrupt-<time>`, not silently reset.
- **Retention and bounded recall.**
  - Outcomes keep the newest **10,000** and repairs the newest 5,000.
  - Compaction runs when a file exceeds its retention by 10 %. **Proven repairs** (QB-23 `resolved`) are always kept.
  - Corrupt lines are moved to `<file>.quarantine`, and their count is reported in `stats(repo).quarantined`.
  - Reads parse at most the newest 10,000 records.

## Done-when
- **Concurrent writes keep every count:** 6 processes × 30 `remember()` on one repository give exactly 180 outcomes and 180 file-stat hits (5/5 repeated runs).
- **A truncated record is reported without losing valid data:** reported as `{ line, offset, reason: "truncated" }`. The 3 valid records remain, and the record written after the crash is intact and recalled.
- **Demo and tests write only beneath their own directory:** the demo runs with `HOME` and `TMPDIR` pointed at empty temp directories. Nothing is written under `HOME`, and its own directory is removed. Tests inject their root.
- **Recall latency at the supported history size:** **10,000 outcomes**, `recallPrior` + `recallFiles` measured at **~51 ms** on a developer Mac (Node 20). The test asserts < 2 s.

## Limitations
- Recall is still a linear scan of the bounded window. JSONL is kept until measured concurrency or query needs justify a database.
- The lock is advisory: it serializes Quarterback processes, not arbitrary editors of the files.
- Stale takeover for a live owner on another host relies on the 30 s age bound, which is far longer than any critical section.
- `readFileStats` reports a corrupt stats file and treats it as empty for recall. The next write moves it aside.
