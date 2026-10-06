# Quarterback

> *Intent to verified result — without a human in the loop.*

Quarterback is a 5-layer AI reliability runtime for software teams. It sits between a developer's natural-language request and the shipped diff, enforcing correctness at every stage: intent capture, context grounding, agent execution, independent verification, and memory.

---

## Status

- 21 of the original 38 engineering findings are fixed and accepted in internal review (Phases 0–2, merged into `main`, tag `phase-0-2-accepted`).
- Coding-agent runs require an approved contract. Changing the contract requires approval again ([test oracle](docs/verify/test-oracle.md)).
- Requirement tracing catches omitted instructions, including missing negation, before execution ([traceability](docs/verify/traceability.md)).
- Behavioral requirements are checked through executable tests in the sandbox. Protected-file edits fail scope checks ([executable checks](docs/verify/executable-checks.md), [scope policy](docs/verify/scope-policy.md)).
- The judge receives traceable evidence, including supported unchanged helpers. Known missing material evidence prevents a positive judgment from passing ([evidence](docs/verify/evidence.md)).
- Repeated and concurrent verification of identical evidence reuses one cached judgment instead of resampling until it passes ([calibration](docs/verify/calibration.md)).
- Requests are grounded in repository context. Unresolved choices and incomplete numeric targets stay blocked ([grounding](docs/intent/grounding.md)).
- Accepted work has regression coverage and CI across Node 20, 22 and 24, plus Docker integration tests.
- Initial judge calibration covers 13 human-labeled patches. It measures false approvals, false rejections and abstentions separately; it does not establish production accuracy.
- Phase 3 work on deadlines, cancellation and repair memory is underway (branch `phase-3-context-memory`). Quarterback is still in development, with an independent-oracle benchmark rerun and supervised beta ahead.

---

## The Problem

Current AI coding tools produce output that **compiles, passes tests, and looks correct in the diff — and is still wrong.**

The backend field exists, but the frontend never sends it. A new auth path quietly bypasses onboarding. One requirement from the original request is silently omitted. Tests validate the implementation instead of the requirement.

These are not edge cases. They are the default failure mode of unstructured AI coding.

**Data:**
- **66%** of professional developers say AI gives solutions that are *almost right, but not quite*
- Only **4.4%** say AI handles complex tasks well
- **46%** actively distrust AI accuracy — up from 33% in 2024
- **45.2%** say debugging AI-generated code takes *more time* than writing it themselves

