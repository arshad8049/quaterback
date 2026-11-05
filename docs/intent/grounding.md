# Intent grounding and bounded clarification (QB-17)

**Status:** shipped in Phases 0–2, accepted in internal review, merged into `main` (tag `phase-0-2-accepted`).

## Why
- **The root path compiled with no repository context.** `qb.js` called `compile(request)` with no context, while `intent/cli.js` could supply some, but only with `--repo`.
- **The ambiguity rules ignored the request.** The regex rules in `intent/dsa.js` asked even when the request already defined the vague term ("cleaner by extracting …").
- **Clarification was a single pass.** Any answer, even "just make it nicer", skipped the rules entirely.
- **Fallback fields concealed incomplete output.** The compiler filled in:
  - a missing `required_behavior` with the goal, or "Implement the requested feature as described.";
  - a missing `verification_plan` with "Run the existing test suite and verify acceptance criteria are met.";
  - unreadable list entries by joining or stringifying them.

Pre-fix reproductions (on `f2ea2ac`), all in `test/unit/qb17-grounding.test.js`, **14 of 14 fail**:
- `qb.js`'s compiler prompt has no repository content.
- `qb.js` and `intent/cli.js` send different compiler input.
- A fully specified "Make src/dates.js cleaner by extracting …" request gets the DSA question.
- The answer "just make it nicer" un-blocks "Make the code cleaner".
- A criterion citing a proposed default is rejected as an unknown requirement.
- Model output missing `required_behavior` / `verification_plan` finalizes with fallback text.

## Design

### 1. A repository survey before semantic compilation (`intent/survey.js`)
- **One function for both paths:** `surveyRepository(repoPath, request)`, used by both `qb.js` and `intent/cli.js` through `intent/session.js`.
  - `qb.js` surveys `--repo`, whose default is the current directory.
  - `intent/cli.js` surveys `--repo` too, now with the **same default**.
- **Contents** (`intent/context.js`): the directory tree, up to 200 files. Dot-directories, `node_modules`, build output, lock files and binaries are skipped, and symlinks are not followed. It also includes the first 2,000 bytes of the files most relevant to the request, within an 8,000-character budget.
- **How the compiler sees it:** the text goes to the compiler as `REPOSITORY SURVEY (read-only, for grounding — the request decides what to do)`.
- **Records:** the run records `contract.grounding` with the repo path, file counts, the files shown and a SHA-256 of the survey text. The contents themselves are not recorded.

### 2. Explicit, inferred and proposed defaults are distinct
- **Explicit:** QB-14 requirements with a verbatim `quote`.
- **Inferred:** QB-14 requirements with `implied: true`, plus a reason, shown as `(implied)`.
- **Proposed defaults** (new): `proposed_defaults: [{ id: "D-1", text, reason }]`. These are QB's own choices where the request is silent, for example "clamp throws a RangeError when min > max".
  - A criterion cites them in `requirement_ids`, and every default must be cited.
  - Malformed defaults are rejected: a missing reason, a bad or duplicate id, an unknown `D-n`, or an uncited default.
  - They are part of the **approved oracle** (the hash, only when present), so editing a default voids the approval.
  - They appear in their **own section of the approval view**: `Proposed defaults (not in your request — QB's choice; approving the contract approves them)`.
  - They are never applied silently.

### 3. Bounded clarification and a machine-readable handoff state (`intent/session.js`)
`compileIntent(request, { repoPath, answers, ask, maxRounds = 3 })` runs this loop:
1. Survey the repository.
2. Compile with the survey and every answer so far (`CLARIFICATION n: Q: … A: …`).
3. While a question is open, take the next answer from `answers` (in `qb.js`, `--clarify` is repeatable, one per round) or from `ask()` (interactive only).
4. Stop after `maxRounds` answers.

It returns a handoff state (`format: "qb-intent-handoff/1"`):

```
{ state: "finalized", contract, round, history, survey }
{ state: "needs_clarification", round, max_rounds, unresolved: [{ id, question, choices, flag }], ambiguity_flags, history, survey }
{ state: "blocked", reason: "clarification_rounds_exhausted", round, max_rounds, unresolved, history, survey }
{ state: "invalid", errors, contract, history, survey }
```

`history` holds `[{ round, question, answer }]` and `survey` is the survey summary.

- **`qb.js`:**
  - Writes the state to `<run dir>/clarification.json` (mode 0600) and records `contract.needs_clarification` / `contract.blocked`.
  - Prints the question and its choices.
  - Ends BLOCKED with reason `needs_clarification` or `clarification_rounds_exhausted`.
- **`intent/cli.js`:** prints the state as JSON and exits 2.
- Only `finalized` carries an executable contract.

**The ambiguity rules** (`intent/dsa.js`):
- A rule blocks only while its vague term is **unresolved**.
- The **request defines it** when a definition follows the term in the same sentence: `by`, `via`, `through`, `meaning`, `i.e.`, `e.g.`, `so that`, `such that`, `namely`, `:`, `(`, ` — `.
- An **answer resolves it** when it picks one of the rule's concrete **choices** or defines the term. For the unmeasured-improvement rule, it must give a number.
- A vague answer ("nicer", "you decide", "cleaner please") leaves the choice open.

