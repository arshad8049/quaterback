# Requirement traceability and behaviour over time (QB-14)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

## Why
T-005 asked for cumulative speech events and duration "tracked since the AdaptiveVAD was created". Its criteria only checked shape (two properties, non-negative integers, exported), so a constant-zero implementation satisfied all of them. Pre-fix (`2686f90`): `contractState(T-005)` = finalized.

## Traceability (`intent/requirements.js`, enforced by `contractState` for every contract carrying `raw_request`)
- `requirements[]`: `{ id: "R-n", quote }`, where the quote must appear **verbatim** in the request. QB checks this; it doesn't trust the model.
  - `disposition: "context"` + `reason` for a fragment that is only context, such as a location.
  - `implied: true` + `text` + `reason` for an unstated requirement. It's shown to the human.
- **Coverage of the request is by source span (re-review 1).** Each quote claims one span of the (case- and whitespace-normalized) request.
  - A quote that occurs more than once must say which occurrence it is (`occurrence`, 1-based).
  - Every token of the request must lie inside a claimed span. Tokens are words, numbers, and runs of symbols.
  - **Symbols fail closed, with no exemption (re-review 3).** Every symbol run must lie inside a quote: operators (`!`, `!=`, `!==`, `&&`, `||`, `??`, `?.`, `-`, `%`, `()`, `[]`, `{}`, `/` …) **and** sentence punctuation (`. , ; : ? !`).
  - Re-review 2 exempted punctuation glued to the end of a word. That stripped `??` from `"value?? fallback."`, so the exemption is removed: quoting whole clauses covers ordinary prose, and nothing has to guess whether a symbol is code.
  - The only exceptions are a tiny filler list: `a`, `an`, `the`, `and`, `that`, `which`, `please`.
  - **Negation, numbers, units, comparison words and operators always count,** and there is no length cutoff.
  - Each uncovered stretch is reported as the human would read it: `request text not traced to any requirement: "do not enable caching for"`.
  - A repeated word can no longer cover another clause. Before the fix, coverage was a set of unique words with "not" as a stop word, so `"Enable caching for admins. Do not enable caching for guests."` passed with only "guests" quoted.
- **Context exclusions** quote the full excluded span. Their reason is shown in the approval view: `R-2 "Ignore the legacy folder." → CONTEXT  (reason: …)`.
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
- **Structural coverage, not semantics.** It proves every piece of the request text was accounted for and linked to a criterion. It does **not** prove that the linked criterion captures the clause's meaning: an AC could cite "Do not enable caching for guests." and still be weak. That stays with the human approval (QB-13), where each quote → AC mapping is shown.
- `call_sequence` covers in-process JavaScript objects.
