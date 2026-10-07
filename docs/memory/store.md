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

## Re-review 1
### No lock theft from a live owner (`memory/lock.js`)
- **Before:** a lock was taken over if its owner was dead **or** it was older than 30 s. A live owner paused past 30 s lost its lock while still inside its critical section, so two writers could run at once.
- **Same host:** a lock is taken over **only if its owner is provably dead** (its pid is gone). Age never counts. A paused or slow owner keeps the lock, and waiters time out with `MEMORY_LOCK_TIMEOUT … held by live process <pid>`.
- **Another host:** the owner can't be verified, so the lock is **never** taken over. The error says cross-host sharing of a memory store (e.g. a network home directory) is not supported.
- **Dead-owner recovery is race-safe.** Takeover is serialized by a second exclusive file, `.lock.takeover`. Its holder re-reads `.lock` and removes it only if it still names the dead owner's token, so a fresh claim made meanwhile is never removed. A takeover file left by a crashed waiter is cleared the same way (dead pid).
- **The only age-based recovery** is for a lock whose content is unreadable: its owner crashed between creating and writing it, so no owner can be identified.
- **Tested with real processes:**
  - Owner A holds the lock and is SIGSTOPped inside its critical section, with the lock aged to 60 s. Process B times out and does not enter.
  - After A is killed, B recovers. The log shows no overlap and nothing lost.
  - 6 processes recover one dead owner while incrementing a shared counter 120 times, and the counter ends at exactly 120.

### Recall work is bounded by the window (`memory/store.js`)
- **Before:** `parseJsonl(text, { limit: 2 })` on 100 rows called `JSON.parse` 100 times. `readRecords` read the whole file, and every append re-read the whole file to count lines.
- **Recall:** a **tail read** reads the file backwards in 64 KiB chunks until the newest `maxScan` complete lines are in hand, and parses only those. Corrupt lines in that window are kept out of recall and warned about by byte offset.
  - **Measured on 100,000 outcomes with a 1,000 window:** the file is 8.46 MB, but recall read **131 KB**, did **1,001** `JSON.parse` calls (1,000 rows plus `identity.json`) and took 3.2 ms.
- **Appends** keep the line counts in `<file>.meta`, written under the lock. Retention is decided from those counts, so an append reads a few bytes, not the history. The counts are rebuilt by one full count if missing and reset exactly by each compaction.
- **The full audit path is separate:** `health()` (so `stats().corrupt`) and compaction parse every row, report corruption with line and offset, and quarantine it.
- **Pinned history is bounded:** retention is `{ outcomes: 10000, repairs: 5000, pinned: 1000 }`. The newest 1,000 proven repairs stay in `repairs.jsonl` and recallable. Older proven repairs move to `repairs.archive.jsonl`: kept, never deleted, never read by recall.