### 4. Incomplete output is rejected, never filled (`intent/compiler.js`)
- A missing or empty `required_behavior` or `verification_plan`, or a list entry with no readable text, is recorded by QB in `incomplete` (the model cannot set it).
- `contractState` makes the contract **invalid**, e.g. `incomplete compiler output: missing required_behavior, verification_plan`.
- The fallback strings and the "join all values / JSON.stringify" extraction are gone.
- This applies to every producer of `contractFromObject`: model output, `--contract-file` and benchmark oracles. A reviewed contract file must therefore state `required_behavior` and `verification_plan`.

## Done when
- **Root and standalone compilation receive equivalent grounding.**
  - `qb.js` and `intent/cli.js` send **byte-identical** compiler input for the same repo and request, with `--repo` and with the default directory.
  - Both are captured through the real CLIs via `QB_TEST_PROMPT_LOG` in `test/helpers/preload-ollama.js`.
- **A fully specified "cleaner" request does not trigger a redundant question.** Through the real `compile()`, it reaches the model.
- **A still-ambiguous answer stays blocked with its unresolved choice.**
  - `compileIntent` gives `needs_clarification`, round 2, `unresolved[0].id = "cleaner"` with its choices, and the model is never called.
  - After three vague answers the state is `blocked`, never finalized.
  - Through `qb.js --clarify "just make it nicer"` the run ends BLOCKED `needs_clarification`, with `clarification.json` naming the open choice.
  - With three `--clarify` answers the run ends BLOCKED `clarification_rounds_exhausted`.

## Re-review 1: selection, not mention (`intent/dsa.js`)
- **The send-back.** For "Make src/dates.js cleaner", the answer "I cannot decide between naming and duplication; please ask me again." resolved the rule, and the contract finalized. The old rule accepted ANY choice keyword, so mentioning the options counted as selecting one. Every answer was also checked against every rule.
- **Stable ids and structured selection (deterministic).**
  - Each open question has a stable id (the rule id: `cleaner`, `better_refactor`, `more_quality`, `like_existing`, `improve_unmeasured`).
  - Each choice has a stable id, e.g. `cleaner`: `reduce_function_length`, `improve_naming`, `extract_helpers`, `remove_duplication`. The handoff lists them as `unresolved[].options: [{ id, label }]`, and both CLIs print them.
  - An answer `cleaner=improve_naming` resolves the question. That is `qb --clarify cleaner=improve_naming`, `intent/cli.js --clarify …`, or `{ question, choice }` in `compileIntent` answers.
  - An unknown question or choice id selects nothing.
- **Free text resolves only on an affirmative choice.** It must:
  - mention exactly **one** choice;
  - **not negate** it ("not naming", "no duplication removal", "without …");
  - carry **no uncertainty or alternatives**: "cannot decide", "not sure", "either", "or", "maybe", "perhaps", "you choose", "up to you", "ask me again", "between", a question mark …

  A concrete definition of the term (and, for the measurable-improvement rule, a number) also resolves it. Everything else stays open: an answer listing several or all options, a deferral, a negation. There is no growing list of exceptions: unclear free text never resolves.
- **Each answer is bound to its question.**
  - A free-text answer belongs to the question asked in its round (the first open one). A structured selection belongs to the question it names.
  - `history` records it as `{ round, question_id, question, answer }`, and an answer never resolves another question.
  - Example: "Make src/dates.js cleaner and more readable" answered with "remove duplication" resolves `cleaner` only, and `more_quality` stays open.

## Re-review 2: a parameterized choice needs its value (`intent/dsa.js`)
- **The bug.** `improve_unmeasured=numeric_target` resolved the "Improve performance" rule on the category id alone, so the contract finalized with no metric, threshold, comparator or unit (pre-fix at `7cb2927`).
- **Parameterized choices.** A choice whose meaning needs a value carries a validator and a follow-up question. Selecting it without a valid value keeps the rule open behind its follow-up: `{ id: "improve_unmeasured.target", parent, choice, question }`. The handoff lists `options[].needs_value`.
  - **Audit of the rule table:** `improve_unmeasured.numeric_target` is the only parameterized choice (`parameterizedChoices()`). The other choices name a complete aspect (for example `like_existing` → `data_model`), which is their full meaning.
- **Ways to supply the value:**
  - `--clarify "improve_unmeasured=numeric_target:p95 latency < 200ms"` (qb and intent/cli);
  - `{ question, choice, value }` in `compileIntent` answers;
  - free text answering the follow-up question;
  - free text in round 1 that is itself a valid target ("p95 latency under 200ms").
- **Validation is deterministic** (`validTarget`). A target needs all three of:
  - a **number**;
  - a **comparator**: `<`, `<=`, `>`, `>=`, `≤`, `≥`, "under", "below", "above", "over", "at most", "at least", "within", "less/more/fewer/greater than", "no more/less than", "up to", or a direction verb with "by"/"to" ("reduce runtime by 30%");
  - a **metric word** that is not a comparator or unit.

  It must also contain no uncertainty ("maybe", "or", "?" …). Invalid or missing → still open with the follow-up.
