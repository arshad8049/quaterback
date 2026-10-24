# Checker replay: QB's verdict against known truth (KAN-75)

**Run:** [kan75-checker-replay 39172392965](https://github.com/arshad8049/quaterback/actions/runs/39172392965), on a fresh GitHub runner at `2aeb2a6`. 2026-10-18.
- **Patches:** every patch of the frozen dev-r2 set, 128 in all.
- **Pipeline:** QB's production E pipeline, using the approved oracle contract, the real sandbox, and QB's real verification and routing.
- **Agent:** replaced by the fixed patch (`scripts/kan65-replay.js --set dev-r2`). No model, no agent, no spend.
- **Reprocessed** after review 10394 with the corrected summary: [kan75-reprocess 40057636081](https://github.com/arshad8049/quaterback/actions/runs/40057636081), at 6277b80, exit 0.
  - It downloads run 39172392965's own 128 records and lists each file's sha256. Nothing is replayed.
  - The summary now refuses duplicate records and records from more than one QB commit, set, spec version or a dirty tree.
  - It fails on any error, BLOCKED, invalid or missing record.
  - The records passed all of it: one QB commit (2aeb2a6), clean, no duplicates, nothing incomplete. The counts below are unchanged.
- **Every patch:** [checker-replay-patches.md](checker-replay-patches.md), one row per patch.

**This measures QB's verdict, not the agent.** QB's verdict is never a score; the external grader stays the only score.

## The truth set
The truth is the benchmark's label for each patch, from its hidden suite, not QB's judgement.

| Patch | Count | Benchmark label |
|---|---|---|
| Reference | 25 | correct (the hidden suite passes it) |
| Base, already-satisfied tasks (AV-05, FJ-04, FP-05, LM-06, PW-05) | 5 | correct (no change needed) |
| Base, the other 25 tasks | 25 | wrong (nothing done) |
| Incorrect implementations | 73 | wrong (the hidden suite fails each one) |

## Result
The first-attempt and final verdicts are identical:

| Truth | pass | partial | fail | unresolved |
|---|---|---|---|---|
| correct (30) | **0** | 23 | 2 | 5 |
| wrong (98) | **0** | 58 | 15 | 25 |

- **False accept** (QB passes a wrong patch): 0/98.
- **Catch** (QB fails a wrong patch): 15/98.
- **False fail** (QB fails a correct patch): 2/30.
- **Correct pass:** 0/30.
- **Missing or errored replays:** none.

**By patch group** (final verdict):

| Patch group | pass | partial | fail | unresolved |
|---|---|---|---|---|
| reference (correct) | 0 | 23 | 2 | 0 |
| base, already satisfied (correct) | 0 | 0 | 0 | 5 |
| incorrect implementation (wrong) | 0 | 58 | 15 | 0 |
| base, unchanged, needs a change (wrong) | 0 | 0 | 0 | 25 |

## What drives it
1. **QB never says `pass` on this set.**
   - The frozen dev oracles have no executable behavioural checks, so QB can't confirm the behavioural criteria.
   - A patch whose visible tests pass therefore ends `partial`. That covers 23 of the 25 references and 56 of the 58 wrong patches that ended `partial`.
   - The other 2 wrong `partial` patches, AV-01 `drop-label` and AV-06 `drops-branch-marker`, hit a visible-test timeout. QB routed that as an environment problem (`error(timeout)`), not a failure.
   - That's by design: missing evidence never becomes PASS. The cost is that `partial` is what QB says for both correct and wrong patches.
2. **Every unchanged base is `unresolved`** (30/30), correct or not.
3. **All 15 catches come from the repository's own visible tests,** which fail on the patch (`tests_failed`, with regressions). Not all of them tell right from wrong:
   - **4 are on FP-01 and LM-04,** where QB also fails the correct reference with the same visible-test regression. On those two tasks QB fails *every* changed version:
     - FP-01: `test/test.js › Should accept an option object`;
     - LM-04: `test/index.test.js › correctly handles no string headers`.

     That's the protected-visible-test limitation found on the screen (KAN-65): the required change contradicts an existing test. **LM-04 is also the one task arm E failed in the dev pilot.** The pilot's trial record (KAN-75 comment 10415) confirms this at the level of the final outcome and mechanism: three attempts, an empty final patch. The per-attempt repair hints were not recorded in that artifact.
   - **7 are on already-satisfied tasks** (AV-05, FJ-04, FP-05, LM-06, PW-05), where any behaviour change breaks an existing test.
   - **The other 4 are on tasks that need a real change:** PW-01 ×1, PW-02 ×2, PW-06 ×1. On the 23 such tasks where QB doesn't fail the correct reference, QB caught **4 of 59** wrong implementations.
4. **Attempts.** Each `fail` used 2 attempts, because the fixed patch can't change on retry. Every `partial` and `unresolved` stopped after 1.

## What it means
- **No PASS verdicts observed in this fixed-patch replay.** QB called no wrong patch `pass`, but it called no correct patch `pass` either. Zero false accepts alongside zero correct passes is not a safety guarantee. Outside visible-test regressions, QB's verdict did not tell correct from wrong here.
- For KAN-72, a QB arm would currently pass a weaker agent little more than its repository's own test results. A retry-only arm with a plain "tests failed" message gets the same signal. Executable acceptance checks in the contract, and the approved test-update design (option c), would have to come first.

## Not covered
- **The screen's negative controls.** KAN-65 reported QB's internal checks rejecting 4/20 there. Those replays ran at other commits and are not pooled with this run.
- **Arms that compile their own contract.** Every replay here used the frozen oracle contract.
- **Interactive agents.** A fixed patch can't respond to repair hints, so this measures the verdict and the routing, not repair. Nothing here supports a claim about interactive repair.
- **The LLM judge.** The replay runs with it off (`noLlmVerify`). This is not judge validation.

## Reproduce
- Push a change to `.github/workflows/kan75-checker-replay.yml` or either script, or dispatch the workflow once it's on the default branch.
- Locally: `node scripts/kan65-replay.js <ID> <base|reference|incorrect:<label>> --set dev-r2 --out <dir>`, then `node scripts/kan75-checker-summary.js <dir> --set dev-r2`. Exit 0 means every expected patch has a valid verdict; 1 means some are errored, BLOCKED, invalid or missing (all still counted); 2 means the records were refused.
