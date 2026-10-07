# Memory identity, intent and stale hints (QB-24)

**Status:** implemented on `phase-3-context-memory`, in review.

## Why
- **Repositories could share one namespace.** The memory directory was the repository path with every unusual character replaced by `_`, so `/tmp/a/b` and `/tmp/a_b` both became `tmp_a_b`. Their records mixed.
- **Opposite instructions looked identical.** `not` and `no` were stop words, so "enable caching" and "do not enable caching" tokenized the same: similarity **1.0**. A repair learned for one was offered for the other.
- **Records had no revision.** A repair learned on a different history could be recalled as if it still applied.
- **File hints were not checked.** Any recorded path, including `../…`, absolute paths, and files that no longer exist, could be handed to L2.
- **Failed runs mixed with passing ones.** Files changed in failed runs were ranked alongside those from passing runs.

Pre-fix (`03ab9b0`): `test/unit/qb24-identity.test.js` has **12 of 12 failing**.

## Design
### 1. A collision-resistant repository identity plus a schema version (`memory/store.js`)
- **Namespace:** `<memory root>/r2-<sha256 of the repository's realpath>`. A path that doesn't exist yet hashes as itself. This is the same identity `run/store.js` uses for run records.
- **Identity file:** each namespace holds `identity.json` = `{ schema: 2, repo_realpath, created }`.
  - It is written under the per-repository lock (QB-25) before the first write.
  - A namespace whose identity names another repository is **refused**: writes throw ("belongs to …"), reads return nothing with a warning, and `stats().identity.status` is `"mismatch"`.
- **Migration: none, deliberately.** A pre-QB-24 path-sanitized namespace may already mix repositories, so it is **never read or merged**. `stats().legacy_namespace` reports it as `{ status: "ignored", dir, reason }`, with a one-time warning. The repository starts a fresh, clean history.
- **Choice of identity:** the realpath, not the root commit or remote. Two clones of one project are different working copies with different local state, and a realpath can't collide across repositories on one machine. Moving or re-cloning a repository starts a new namespace: an explicit fresh start, never a merge.

### 2. Negation and intent are preserved; lexical overlap is a hint only (`memory/scorer.js`)
- **`intentOf(text)`** gives the content keywords (antonyms mapped to one canonical word, simple stems) plus a **polarity**. The polarity starts at +1 and flips once per negator (`not`, `no`, `never`, `without`, `n't`, …) and once per antonym (`disable` = not `enable`, `block` / `deny` = not `allow`, `hide` = not `show`, `remove` = not `add`, …). So "don't disable caching" has the same intent as "enable caching".
- **`compareIntent(a, b)`:** the lexical Jaccard score, **halved** when the polarities are opposite, and flagged `conflicting`. Opposite requests are **never similarity 1**.
- **`recallRepairsDetailed()`** returns `{ usable, excluded }`, and `recallRepairs()` (used by `qb.js` for the briefing) returns only `usable`. A relevant repair is excluded, with its reason, when:
  - `conflicting_intent`: the recorded criterion text has the opposite intent of the current criterion;
  - `intent_unknown`: no criterion text was recorded (pre-QB-24 records), so its intent can't be established;
  - `stale_revision`: see below.
- **`recallPrior()`** labels each past run `intent: "same" | "conflicting"`.
- **Recorded from now on:** repair records store the criterion as written (`criterion_text`).

### 3. Paths and revisions validated; trust tiers never mixed (`memory/index.js`)
- **Base revision:** `remember(…, { baseSha })` records the run's base revision on outcomes and repairs, and `qb.js` passes the HEAD the run started from.
- **Revision check at recall:**
  - The record's revision must be the checkout's HEAD or an ancestor of it (`git merge-base --is-ancestor`). A revision unknown to the repository, or on an unrelated history, is **`stale_revision`**: never reused, and reported.
  - No recorded revision, or no git repository, means `revision: "unknown"`: allowed, labelled.
- **File hint validation:** a hint must be a plain repository-relative path that **exists in the current checkout**. Otherwise it's rejected with a reason:
  - `absolute`;
  - `traversal` (any `..` segment, or a realpath escaping the repository through a symlink);
  - `missing`;
  - `invalid`;
  - `stale_revision`, for files from a stale run.

  `recallFilesDetailed()` returns `{ hints, rejected }`.
