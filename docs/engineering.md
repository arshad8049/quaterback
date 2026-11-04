# Quarterback engineering reference

How Quarterback (QB) works today: the pipeline, what each stage does, how verdicts are decided, and how it is tested and evaluated. For installing and running QB, see the [README](../README.md) and [onboarding](onboarding.md). The supported surface is [support.md](support.md). The previous README, with its dated status notes, is kept as a [historical snapshot](history/readme-2026-10.md).

Review findings are referred to by their ids (QB-01 to QB-38). They are tracked in [review/issue-register.md](review/issue-register.md); Jira is authoritative.

---

## Pipeline

```
Developer request
       │
       ▼
┌──────────────────┐
│  1. INTENT       │  Ambiguity pre-filter + repository survey → local model
│     intent/      │  (QB_MODEL via Ollama) → proposed contract → human approval
└────────┬─────────┘
         ▼
┌──────────────────┐
│  2. CONTEXT      │  Parser-based symbol index, ranked retrieval over imports
│     context/     │  and callers, test associations, git activity; optional
│                  │  model pass writes an agent brief
└────────┬─────────┘
         ▼
┌──────────────────┐
│  3. AGENT        │  Agent briefing from contract + context; the coding agent
│     agent/       │  (claude-code adapter) runs in the QB sandbox; trusted code
│     lib/sandbox/ │  captures the resulting tree as a patch
└────────┬─────────┘
         ▼
┌──────────────────┐
│  4. VERIFICATION │  Tests and executable checks in the sandbox on the captured
│     verify/      │  tree; scope policy; independent judge for non-behavioural
│                  │  criteria; aggregate verdict; failures routed to repair
└────────┬─────────┘
         ▼
┌──────────────────┐
│  5. MEMORY       │  Per-repository outcome and repair store; recall seeds
│     memory/      │  context and repair hints on later runs
└────────┬─────────┘
         ▼
   Verdict + run record + exportable patch
```

`qb.js` is the CLI entry point. `lib/qb-pipeline.js` (`runPipeline`) is the shared pipeline, also used by the benchmark arms. A failed verdict sends structured repair hints back to stage 3, up to `--max-retries` (1–10, default 3).

---

## Layer 1: Intent (`intent/`)

Turns a natural-language request into a proposed **task contract**: an approved checklist of requirements, constraints and checks.

- **Ambiguity pre-filter.** A rule engine flags vague wording ("cleaner", "more readable", "improve performance" without a metric) before any model call, and returns a clarifying question.
- **Grounding** (QB-17, [intent/grounding.md](intent/grounding.md)). `qb` and the standalone intent CLI compile with the same repository survey. A vague term blocks until the request defines it, or until an answer affirmatively selects one choice. There are up to 3 clarification rounds (`--clarify`, repeatable; `--clarify q=choice`; `--clarify "q=numeric_target:<value>"` for choices that need a value). QB's own suggestions are listed separately as `proposed_defaults` for the human to approve. Incomplete compiler output is rejected, not filled in.
- **Local model.** `QB_MODEL` (default `deepseek-r1:7b`) at `QB_OLLAMA_URL` (default `http://127.0.0.1:11434`).
- **Contract fields** (`intent/schema.js`): `goal`, `required_behavior`, `constraints`, `acceptance_criteria` (each `behavioral` or `non_behavioral`, linked to `requirement_ids`), `verification_plan`, `checks` (executable, from the check registry), `requirements` (traced to the request), `scope` (`allowed_changes`, `protected_paths`), `constraint_policy`, `test_policy`, `proposed_defaults` and `clarifications`.
- **Traceable requirements** (QB-14, [verify/traceability.md](verify/traceability.md)). Every request clause becomes a requirement with a verbatim quote, and each requirement must be covered by criteria. Unsupported additions and duplicates block execution. Negation, numbers and operators count toward coverage.
- **A human approves the test oracle** (QB-13, [verify/test-oracle.md](verify/test-oracle.md)). The model's contract is only a proposal, and QB recomputes its examples with trusted arithmetic. A PASS needs a human-approved contract: approved in the terminal, or by passing a reviewed `--contract-file`. The approval is frozen by hash, so any later change voids it.
- **One correction of QB's own draft** (KAN-103, [intent/grounding.md](intent/grounding.md#one-correction-of-qbs-own-draft-kan-103)). A generated contract the validator rejects goes back to the compiler once, with the validation errors, inside the run deadline. The correction goes through the same validator and may not keep a default the first draft left uncovered. A `--contract-file` is never rewritten.
- **Only a finalized contract runs** (`intent/contract-state.js`). That means a goal, non-empty acceptance criteria with unique ids, and no open clarifying question. Anything else is `unresolved`, and the agent never runs.