*Source: [Stack Overflow 2025 AI Developer Survey](https://survey.stackoverflow.co/2025/ai#developer-tools-ai-complex-ai-complex-prof-exp) — 65,000+ professional developers*

---

## The Architecture

```
Developer Request
       │
       ▼
┌─────────────────┐
│  1. INTENT      │  DSA ambiguity pre-filter (0ms) → local LLM (DeepSeek-R1:7b
│  ✅ LIVE        │  via Ollama) → Task Contract with goal, behaviors, constraints,
│                 │  acceptance criteria. No API key. No cloud.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. CONTEXT     │  Deterministic pass: symbol extraction, import graph (2 levels
│  ✅ LIVE        │  deep), test finder, framework/architecture detection, git
│                 │  activity. Optional LLM pass ranks files + writes agent brief.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. AGENT       │  Builds a structured Agent Briefing from contract + context
│  ✅ LIVE        │  (symbol map, AC checklist, file intelligence). Invokes coding
│                 │  agent (Claude Code) and captures the resulting git diff.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. VERIFICATION│  Independent per-AC judgment: runs test suite, checks diff
│  ✅ LIVE        │  scope, scans for AC keywords (DSA), then asks a separate LLM
│                 │  instance to judge each criterion. Verdict: pass/fail/partial.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  5. MEMORY      │  Per-repo JSONL store. Jaccard-similarity scorer. Recalls
│  ✅ LIVE        │  prior task outcomes, file hints, and repair patterns on
│                 │  every run — seeded before L2 context build.
└─────────────────┘
         │
         ▼
  Verified Result
```

---

## Benchmark Results

> These are early, pre-review results. They will be re-run with an independent oracle in Phase 4 of the hardening plan (QB-27 to QB-30).

Evaluated on 6 curated tasks against the `cue` repo (Electron JS, 27 tests, real production codebase). Compared QB full pipeline vs raw `claude --print` baseline with no pipeline. Same L4 contract applied to both.

| | QB Pipeline | Raw Baseline | Lift |
|---|---|---|---|
| **Pass rate** | 4/6 (67%) | 2/6 (33%) | **+34pp** |
| First-attempt pass rate | 2/6 (33%) | — | — |
| Avg attempts (QB) | 1.33 | — | — |
| Avg time (QB) | ~253s | — | — |
| API keys required | **0** | 0 | — |

**Key findings:**
- Repair loop recovered 2 failed tasks (T-001, T-004) — baseline failed T-004 completely
- QB's structured contract caught edge-case ACs that baseline missed entirely (T-002: invalid input, negative numbers, hours formatting)
- All LLM calls (L1/L2/L4) run via local Ollama — zero per-call cost across 30 pipeline executions
- Memory layer active by run 3: `src/llm.js` recalled at sim=1.00, prepended to L2 context automatically

**Task breakdown:**

| ID | Difficulty | QB Result | Attempts | Baseline |
|---|---|---|---|---|
| T-001 | easy | PASS | 2 | PASS |
| T-002 | easy | PASS | 1 | FAIL (3/6 ACs missed) |
| T-003 | easy | PASS | 1 | PASS |
| T-004 | medium | PASS | 2 | FAIL |
| T-005 | medium | PASS | 2 | — |
| T-006 | hard | PASS | 2 | — |

*Full benchmark logs: `docs/test-runs.md`*

> **Note:** T-005 and T-006 initially failed due to a bug in `bench/run.js` `resetRepo()` — `git checkout -- .` doesn't remove untracked files. Fixed by adding `git clean -fd`. Both tasks pass after the fix. The +34pp lift figure is from the initial 4-task comparison where baseline also ran.

---

## What Makes This Different

| | Standard AI coding | Quarterback |
|---|---|---|
| Ambiguity detection | None — agent guesses | Repository-grounded intent; unresolved choices and incomplete numeric targets stay blocked |
| Test oracle | The agent's own judgment | A human-approved contract; changing it requires approval again |
| Context for agent | Raw request | Symbol map, import graph, associated tests, git activity |
| Verification | Developer reviews diff | Executable tests in the sandbox for behaviour; an independent judge with traceable evidence for the rest |
| Cost | Per-call API fees | Fully local — DeepSeek-R1:7b via Ollama, no API key |
| Scope drift | Common | Enforced policy: protected-file edits fail scope checks |
| Agent isolation | Runs on your machine | Sandboxed: disposable workspace, no network except the Claude API, your files never written |
| Repair loop | Manual re-run | Auto: L4 failures → structured hints → L3 re-execution |
| Memory | None | Per-repo JSONL, Jaccard recall, seeds context on next run |

---

## Repository Structure

```
quaterback/
├── README.md
├── qb.js              ← Root orchestrator (full L1→L5 pipeline)
├── intent/            ← Layer 1: Intent Compiler
├── context/           ← Layer 2: Context Engine
├── agent/             ← Layer 3: Agent Orchestrator
├── verify/            ← Layer 4: Verification Engine
├── memory/            ← Layer 5: Memory Store
├── bench/             ← Benchmark harness (run.js, report.js, tasks.json)
├── docs/              ← test-runs.md, architecture notes
└── landing_page/      ← Marketing site (live on Cloudflare: quaterback.velorallc.workers.dev)
```

---

## Layer 1: Intent Compiler (`intent/`)

Transforms a developer's natural-language request into a validated **Task Contract**.

**Two-stage design:**
1. **DSA pre-filter** — regex rule engine catches vague patterns at 0ms. Fires on "cleaner", "better + refactor", "more readable", "like normal", "improve performance without a metric". Returns a clarifying question before any LLM is called.
2. **Local LLM** — DeepSeek-R1:7b via Ollama produces the structured contract.

**Task Contract output:**
```json
{
  "id": "uuid",
  "goal": "one-sentence objective",
  "required_behavior": ["Observable behavioral statement"],
  "constraints": ["What the implementation must NOT do"],
  "acceptance_criteria": [{ "id": "AC-1", "criterion": "...", "met": null }],
  "verification_plan": ["Specific steps for the verifier"],
  "clarifying_question": null
}
```

```bash
cd intent && npm install
node cli.js "Add email verification to signup" --repo ../myapp --save
node sandbox/run.js --all   # 6 fixtures including full vague→clarify→compile loop
```

---

## Layer 2: Context Engine (`context/`)

Grounds the Task Contract in the actual codebase.

**Two-stage design:**
1. **DSA pass** — symbol extraction (ESM + CJS `module.exports = {…}`), import graph 2 levels deep, test file finder, framework/architecture detector from `package.json`/`go.mod`, git activity per relevant file. ~500ms on a 24-file repo.
2. **LLM pass** (optional, `--no-llm` skips) — ranks files and writes an agent brief.

**ContextPackage output:** relevant files with symbols and import graph, symbol map (`createLLM → src/llm.js:96`), test coverage, git activity, agent brief.

```bash
cd context && npm install
node cli.js --contract ../intent/contracts/<id>.json --repo /path/to/repo --save
```

---

## Layer 3: Agent Orchestrator (`agent/`)

Builds a structured **Agent Briefing** and invokes the coding agent.

**Stage 1 (DSA — 0ms):** Assembles a 140+ line markdown briefing from the contract + context: goal, AC checklist, symbol map, relevant files with import graph, test files, agent brief, verification plan.

**Stage 2 (Execution):** Invokes the coding agent (`claude --print` subprocess) and captures the resulting git diff as a structured Changeset.

---

## Layer 4: Verification Engine (`verify/`)

Independent verification. It never sees the original request or the briefing, and nothing it trusts comes from the agent's own claims.

**Only a finalized contract is verified** (`intent/contract-state.js`). That means a goal, non-empty acceptance criteria (ACs) with unique ids, and no open clarifying question. Anything else is `unresolved`, and the agent never runs.

**Evidence, all gathered inside the sandbox on the exact captured tree:**
- **Test suite (stage ⑤).** The repository's own `npm test` runs on a disposable copy, with protected tests restored to their base versions. QB's node:test reporter writes a machine-readable report, which `verify/tests.js` validates for completeness and count consistency. The run is classified as `passed`, `failed` (a real failing test), `error` (timeout, OOM, crash, load failure, cancelled tests, zero tests, unreadable report) or `not_run`. Console output decides nothing.
- **Executable checks (stage ⑥, QB-16).** The contract's checks come from a versioned registry (`verify/checks/registry.js`, `qb-checks/1`): `module_exports`, `call_returns` and `call_throws`, with typed JSON parameters. They are run by QB's runner, never as shell text, and are not shown to the agent. Design: [docs/verify/executable-checks.md](docs/verify/executable-checks.md).
- **Independent judge.** Only for criteria marked `non_behavioral` (documentation, naming, wording). It uses a strict JSON judgment schema, and malformed output is `invalid_judgment`. For a no-change run, it reads the files of the tested tree, exported by trusted code.

**Per-criterion decision:**
- a behavioural criterion is met only through its executed checks;
- a failing check → not met;
- no check → explicit `unresolved`.

**Verdicts:**
- `pass`: every criterion met and the tests passed;
- `fail`: a criterion not met, or a real failing test;
- `partial` / `unresolved`: anything that couldn't be verified;
- `error`: the agent run failed;
- `no-diff`.

An agent that changed nothing passes only if the requirement is independently verified on the unchanged tree.

**A human approves the test oracle** (QB-13, [docs/verify/test-oracle.md](docs/verify/test-oracle.md)):
- the model's contract is only a proposal, and QB recomputes its examples with trusted arithmetic;
- a PASS needs a human-approved contract, approved in the terminal or by passing a reviewed `--contract-file`;
- the approval is frozen by hash, so any later change voids it.

**Scope and constraints are enforced policy** (QB-09, [docs/verify/scope-policy.md](docs/verify/scope-policy.md)):
- the approved contract lists `scope.allowed_changes` and `protected_paths`, and how each constraint is enforced;
- a protected change fails the task;
- an unauthorized change, or an unenforced constraint, can't pass.

**Failure routing** (QB-10, [docs/verify/failure-routing.md](docs/verify/failure-routing.md)):
- when the candidate's tests fail, the same suite runs on the base tree;
- only new failures are regressions, and each gets a repair action with its evidence;
- pre-existing failures stay listed;
- infrastructure errors go to environment recovery, and an unchanged patch stops the loop.

**Traceable requirements** (QB-14, [docs/verify/traceability.md](docs/verify/traceability.md)):
- every request clause is a requirement with a verbatim quote;
- each requirement must be covered by criteria;
- unsupported additions and duplicates block execution;
- `call_sequence` checks prove behaviour over time.

**Repairs that are actually proven** (QB-23, [docs/memory/repairs.md](docs/memory/repairs.md)):
- every repair hint is linked to the next patch and to its criterion's re-evaluation;
- only a criterion fixed on a changed patch in a run that ends in an approved PASS counts as a proven repair;
- unconfirmed, unresolved and abandoned suggestions are kept, labeled, and never recalled as proven fixes.

**A safe memory store** (QB-25, [docs/memory/store.md](docs/memory/store.md)):
- the store path is injected (`createMemory({ root })`), not captured at import;
- writes are locked per repository across processes, and stats are replaced atomically;
- corrupt or truncated records are reported (line, offset) and quarantined, never silently dropped;
- retention keeps the newest 10,000 outcomes; recall at that size takes ~51 ms.

**Memory never mixes repositories or opposite instructions** (QB-24, [docs/memory/identity.md](docs/memory/identity.md)):
- each repository's memory lives under a collision-resistant identity (`r2-<sha256 of its realpath>`); old path-sanitized namespaces are ignored and reported, never merged;
- negation is preserved: "do not enable caching" is never similarity 1 with "enable caching", and an opposite-intent repair is never reused automatically;
- file hints must be plain paths that exist in the current checkout; a record from an incompatible revision is stale; hints from failed runs are ranked and labelled apart from passing ones.

**Judge evidence with provenance** (QB-11, [docs/verify/evidence.md](docs/verify/evidence.md)):
- the judge sees whole changed hunks, ranked within a budget (no silent 6,000-character cut);
- it also sees the definitions of the helpers the change calls, from the tested tree, unchanged code included — resolved through the module's actual export binding, never the first declaration;
- every item has an immutable `EV-…` ID with file, range, blob and hash;
- missing material evidence makes the criterion unresolved, naming the missing artifact (including a changed file whose own source could not be exported);
- what retrieval does not cover (callers, dynamic dispatch, package imports) is stated to the judge every time.

**Calibrated judging** (QB-15, [docs/verify/calibration.md](docs/verify/calibration.md)):
- a judgment is cached per evidence, so an unchanged patch is never resampled into a pass;
- preservation criteria must name the tests they preserve (`preserves.tests`) and are decided by the test report;
- `bench/judge-calibration.js` measures false accepts, false rejects and abstentions separately, on labeled patches.

**Grounded intent, bounded clarification** (QB-17, [docs/intent/grounding.md](docs/intent/grounding.md)):
- `qb` and the standalone intent CLI compile with the same repository survey;
- a vague word ("cleaner") blocks only until the request defines it, or an answer to that question affirmatively selects one choice — mentioning options, negating or deferring keeps it open;
- up to 3 clarification rounds (`--clarify` is repeatable; select a choice by id with `--clarify cleaner=improve_naming`), with a machine-readable handoff state;
- a choice that needs a value (a numeric target) stays open until a valid target is given (`--clarify "improve_unmeasured=numeric_target:p95 latency < 200ms"`); the target is recorded in the approved contract;
- QB's own choices are separate "proposed defaults" that the human approves;
- incomplete compiler output is rejected, not filled in.

**Deadlines and cancellation** (QB-21, [docs/verify/deadlines.md](docs/verify/deadlines.md)):
- every model call has a deadline (`QB_MODEL_CALL_TIMEOUT_MS`);
- `qb --deadline <minutes>` cancels the run, including its sandbox containers, and ends it CANCELLED, naming the interrupted stage;
- timed-out commands are killed with their whole process tree;
- telemetry is bounded to 3 s;
- model calls run concurrently, bounded (`QB_MODEL_CONCURRENCY`);
- stage time and tokens are recorded.

**Parser-based symbol index** (QB-19, [docs/context/symbols.md](docs/context/symbols.md)):
- JavaScript (CJS and ESM) is parsed: every export, alias, class method and top-level declaration gets a qualified ID (`path#name`) and its real source span;
- whole files are indexed up to 256 KiB, and larger or unparsable files are recorded in `index_limits`, never dropped silently;
- duplicate names across files no longer overwrite each other.

**Run records** (`run/store.js`, QB-38). Every run keeps a versioned, append-only record: base commit, agent version, contract, patch, test outcome, checks and report. `qb replay <run_id>` recomputes each verdict and the final outcome from the stored evidence.

---

## Layer 5: Memory (`memory/`)

Per-repo outcome store with semantic recall.

**Storage:** JSONL files in `~/.quarterback/memory/<repo-slug>/`. Two indexes: `outcomes.jsonl` (contracts + verdicts) and `repairs.jsonl` (failed ACs + hints that resolved them).

**Recall:** Jaccard similarity scorer (no LLM, no I/O, pure DSA). Before each run:
- `recallFiles()` — surfaces file hints from past similar tasks, prepended to L2 context
- `recallRepairs()` — seeds repair hints for recurring AC patterns
- `recallPrior()` — shows top-5 similar past contracts at L1 output time

---

## Running the Full Pipeline

> **The coding agent runs in the QB sandbox** ([design](docs/security/agent-sandbox.md)). Each run seeds a disposable workspace from a read-only copy of your checkout. The agent gets no network except the Claude API through a policy proxy, and your files and `.git` are never written. Changes are captured by trusted code and handed back as a patch (`qb patch <run_id>`) for you to apply. Requires Docker. Sign in once with `qb auth login` (subscription), or set `ANTHROPIC_API_KEY`. Validated platform: Linux x86_64 + Docker Engine; Docker Desktop on macOS works for development but is not yet validated.

```bash
# From quaterback/ root:
npm install
node qb.js "Add a getProviderName() function to src/llm.js that returns the active provider name" --repo /path/to/repo

# Options:
node qb.js "..." --repo /path --no-llm-context   # skip LLM in L2 (fast, offline)
node qb.js "..." --repo /path --no-llm-verify    # skip LLM in L4 (DSA-only verify)
node qb.js "..." --repo /path --max-retries 5    # up to 5 repair attempts
```

## Tests and CI

```bash
npm test                    # unit suite (no Docker, no model, no network)
npm run test:integration    # sandbox integration suite (needs Docker; QB_INTEGRATION=1)
npm run test:daemon         # Docker-daemon-stop lifecycle test (Linux CI only; stops dockerd)
```

CI (`.github/workflows/ci.yml`) runs on every push:
- the unit suite on **Node 20, 22 and 24**;
- the Docker integration suite and the daemon-stop test on ubuntu-24.04 + Docker Engine.

Every job publishes an evidence record (`scripts/ci-evidence.js`) covering:
- the runtime and the pinned agent version;
- timeouts and the models called (none; $0, and the job fails if a model credential is present);
- test counts, with the known-defect TODOs listed by name.

Failing tests are also published as public GitHub annotations. Review findings are tracked in [docs/review/issue-register.md](docs/review/issue-register.md); Jira is authoritative.

## Running the Benchmark

```bash
cd bench && npm install
node run.js                     # run all 6 tasks
node run.js --task T-005        # single task
node run.js --no-baseline       # QB only (faster)
node report.js                  # table report
node report.js --format markdown
```

---

## Landing Page

Static HTML site assembled by `build.js` from 15 section files in `src/`. Deployed on Cloudflare (Workers static assets, `wrangler.toml`) from `main`.

```bash
cd landing_page
node build.js  # regenerates index.html
```

**Never edit `index.html` directly.**

---

## Stack

- **Runtime:** Node.js — no framework, native `fetch`, `child_process`, `fs`
- **Schema validation:** Zod
- **Local LLM:** DeepSeek-R1:7b via Ollama (`http://127.0.0.1:11434`)
- **Coding agent:** Claude Code CLI (`claude --print`)
- **CLI:** Commander.js
- **Deployment:** Cloudflare (landing page), auto-deployed from `main`

---

## Company

Built by **Velora LLC** — [velorallc.netlify.app](https://velorallc.netlify.app)