- **Trust tiers, ranked and labelled, never mixed:** `resolved_run` (changed in a passing run) → `failed_run` (labelled "not proven relevant") → `opposite_intent` (lexical hint only) → `churn`. Repairs keep QB-23's split: proven ranks above unconfirmed, and failed or abandoned suggestions are never recalled.

## Done-when
- **The two repositories never share records:** real `/x/a/b` and `/x/a_b` directories get distinct namespaces and counts, and neither recalls the other's runs.
- **Opposite-intent requests don't reuse actionable repairs automatically:** "the deploy does not run on push" gets no repair learned for "the deploy runs on push" (`excluded: conflicting_intent`). Four opposite pairs are each `conflicting` with a score below 1, and a double negation keeps the same intent.
- **Stale paths, traversal hints, incompatible revisions and failed-run suggestions are clearly handled:**
  - `../outside.js`, `/etc/passwd`, `src/gone.js` and `src/../../escape.js` are rejected with reasons;
  - a repair from an orphaned history, or from an unknown commit, is `stale_revision`, while an ancestor is fine;
  - failed-run file hints are tiered and labelled after passing-run ones.
- **Through `qb.js`:** the QB-23 end-to-end test now also asserts that the stored repair carries the run's base revision and its criterion text.

## Re-review 1
### Intent is per clause, bound to its target
- **The bug:** a request-wide polarity parity let independent reversals cancel out. `"Enable caching and allow uploads"` vs `"Disable caching and block uploads"` had equal parity and scored as the same intent; a proven repair for one was reused, proven, for the other.
- **The fix, step by step:**
  1. A request is split into **clauses** (and / but / then / also / except / commas …).
  2. Each clause keeps its own **polarity**, flipped once per negator or antonym *inside that clause*.
  3. Each clause also keeps its **target** words: content words, with action verbs excluded.
  4. Clauses are matched to each other by target.
- **Relations:**
  - `conflicting`: some clause pair about the same target has opposite polarity, e.g. "enable caching, disable uploads" vs "disable caching, enable uploads".
  - `ambiguous`: a negative clause, an exclusion, has no counterpart, e.g. "enable caching **but not for guests**".
  - `same`, `partial` (extra positive clauses only) or `unrelated`.
- **Only `same` and `partial` are actionable.** Repairs are excluded as `conflicting_intent` or `ambiguous_intent`, and the briefing never receives them. An end-to-end `qb.js` test checks the agent's actual briefing.
- Inflected antonyms are covered too (blocked, denied, removed, disabled …). This is still lexical, not semantic proof.

### Restrictions keep their scope (re-review 2)
- **The bug:** "except" was a clause separator, and "only" was discarded. So "Enable caching **except for guests**" became an extra *positive* clause, rated partial and actionable, and an unrestricted "Enable caching for every user" fix was reused. Likewise "Allow uploads **only for admins**" vs "Allow uploads for guests" matched on a shared word.
- **The fix:**
  - Restriction operators (`except`, `unless`, `only`, `excluding`, `solely`, `exclusively`, `besides`, `other than`, `apart from`, `save for`) stay inside their clause, and the words after them are recorded as that restriction's scope.
  - Matched clauses count as the same intent only with **the same target set and the same restrictions**. A shared word alone no longer establishes compatible scope; the comparison is then `ambiguous` and never actionable.
  - An unmatched clause carrying a restriction is also `ambiguous`.
- **Positive controls:** the same restriction on both sides is still `same` and reuses its own fix, through the real store and the actual `qb.js` briefing.
- **Limitation:** this is still lexical. Differently worded but equivalent scopes ("for guests" vs "for anonymous users") count as different, which errs toward not reusing.

### Churn is revision-aware
- **The bug:** a file rejected as `stale_revision` came back through the "high-churn" fallback, which used the revision-blind `file_stats.json`.
- **The fix:** churn is now **recomputed from outcome records on compatible (or unrecorded) revisions only**, so a stale-only file can't re-enter. Tested through `remember()`.

## Limitations
- Intent is **lexical**. Polarity is global (one negator flips the whole request), and the antonym list is fixed. Sentences with mixed polarity ("enable X but not for guests") are treated as negated overall, which errs toward *not* reusing.
- Records written before QB-24 have no criterion text, so their repairs are `intent_unknown` and never reused automatically. They still count in `stats()`.
- The realpath identity means a moved or re-cloned repository starts a new history.
- The revision check needs the recorded commit to be present in the checkout. A shallow clone that lacks it marks the record stale, which fails closed.