```bash
cd intent && npm install
node cli.js "Add email verification to signup" --repo ../myapp --save
```

---

## Layer 2: Context (`context/`)

Grounds the contract in the repository.

- **Symbol index** (QB-19, [context/symbols.md](context/symbols.md)). JavaScript (CJS and ESM) is parsed with acorn. Every export, alias, class method and top-level declaration gets a qualified id (`path#name`) and its real source span. Files are indexed whole up to 256 KiB; larger or unparsable files are recorded in `index_limits`, never dropped silently.
- **Retrieval** (QB-18, [context/retrieval.md](context/retrieval.md)). Files are ranked by symbol and content matches to the contract. Imports and callers are followed to a bounded depth, with each file's reason recorded. The file and byte budget and every omission are explicit in the package. After each attempt, the context is refreshed with the patch's new and changed files.
- **Test associations, not coverage** (QB-20, [context/test-associations.md](context/test-associations.md)). A test file matched by name is reported as a `test_association`. Real coverage appears only from a report the repository already has (`coverage/lcov.info`, `coverage/coverage-final.json`).
- **Optional model pass** ranks files and writes an agent brief. `--no-llm-context` skips it.

```bash
cd context && npm install
node cli.js --contract ../intent/contracts/<id>.json --repo /path/to/repo --save
```

---

## Layer 3: Agent (`agent/`, `lib/sandbox/`)

- **Briefing** (`agent/briefing.js`). A markdown briefing built from the contract and context: goal, acceptance-criteria checklist, symbol map, relevant files with their import graph, test files, agent brief and verification plan. Hidden executable checks are not shown to the agent.
- **Adapters** (`agent/adapters.js`, interface `qb-agent-adapter/1`; [support.md](support.md)). `claude-code` is the only adapter that executes code and the only one that can end in `pass`. `dry-run` (the default) compiles the contract and briefing only. `manual` prints the briefing for your own agent and ends `unresolved`. Unsupported agents and invalid options are refused before any model call (exit 2).
- **Sandbox** ([security/agent-sandbox.md](security/agent-sandbox.md)). Each run seeds a disposable workspace from a read-only copy of the checkout. During the agent stage, egress is limited to the Claude inference endpoint through a policy proxy; dependency installs go to the npm registry through a separate proxy. The user's files and `.git` are never written. Changes are captured by trusted code as a git tree and exported with `qb patch <run_id>`, which labels the patch with its verification status.
- **Admission** (`lib/sandbox/admission.js`). A claude-code run is admitted only with about 11.1 GiB of memory free. QB unloads a local Ollama model before the sandbox starts.
- **Authentication.** `qb auth login` stores a QB-scoped Claude Code login in a Docker volume, and the user's own `~/.claude` is neither used nor changed. Alternatively, `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` in the environment is passed through by name and redacted from run records.

---

## Layer 4: Verification (`verify/`)

Verification never sees the original request or the briefing, and nothing it trusts comes from the agent's own account of what it did. All evidence is gathered inside the sandbox on the exact captured tree.

**Evidence:**
- **Test suite.** The repository's own test command runs on a disposable copy, with protected tests restored to their base versions. QB's node:test reporter writes a machine-readable report, which `verify/tests.js` validates for completeness and count consistency. The run is classified as `passed`, `failed` (a real failing test), `error` (timeout, OOM, crash, load failure, cancelled tests, zero tests, unreadable report) or `not_run`. Console output decides nothing. Only node:test verifies; any other runner is refused before an agent run.
- **Executable checks** (QB-16, [verify/executable-checks.md](verify/executable-checks.md)). Checks come from a versioned registry (`verify/checks/registry.js`, `qb-checks/2`): `module_exports`, `call_returns`, `call_throws` and `call_sequence`, with typed JSON parameters. QB's runner runs them, never as shell text.
- **Independent judge.** Only for criteria marked `non_behavioral` (documentation, naming, wording). It uses a strict JSON judgment schema, and malformed output is `invalid_judgment`. `--no-llm-verify` skips it.

**Per-criterion decision:**
- a behavioural criterion is met only through its executed checks;
- a failing check means not met;
- no check means `unresolved`.

**Attempt verdicts** (`verify/verdict.js`):

| Verdict | Meaning |
|---|---|
| `pass` | Every criterion met and the tests passed (or failed only where an approved policy waives pre-existing failures) |
| `fail` | A criterion not met, a real failing test, or a protected/policy violation |
| `partial` | Some criteria could not be decided |
| `unresolved` | Verification could not establish the result (missing evidence, no checks, tests not run, unapproved oracle, unsupported changes) |
| `error` | The execution itself failed: timeout, OOM, infrastructure, setup or cancellation |
| `no-diff` | No change to verify (always the case for a dry run) |

