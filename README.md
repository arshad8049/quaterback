# Quarterback

> *Intent to verified result — without a human in the loop.*

Quarterback is a 5-layer AI reliability runtime for software teams. It sits between a developer's natural-language request and the shipped diff, enforcing correctness at every stage: intent capture, context grounding, agent execution, independent verification, and memory.

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
| Ambiguity detection | None — agent guesses | DSA regex rule engine, 0ms, before any LLM call |
| Context for agent | Raw request | Symbol map, import graph, test coverage, git activity |
| Verification | Developer reviews diff | Independent LLM judges each AC against the diff |
| Cost | Per-call API fees | Fully local — DeepSeek-R1:7b via Ollama, no API key |
| Scope drift | Common | Diff scope check flags unexpected file changes |
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
└── landing_page/      ← Marketing site (live on Netlify)
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

Independent verification — never sees the original request or the briefing. Only the diff and one AC at a time.

**Stage 1 (DSA):**
- Runs the test suite (detects jest/vitest/mocha/pytest/go-test/node:test from patterns)
- Diff scope check — flags files modified outside the relevant set
- Keyword signal scan — maps AC terms against the diff

**Stage 2 (LLM — independent):** One Ollama call per acceptance criterion. Verdict per AC: `met: true | false | null` with a one-sentence evidence string.

**Verdicts:** `pass` (all met) | `fail` (any false) | `partial` (any uncertain) | `no-diff`

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

> **Security warning: QB does not yet contain repository code.** It runs the coding agent and your project's test command directly on this machine, with your user's privileges, file access and network access. Use it only on repositories you fully trust. The containment design is in [`docs/security/agent-sandbox.md`](docs/security/agent-sandbox.md). It is experimental and not yet implemented, and this uncontained build is a development preview, not the supported beta.

```bash
# From quaterback/ root:
npm install
node qb.js "Add a getProviderName() function to src/llm.js that returns the active provider name" --repo /path/to/repo

# Options:
node qb.js "..." --repo /path --no-llm-context   # skip LLM in L2 (fast, offline)
node qb.js "..." --repo /path --no-llm-verify    # skip LLM in L4 (DSA-only verify)
node qb.js "..." --repo /path --max-retries 5    # up to 5 repair attempts
```

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

Static HTML site assembled by `build.js` from 14 section files in `src/`. Deployed on Netlify.

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
- **Deployment:** Netlify (landing page, free tier)

---

## Company

Built by **Velora LLC** — [velorallc.netlify.app](https://velorallc.netlify.app)
