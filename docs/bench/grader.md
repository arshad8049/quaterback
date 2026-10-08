# The external grader (QB-27)

**Problem (review, QB-27):** the benchmark generated a contract with QB, showed it to QB's own agent, and graded **both** arms against it. The baseline only ever saw the original prompt. A wrong or extra generated criterion could reward QB and penalize a correct baseline. The review's example: a correct "30,000 ms → 30s" change could fail because QB invented "5m".

- `bench/run.js` scored the QB arm by `final_verdict`, QB's own L4 verdict against its own contract.
- It scored the baseline with `verify(contract, …)` on that same contract.

**Fix:** both arms are scored only by an external grader. The grader takes a frozen, human-written task spec, a hidden check suite and the arm's patch, and nothing else.

## Pieces

| File | Role |
|---|---|
| `bench/schemas.js` | `qb-task-spec/1`, `qb-grade/1`, `qb-adjudication/1` (shared with QB-29, `docs/bench/schemas.md`) |
| `bench/grader.js` | `grade({ spec, patch })` → `qb-grade/1`; `gradeArm(spec, arm)` is the benchmark's scoring step |
| `bench/qualify.js` | qualifies a suite against a correct reference and at least two incorrect implementations |
| `bench/spec.js` | freezes qualified specs into `bench/specs.lock.json`; `checkFrozen` before every run |
| `bench/adjudicate.js` | blinded adjudication for checks a spec explicitly reserves |

## The grading run

1. **Integrity.** The spec validates. The suite's files hash exactly as the spec lists. The spec carries a qualification whose suite hash and **grader hash** (`bench/grader.js`, `bench/schemas.js`, `verify/tests.js`, the QB node:test reporter) match the current code.
2. **The suite stays hidden from agents.**
   - Suites live in `bench/suites/<task>/`, outside every task repository.
   - Grading refuses a suite that sits inside the task repository, or any of whose files exist as a blob anywhere in that repository's object database (any branch, any history).
   - Agents run on a fresh checkout of the task repository at the pinned commit, so the suite isn't there, isn't in git history, and isn't in the environment. A Docker test runs an agent stage that searches the filesystem, `env` and `git log --all -p` for a canary planted in the suite, and finds nothing.
3. **Grader-owned paths and their ancestors.**
   - A patch fails with `grader_owned_path` before anything is created or run if it touches any of these, or **any ancestor** of them (both sides of renames, compared case-insensitively):
     - the suite's `install_to/**`;
     - `.quarterback.json`;
     - the spec's `owned_paths`.
   - Replacing `test` with a symlink redirects `test/hidden`, so ancestors count.
4. **Checkout.** A fresh checkout of `repo.base_rev`, which holds trusted content only; lockfiles must be regular files that hash as the spec says.
5. **Install.**
   - The hidden suite is written into that checkout with **no-follow, beneath-root writes** (`safeInstall`):
     - every ancestor must be absent (then created one level at a time) or a real directory;
     - files are created `O_EXCL|O_NOFOLLOW`;
     - the final real path must stay beneath the checkout.
   - A symlinked or non-directory ancestor **in the base tree** fails closed (`grader_error unsafe_install_path`), with nothing written.
   - The suite is then committed as the graded base.
6. **Apply and run, inside the sandbox.**
   - The untrusted patch is **never applied on the host**. `runSandboxed({ noAgent: true, applyPatch, testCommand, baseTests: false })` runs a trusted stage in the agent image (`--network none`, no credentials) that `git apply`s it to the sandbox work tree; a patch that doesn't apply exits 42, which gives `fail patch_does_not_apply`.
   - Capture then runs. The **captured** change list is checked again for owned paths and ancestors, as defence in depth.
   - Then the suite's argv command runs with `--network none`, read-only dependencies and a scrubbed environment. There is no agent, no credentials and no inference egress.
   - A Docker test sets fake credentials in the host process and proves the suite sees neither them nor the network.
   - **Re-review 1:** the first version applied the patch on the host and then copied the suite through paths the patch controlled. The reviewer showed that a patch adding a symlink `test` → an outside directory made the grader write `hidden/duration.test.js` outside its checkout, before the sandbox ran. A later sandbox rejection can't undo a host write; now no host write happens after untrusted content exists.
