# The test oracle (QB-13)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
The model that writes the contract can get its own examples wrong. In the saved T-002 contract:

| Criterion | Model's claim | Correct |
|---|---|---|
| AC-1 | 30000 ms → `5m` | `30s` |
| AC-2 | 120000 ms → `20m` | `2m` |
| AC-3 | 25000 ms → `4m 10s` | `25s` |

QB recorded unanimous PASS votes on all three. An oracle written by the same kind of model that writes the code isn't independent, and a wrong oracle grades against the error.

## Rules
1. **Trusted arithmetic** (`intent/examples.js`):
   - every computable example is recomputed without any model: duration claims in criterion text ("formats 30000 ms as '5m'"), and `call_returns` checks whose single numeric argument is in the unit the criterion names;
   - a wrong example makes the contract **invalid**, and it says what the correct value is;
   - nothing is ever corrected automatically;
   - `contractState()` recomputes this at every boundary.
   - *Supported now:* time durations (ms, s, min, h, d). Other units are not validated, which is reported as "not checked", never as correct.
2. **Generated contracts are proposals.** A PASS needs a **human-approved** oracle (`approve()`, `approvalState()` in `intent/contract-state.js`):
   - approval records `contract_hash`: a SHA-256 of the goal, requirements, criteria (id, text, kind), plan and checks;
   - **any change after approval voids it** (`changed_after_approval`);
   - an approval not made by a human doesn't count.
   - *Verdict rule:* `aggregate` rules 3. An unapproved oracle can never be `pass` (unresolved). Records without `rules` replay as before.
3. **How a human approves:**
   - **In a terminal:** `qb` shows the criteria, the checks and QB's own arithmetic results, then asks *Approve this contract as the test oracle? [y/N]*. Anything but yes → BLOCKED `contract_not_approved`.
   - **With no terminal:** nothing runs. QB saves `proposed-contract.json` in the run directory and stops (BLOCKED `needs_contract_approval`). The human reviews or edits it and reruns with `--contract-file <path>`.
   - **With `--contract-file`:** the file **replaces** the generated contract. The model isn't asked for one, so the oracle is independent of the implementation-generating model. The file is normalized and validated exactly like model output: criteria, registry checks, arithmetic. Any `approval` field in it is ignored; approval records the file's SHA-256.
   - **Benchmark:** a task may carry `oracle` (criteria and checks written by a person, plus `approved_by`). It replaces the generated contract for grading. A task without one can't score PASS.
   - **Dry runs** verify nothing and need no oracle.

## Limitations
- The arithmetic covers durations only.
- Approval is only as good as the human's review. QB shows its own arithmetic results to help.
- Benchmark tasks still need human oracles written for them (QB-27/30).