An agent that changed nothing passes only if the requirement is independently verified on the unchanged tree.

**Run outcomes** (`run/store.js`): `VERIFIED` (pass), `FAILED` (fail), `UNRESOLVED` (partial, unresolved, or no-diff on a real run), `ERROR`, `BLOCKED` (for example, contract not approved or setup refused), `CANCELLED` (deadline or signal), `DRY_RUN` and `ABANDONED`. `qb` exits 0 only for `pass`.

**Policy and routing:**
- **Scope and constraints** (QB-09, [verify/scope-policy.md](verify/scope-policy.md)). The approved contract lists `scope.allowed_changes`, `protected_paths`, and how each constraint is enforced. A protected change fails the task. An unauthorized change, or an unenforced constraint, can't pass.
- **Failure routing** (QB-10, [verify/failure-routing.md](verify/failure-routing.md)). When the candidate's tests fail, the same suite runs on the base tree. Only new failures are regressions, and each gets a repair action with its evidence. Pre-existing failures stay listed. Infrastructure errors go to environment recovery, and an unchanged patch stops the loop.
- **Judge evidence** (QB-11, [verify/evidence.md](verify/evidence.md)). The judge sees whole changed hunks, ranked within a budget, plus the definitions of helpers the change calls, resolved through the module's actual export binding. Every item has an immutable `EV-…` id with file, range, blob and hash. Missing material evidence makes the criterion unresolved. What retrieval does not cover (callers, dynamic dispatch, package imports) is stated to the judge every time.
- **Calibrated judging** (QB-15, [verify/calibration.md](verify/calibration.md)). A judgment is cached per evidence, so an unchanged patch is never resampled into a pass. Preservation criteria must name the tests they preserve (`preserves.tests`). `bench/judge-calibration.js` measures false accepts, false rejects and abstentions separately, on labelled patches. The initial calibration covers 13 human-labelled patches; it does not establish production accuracy.
- **Deadlines and cancellation** (QB-21, [verify/deadlines.md](verify/deadlines.md)). Every model call has a deadline (`QB_MODEL_CALL_TIMEOUT_MS`). `--deadline <minutes>` cancels the run, including its sandbox containers, and ends it `CANCELLED`, naming the interrupted stage. Timed-out commands are killed with their whole process tree. Model calls run concurrently, bounded by `QB_MODEL_CONCURRENCY`. Stage time and token usage are recorded; unreported usage is recorded as unknown, never as zero.

**Run records** (`run/store.js`, QB-38). Every run keeps a versioned, append-only record in `~/.qb/runs` (or `QB_RUNS_DIR`): base commit, agent version, contract, patch, test outcome, checks and report. `qb replay <run_id>` recomputes each verdict and the final outcome from the stored evidence; it does not rerun the agent or the tests.

---

## Layer 5: Memory (`memory/`)

- **Store** (QB-25, [memory/store.md](memory/store.md)). JSONL under `QB_MEMORY_DIR` (default `~/.quarterback/memory`). Writes are locked per repository across processes, and stats are replaced atomically. Corrupt or truncated records are reported and quarantined, never silently dropped. Retention keeps the newest 10,000 outcomes.
- **Identity** (QB-24, [memory/identity.md](memory/identity.md)). Each repository's memory lives under `r2-<sha256 of its realpath>`. Negation and restrictions are preserved: "do not enable caching" never matches "enable caching", and an opposite-intent repair is never reused automatically. File hints must be plain paths that exist in the current checkout.
- **Recall.** A similarity scorer (no model call) surfaces file hints from past similar tasks into context, seeds repair hints for recurring criterion patterns, and shows similar past contracts.
- **Proven repairs** (QB-23, [memory/repairs.md](memory/repairs.md)). Every repair hint is linked to the next patch and its criterion's re-evaluation. Only a criterion fixed on a changed patch, in a run that ends in an approved PASS, counts as a proven repair.

---

## Tests and CI

```bash
npm test                    # unit suite (no Docker, no model, no network)
npm run test:integration    # sandbox integration suite (needs Docker; QB_INTEGRATION=1)
npm run test:daemon         # Docker-daemon-stop lifecycle test (Linux CI only; stops dockerd)
```

CI (`.github/workflows/ci.yml`) runs on every push:
- the unit suite on Node 20, 22 and 24;
- the Docker integration suite and the daemon-stop test on ubuntu-24.04 with Docker Engine.