7. **Classify** with `verify/tests.js` on the QB node:test report (QB-06).

## Outcomes

| Outcome | When | Scored? |
|---|---|---|
| `pass` | every non-reserved check passed | yes |
| `fail` | tests failed; the patch doesn't apply; it touches a grader-owned path; it breaks loading or startup (syntax error, collection failure, no or garbled report, zero tests, exit without failures); timeout; out of memory; dependency change without a lockfile | yes |
| `needs_adjudication` | only checks listed in the frozen spec's `suite.adjudicate_checks` remain undecided | no, it goes to adjudication |
| `grader_error` | unqualified or changed suite, grader changed since qualification, suite leaked into the repository, wrong base or lockfile, the suite command is missing | no, it's attrition |
| `infra_error` | Docker or sandbox unavailable, supervisor lost, cancelled | no, it's attrition |

Attributing a load failure to the patch is sound only because the suite is qualified: it loaded and passed on a known-correct implementation with this exact grader. A changed grader voids every qualification.

## Qualification and freezing

- `qualify()` grades the reference, which must `pass`, and at least two incorrect implementations, each of which must `fail` with `tests_failed`. Failing for another reason doesn't show the suite detects the wrong behaviour.
- A suite too weak to tell "5m" from "30s" is refused.
- `freeze()` needs a qualification whose suite hash still matches. Once a spec is frozen, its id + version can never change. A fix is a new version with a changelog entry recording the reason, the disclosure date and `after_viewing_results`. Version and split can't go backwards or switch.

## Blinded adjudication

- `prepare(items, { seed })` produces packets with a random item id, the prompt, the requirement, the adjudication rules, the patch and which checks are reserved. Packets carry **no** arm, trial id, internal QB verdict or timing.
- The order is shuffled from a recorded seed. The item → (trial, arm) map is returned separately as `qb-blind-map/1`.
- `record()` writes one file per (item, adjudicator) exclusively; a verdict is never edited.
- `summarize()` keeps every verdict. An item is `agreed` only when every adjudicator says the same pass or fail; disagreement and `unsure` stay visible, with no majority vote.
- **Limitation:** blinding can't hide patch style, so an adjudicator may still recognise an arm.

## In the benchmark

- `bench/run.js` loads a task's `spec` (a path relative to the task file), refuses it unless `checkFrozen` passes, and scores each arm with `gradeArm`.
- QB's L4 verdict is printed and stored as the internal verdict, never as the score.
- Tasks without a frozen spec are `ungraded`. The six legacy tasks still have no spec. The QB-30 dev set (`docs/bench/curation.md`) is written as frozen specs from the start, and specs name their repository as `qb-bench:<name>`, which the grader resolves to the reproducible build (`bench/repos.js`).
- Arm budgets, ablations and memory isolation are QB-28. Experiment records and the matched report are QB-29.

## Tests

- **Re-review 1 regressions** (unit, every Node version): the reviewer's symlink repro and its case-variant `Test`, a base-tree symlinked ancestor, "the patch is never applied on the host" (the sandbox receives it; the host checkout is base + suite), a captured-change-list check, and `safeInstall` edge cases.
  - Each asserts that nothing was written outside the checkout and that the sandbox was never invoked.
  - Pre-fix, the repro and the base-tree case wrote `hidden/duration.test.js` outside.
  - Docker: a patch that doesn't apply fails inside the sandbox.
- **Unit** (`test/unit/qb27-grader.test.js`, 17 tests): these use the live node:test reporter, so they need Node 22+. They run on CI 22/24 and in the sandbox image (Node 24); on Node 20 they are skipped.
- **Docker** (`test/integration/qb27-grader.test.js`): qualification plus the 30s / 5m / syntax cases, no network or credentials, and the agent-side canary search.
