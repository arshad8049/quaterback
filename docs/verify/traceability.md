# Requirement traceability and behaviour over time (QB-14)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
T-005 asked for cumulative speech events and duration "tracked since the AdaptiveVAD was created". Its criteria only checked shape (two properties, non-negative integers, exported), so a constant-zero implementation satisfied all of them. Pre-fix (`2686f90`): `contractState(T-005)` = finalized.

## Traceability (`intent/requirements.js`, enforced by `contractState` for every contract carrying `raw_request`)
- `requirements[]`: `{ id: "R-n", quote }`, where the quote must appear **verbatim** in the request. QB checks this; it doesn't trust the model.
  - `disposition: "context"` + `reason` for a fragment that is only context, such as a location.
  - `implied: true` + `text` + `reason` for an unstated requirement. It's shown to the human.
- **Coverage of the request:** every meaningful word of the request must be in some quote, otherwise "request text not traced: …". A dropped clause is caught.
- **Each requirement** must be covered by ≥ 1 criterion via `requirement_ids`, or be context.
- **Blocked before execution:**
  - uncovered requirements;
  - criteria tracing to no requirement (**unsupported additions**) or to unknown ones;
  - **duplicate** criteria.
- **The approval view** shows each requirement → its criteria, or CONTEXT. Requirements and `requirement_ids` are covered by the approval hash.
- **The standalone agent CLI** refuses a contract without `raw_request` for non-dry-run agents.

## Behaviour over time: `call_sequence` (registry `qb-checks/2`)
`{ module, export, instances: { name: { construct: "new" | "call", args } }, steps: [{ on, method, args, expect? }] }`: instances are created, then methods called in order, and every step with `expect` must deep-equal.
- **The T-005 essentials as checks:**
  - totals **accumulate** across events;
  - a new instance **starts at zero**;
  - instances are **independent**.
- **QB's real runner** on four VAD fixtures:

  | Implementation | Accumulates | Resets | Independent |
  |---|---|---|---|
  | correct | pass | pass | pass |
  | constant-zero | **fail** | pass | **fail** |
  | shared global counters | pass | **fail** | **fail** |
  | last-event-only | **fail** | pass | pass |

  Through `verify()`, the constant-zero VAD is FAIL.

## Limitations
- Quotes prove a clause was *assigned*, not that its criteria capture it well. That is shown to the human for approval (QB-13).
- "Meaningful words" uses a small stop-word list.
- `call_sequence` covers in-process JavaScript objects.