Every job publishes an evidence record (`scripts/ci-evidence.js`): the runtime and pinned agent version, timeouts, models called (none; the job fails if a model credential is present) and test counts, with known-defect TODOs listed by name. Failing tests are also published as public GitHub annotations.

---

## Evaluation status

| Item | Status |
|---|---|
| Unit tests | 757 passed, 0 failed at the 2026-10-08 checkpoint (below); CI is green on `main` at `908adbd` ([run 38853426312](https://github.com/arshad8049/quaterback/actions/runs/38853426312)) |
| Docker image-pinning checks | 2 passed using real Docker containers |
| Paired sandbox integration | Blocked by resource admission before grading completed at that checkpoint |
| Development task set | 30 frozen tasks across 5 repositories ([frozen specs](../bench/specs)) |
| Exploratory dev pilot (2026-10-12) | Claude Code alone 30/30, with Quarterback 29/30, 1 run each ([run 38307663205](https://github.com/arshad8049/quaterback/actions/runs/38307663205)). The baseline solves every task, so this set cannot show a difference. Not evidence |
| Exploratory harder-task screen (2026-10-13) | 14 real Fastify v5 bug fixes, 2 runs each: 28/28 in both arms, after rerunning 8 agent execution failures ([run 38409518314](https://github.com/arshad8049/quaterback/actions/runs/38409518314), [rerun 38459455639](https://github.com/arshad8049/quaterback/actions/runs/38459455639)). Tasks were chosen for difficulty, so this is never headline evidence. It also found that Quarterback's own verdict rejected correct patches on this repository. The false regressions behind that are fixed (KAN-65, accepted); no rerun has been made since |
| Controlled performance results | Not yet available |
| Independent holdout | Authoring and protocol review pending |

The test results come from a founder-run engineering checkpoint on 2026-10-08 (Ubuntu ARM64, commit `99682a6`), reviewed from supplied logs; it is not independent validation. Its integration tests use a scripted agent and mocked model responses. [Evidence, commands and logs](https://quaterback.velorallc.workers.dev/evidence/2026-10-08-ubuntu-arm64.html).

The fresh-machine onboarding walkthrough (QB-31) passed on 2026-10-12 in a GitHub Codespace (Ubuntu 24.04, 4-core / 16 GB) at commit `54c2f24` ([record](review/qb31-walkthrough.md)). That validates that revision and environment, not later revisions.

**Legacy record (tuned during development, ungraded).** An earlier six-task suite on one repository (`cue`, Sep 2026) is kept as a record, not as evidence: QB wrote the contract that graded both sides, only QB's agent saw it, the baseline got less time, and the reported table mixed runs from different versions (review findings QB-27 to QB-30). Those tasks are excluded from the controlled evaluation. Logs are in [test-runs.md](test-runs.md).

---

## Benchmark harness (`bench/`)

Scores come only from the external grader (`bench/grader.js`, QB-27): a frozen, human-written task spec and a hidden check suite, the same for both arms. QB's own verdict is recorded but is never a score; a task without a frozen spec is "ungraded". Experiments are immutable and pinned (`bench/experiment.js`, QB-29). Details: [bench/experiments.md](bench/experiments.md), [bench/protocol.md](bench/protocol.md), [bench/grader.md](bench/grader.md), [bench/curation.md](bench/curation.md).

```bash
node bench/report.js <experiment-dir> [--format table|markdown|json] [--allow-mixed]
node bench/report.js --legacy bench/results       # old result files, labelled "pre-QB-29, not comparable"
node bench/curate.js qualify <ID|all>
```

`bench/run.js` runs the legacy six-task suite above. Don't `require()` it: it's a script, and loading it starts the benchmark.

---

## Landing page (`landing_page/`)

A static site assembled by `build.js` from section files in `src/`, deployed on Cloudflare (Workers static assets, `wrangler.toml` at the repository root) from `main`. The Worker (`landing_page/_worker.js`) handles beta signup, opt-in telemetry and the admin report; its data flows are in [privacy/data-flows.md](privacy/data-flows.md).

```bash
cd landing_page
node build.js  # regenerates index.html; never edit index.html directly
```

---

## Stack

- **Runtime:** Node.js (20 or newer), no framework; native `fetch`, `child_process`, `fs`
- **Parsing / validation:** acorn, Zod
- **CLI:** Commander.js
- **Local model:** Ollama (`QB_MODEL`, default `deepseek-r1:7b`) for the intent, context and judge stages
- **Coding agent:** Claude Code CLI, in a Docker sandbox
- **Site:** Cloudflare Workers, D1
