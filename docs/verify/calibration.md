# Judge calibration, resampling and preservation (QB-15)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
- **Repeated votes are cheap to game.** Identical low-temperature calls share blind spots, and re-asking can flip a vote without any change to the code.
  - Pre-fix (`f2ea2ac`): verifying the same patch twice, with a judge that was unsure the first time, gave **PASS** the second time.
- **Preservation criteria verified nothing.** "Existing tests remain unchanged" was set to null by the judge. That avoids a false repair, but nothing ever checks the claim.
  - Pre-fix: an unbound preservation criterion **finalized**.
  - Real model output contains such criteria. The saved T-003 benchmark contract (`bench/results/T-003_1790655025861.json`) has two: "The existing STT functionality remains unchanged" and "No other parts of the code are affected…".
- **Calibration was folded into one number.** The existing `bench/calibrate.js` scores the judge against test results, so the labels are not independent of the code. It also never reports abstention separately.

## 1. An unchanged patch is not approved by resampling (`verify/judge-cache.js`)
- **One judgment per piece of evidence.** The cache key is SHA-256 over:
  - the model;
  - the judge prompt;
  - the criterion;
  - the **content-addressed evidence** it saw: the QB-11 `EV-…` IDs, plus what was missing.
- Re-verifying an unchanged patch returns the same judgment (`judgment_cache: "hit"`) without calling the model. A changed patch has new evidence IDs, so it is judged afresh.
- **Only real judgments are cached** (`ok` / `invalid_judgment`). A judge outage is infrastructure and is retried. A corrupt entry is ignored and replaced.
- **Where it is used:**
  - `qb` and the benchmark use `~/.qb/judge-cache` (`QB_JUDGE_CACHE_DIR`);
  - `verify()` uses a cache only when given `judgeCache`.
- This adds to QB-10: the repair loop already stops on an identical patch.

### Concurrent runs (re-review 1)
- **Reading the cache, judging, then writing was not enough.** Two overlapping runs could both judge the same evidence, one null and one true, and the later writer replaced the decision. Pre-fix (`dd2b306`): 6 model calls and two different verdicts.
- **The evidence is now claimed before sampling, across processes:**
  - **Claim:** `<key>.lock` is created exclusively (`O_EXCL`) with `{ pid, host, token }`. The owner refreshes its mtime as a heartbeat while judging.
  - **Wait and re-read:** waiters poll the cache with a bound (`QB_JUDGE_LOCK_WAIT_MS`, default 15 min). After claiming, the owner re-reads the cache before sampling.
  - **Crashed owners:** a claim whose owner is dead (same host, pid gone) or silent (heartbeat older than 60 s) is taken over by atomic rename. Only one waiter wins, and it checks the token it judged stale.
  - **Publishing:** it is **no-overwrite** (hard link). The first published decision is authoritative, and a competing writer gets it back, never its own.
  - **A wait that runs out** gives `judgment_cache: "wait_timeout"`: no decision (unresolved), nothing cached, and no model calls.
- **Tested:**
  - overlapping in-process runs: 3 calls and one decision;
  - a **separate process** holding the claim: this run waits and returns that process's decision with 0 calls;
  - crashed-owner recovery: a dead pid, and a silent foreign host;
  - a bounded wait;
  - the first writer winning;
  - the sequential hit and changed-evidence guards.

## 2. Preservation is bounded to named tests (`verify/preservation.js`)
- **A preservation criterion must name what it preserves:** `"preserves": { "tests": ["test/parser.test.js"] }`.
  - Preservation criteria are detected by the existing patterns: "remains unchanged", "no regressions", "backward compatible", "existing tests still pass", …
  - Interfaces are preserved with QB-16 checks bound to the criterion.
  - An unbound or malformed binding makes the contract **invalid** (`contractState`).
  - `preserves` is part of the approval hash and shown in the approval view.
- **It is decided by the sandbox's classified test report (per test file), never by the judge:**

| Result | When |
|---|---|
| met | every named file ran, with at least 1 passing test and none failing, and the criterion's checks passed |
| not met | a named test failed, or a named file did not run |
| null → never PASS | the test run is unusable (timeout, OOM, no report, …) |

- **No rule treats null as proof of preservation.** `aggregate` makes any null criterion `partial`/`unresolved`, never PASS, and the run store records `partial` as UNRESOLVED. Both are tested.

## 3. Calibration against independently labeled patches (`verify/calibration.js`, `bench/judge-calibration.js`)
- **The labeled set:** `bench/calibration/labeled.json`, 13 small patches (7 met, 6 not met).
  - Each has a non-behavioural criterion (docs, JSDoc, changelog, naming, error text, a helper's output format).
  - The label and rationale were written **from the patch and criterion alone, before any judge run**.
  - It includes the QB-11 cases: a README hunk after 7,000 characters, and an unchanged helper.
- Each item is sampled N times (default 3) on its QB-11 evidence bundle. **Strategies are scored on the same samples, at their real call cost:**
  - `single`: 1 call per item;
  - `majority-3`: QB's judge, 3 calls;
  - `unanimous-3`: 3 calls.
- **False acceptance, false rejection and abstention are reported separately**, never as one accuracy:
  - false-accept rate over not-met items;
  - false-reject rate over met items;
  - abstention over all items.
- `node bench/judge-calibration.js [--votes 3]` prints the table. It writes per-item votes to `bench/calibration/results/<time>.json`.

### Live result (2026-10-04, `deepseek-r1:7b`, 13 patches × 3 samples)
Result file: `bench/calibration/results/2026-10-04T16-48-43-551Z.json`.

| Strategy | Calls / item | False accept (of 6 not-met) | False reject (of 7 met) | Abstain (of 13) | Correct |
|---|---|---|---|---|---|
| single | 1 | 2 (33%) | 0 (0%) | 0 (0%) | 11/13 |
| majority-3 (QB today) | 3 | 1 (17%) | 0 (0%) | 1 (8%) | 11/13 |
| unanimous-3 | 3 | 0 (0%) | 0 (0%) | 3 (23%) | 10/13 |

- **Majority-3 at 3× the cost** converts one false acceptance into an abstention: `jsdoc-incomplete`, votes `[true, null, false]`. It keeps the other false acceptance: `changelog-wrong-heading`, the flag listed under "Fixed" instead of "Added", votes `[true, true, false]`. It does **not** increase the number of correct decisions.
- **Unanimous-3** removes every false acceptance on this set, at the cost of 23% abstention: it also abstains on `error-message-ok`, votes `[true, false, true]`.
- **No false rejections** under any strategy on this set.
- **What this means:** extra votes mainly trade false acceptance for abstention. They don't buy accuracy.
- **Qualification:** this compares 1 call with 3 calls on the same items. It is **not** a demonstrated advantage at an equal budget, and with 13 items it does not establish field rates. No policy change to unanimity has been approved. Whether QB should require unanimity for a judged "met" is a policy decision. This ticket measures it; it does not change it.

## Limitations
- The labeled set is small (13) and written by one person. It measures the error kinds on this set; it does not estimate field rates with tight confidence.
- The cache freezes a judgment for identical evidence, including an unlucky one. Changing the patch, the criterion, the model or the prompt re-judges. Deleting the cache directory does too, which a human can see.
- Preservation is only as strong as the named tests. Naming the wrong tests is caught by human approval (QB-13), not by QB.