## Re-review 2
### Every lock wait honours its deadline (`memory/lock.js`)
- **The bug:** when the lock's owner was dead, the wait loop tried a takeover and immediately looped again. If another process held the takeover claim, nothing changed, so the loop never reached its deadline check or its sleep and spun forever. The senior's repro: a dead `.lock` plus a `.lock.takeover` naming a live process. `withLock({ waitMs: 40 })` kept running until an outside 700 ms timeout killed it. An incomplete (unreadable) takeover file caused the same spin.
- **The rule now: every iteration ends at the same deadline check,** whatever a recovery attempt did.
  - **Progress** (the lock was released, a dead owner's lock removed, a crashed taker cleared, or the lock changed): retry at once.
  - **No progress** (a live owner, a live taker, a taker from another host, a fresh unreadable file): back off, doubling from `pollMs` up to 50 ms. The sleep never runs past the deadline.
  - At the deadline: `MEMORY_LOCK_TIMEOUT`. The critical section never runs, and no claim is touched.
- **Takeover outcomes are explicit:** `removed`, `cleared`, `held` or `not_mine`.
  - A takeover claim from a dead taker on this host is cleared.
  - A live taker's claim, or one from another host, is `held` and never touched.
- **An incomplete takeover file** (its writer crashed between creating and writing it) is recovered only once it is **older than 2 s**, because a takeover is two file operations. Before that it counts as held, so the waiter times out rather than spins.
  - Recovery moves the file aside and deletes it only if its bytes are unchanged, so a file rewritten meanwhile is put back.
  - The long-unreadable `.lock` recovery uses the same move-aside check.
- **Regressions** (`test/unit/qb25-store.test.js`, "re-review 2"). Each runs `withLock` in a child process with an outside timeout, so a spin shows up as `ETIMEDOUT` instead of hanging the suite.
  - The senior's repro (a dead `.lock` plus a takeover file naming a live process): `MEMORY_LOCK_TIMEOUT` within the bound, no entry, the live taker's claim untouched.
  - Two processes: a live process genuinely holding the takeover claim makes the waiter time out and never enter.
  - An incomplete takeover file: fresh, it ends in a timeout, not a spin. Aged past 2 s, it is recovered and the dead lock taken over.
  - A dead taker's file is cleared and the lock recovered.
  - A fresh unreadable `.lock` ends in a timeout, not a spin.
  - The SIGSTOP live-owner, dead-owner concurrency and bounded-read tests still pass. The re-review tests passed 5 of 5 repeated runs.

## Limitations
- Recall is still a linear scan of the bounded window. JSONL is kept until measured concurrency or query needs justify a database.
- The lock is advisory: it serializes Quarterback processes, not arbitrary editors of the files.
- **Cross-host sharing of one store is unsupported.** A lock held from another host is never taken over; a dead remote owner needs a manual `rm .lock`.
- Dead-owner detection trusts the pid. A pid reused by an unrelated process makes the owner look alive, so the waiter times out rather than steals.
- `stats()` runs the full audit (linear in the file, bounded by retention). Recall does not.
- `readFileStats` reports a corrupt stats file and treats it as empty for recall. The next write moves it aside.

## Re-review 3: atomic claims; nothing unidentifiable is reclaimed
- **The bug:** a claim was created empty (`open('wx')`) and the owner written afterwards. A creator paused between those two steps left an empty claim that looked abandoned. A waiter "recovered" it by age (`.lock` after 30 s, `.lock.takeover` after 2 s) and entered. The paused creator, still alive, then wrote to its now-unlinked file and entered too: **two processes in the critical section**. Elapsed time cannot prove a writer died, and the rename/restore recovery had its own window.
- **The fix (`memory/lock.js`):**
  - **Atomic publication.** A claim is written complete to a private temp file and **hard-linked** to `.lock`. `link()` is atomic and fails if `.lock` exists, so the lock is either absent or names its owner; it can never be seen half-written. The takeover claim is published the same way.
  - **Entry check.** A process enters only if the current `.lock` names its own token.
  - **Dead owners only, under the takeover claim.** A lock is removed only when its owner is provably dead (same host, pid gone), and only while holding `.lock.takeover`. While it is held, nobody else may remove `.lock`, and a new claimant can only create `.lock` once it is gone, so "still the dead owner's token → remove" cannot race a fresh claim.
  - **Nothing is reclaimed by age.** That covers a live owner, however paused; an owner on another host; an unreadable `.lock` (only possible through outside corruption now); and a takeover claim left by a crashed taker, since clearing it automatically would race a new taker.
  - **In those cases** the waiter times out (`MEMORY_LOCK_TIMEOUT`), and the message names the file to **remove by hand** if no Quarterback process is running. The `staleMs` option is gone.
- **Tests:**
  - Two real processes: A pauses between creating and publishing its claim, the claim is aged 31 s, B runs, then A resumes. There is **no overlap**: the order is B then A. Pre-fix: "A entered while B was inside".
  - A creator killed at that point does not block the next process.
  - An old, unreadable lock is never reclaimed.
  - A published claim is complete the moment it exists, and no temp files are left.
  - The incomplete-takeover and dead-taker cases now time out with manual-recovery instructions; they were automatic before.
  - All deadline, live-owner, dead-owner contention and bounded-read tests are unchanged.
- **Limitation:** a crash inside the takeover critical section (two file operations, microseconds) needs a person to remove `.lock.takeover`. The error says exactly that. This is the deliberate trade: a bounded timeout instead of stealing an unverifiable claim.