- **Carried into the contract.** The compiler input labels each bound clarification with its question id and gives a resolved value as `Q(improve_unmeasured): … A: numeric_target = p95 latency < 200ms`. QB (never the model) records `contract.clarifications: [{ question_id, choice, value }]`.
  - It is part of the **approval hash** when present, and shown in the approval view under "Clarified by you".
  - `contractState` rejects an entry with an unknown question or choice, a parameterized choice without a valid value, or a value on a choice that takes none.

## One correction of QB's own draft (KAN-103, KAN-104)

When a contract the compiler generated can't be used, QB gets **one** chance to correct it before blocking the user (`intent/compiler.js` `repair`). There are two cases:
- **Invalid** (KAN-103): the validator (`contractState`) rejected a parsed draft. The request, the rejected draft (model-authored fields only) and the validation errors go back to the compiler.
- **Unreadable** (KAN-104): the reply wasn't JSON. `parseJSON` strips fences and fixes unquoted keys, but never guesses what a bare value means; it throws a `DraftSyntaxError`. Only the request and the parser's diagnostic go back, for a fresh draft.

Either way, the correction is parsed and validated from scratch by the same code.
- **Bounded.** **One corrective call in total** per compilation, whatever went wrong, inside the run deadline (the same deadline-bound `modelCall`): an unreadable draft followed by an invalid correction stops, and so does the reverse. It is separate from the coding agent's `--max-retries`. A first draft that passes makes no extra call.
- **No new choices.** A correction fixes the listed errors; it doesn't make new choices. Each of its proposed defaults must be one the rejected draft had already justified: same id, same text, covered by a criterion there. Anything else is refused, however it is worded. A default the rejected draft left uncovered was never justified, so a correction must drop it rather than cite it with new criteria, and a reworded or new default is a new choice. This doesn't claim the request didn't need that choice: it limits what an unreviewed correction may decide. A choice the request does need comes back through a new run and the human approval. This holds even when the validator alone would accept the correction.
- **No dropped protections** (KAN-105). A correction may not remove a protected path that a constraint of the rejected draft is enforced by: that path stands for a "do not touch" in the request. When an allowed change is entirely protected, the correction must narrow the allowed change instead. Removing the protection, or swapping it for another path, is refused, and QB blocks. A protection no constraint relies on was the model's own choice and may be dropped. The correction prompt says this too.
- **The approval boundary is unchanged.** A corrected contract goes through the usual approval (QB-13); a dry run goes straight to the briefing. A user-supplied `--contract-file` is never repaired or rewritten: an invalid one is reported as supplied.
- **Recorded.** The run record stores every rejected draft and its errors as the `contract-repair` artifact (`qb-contract-repair/1`), with a `contract.repaired` or `contract.repair_failed` event. An unreadable reply is kept as its parser diagnostic plus at most 16 KiB of the reply (UTF-8 bytes, never splitting a character), redacted like every artifact. If the corrective call itself fails (an empty reply, a network error, cancellation), the run ends `ERROR` or `CANCELLED` as before, and the first draft and its errors are still stored, with the failure under `failed`. If the correction also fails, the run ends `BLOCKED` (`invalid_contract_after_repair: …`), nothing runs, and the user sees "QB couldn't build a reliable checklist. No code was changed." Drafts and parse diagnostics stay out of the terminal, in `qb` and in the standalone intent CLI (`intent/cli.js` prints a summary: the message, the number of drafts, and the validation problems of a readable draft).
- **Known gaps** (KAN-104 TODO tests). A parseable draft can still be wrong in ways L1 doesn't catch. A `call_returns` check that contradicts the request's own example (`greeting("test")` expecting `"Hello, Arshad!"`) is shown in the approval view and only fails at L4. A scope whose allowed changes are all protected (`protected_paths: ["**"]`) fails the L4 policy. Both are stopped only after the agent has run, so the human approval is the L1 backstop.

## Limitations
- **The survey is lexical.** Relevance is keyword overlap with file names and paths. It reads the live checkout (read-only) and does not parse code.
- **Free-text selection is deliberately strict.** A real decision phrased with an uncertainty word ("go with naming, not sure about the rest") stays open; the user can select by id instead. The model and the human approval (QB-13) remain the backstop for meaning.
- **Definition detection is a heuristic.** The DSA "definition marker" is a fixed list. A request can define a term in a way the markers miss, in which case it is asked once more.
- **Target validation is structural.** It checks that a metric word, a comparator and a number are present, not that the metric exists or can be measured in this repository. The human approval of the contract (QB-13), which shows the target, remains the check on meaning.
- **One question per round.** If several rules are open, all are listed in `unresolved`. A free-text answer goes to the first one; a structured selection can answer any.
- **The benchmark is not grounded.** `bench/run.js` and the demo harnesses (`intent/sandbox/run.js`, `agent/sandbox/run.js`) still call `compile()` without a survey. They are not the user-facing entry points.
