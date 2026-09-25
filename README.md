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
│  5. MEMORY      │  Stores outcomes per contract — what was accepted, what was
│  ⬜ NEXT        │  caught, what patterns recur — feeds back into future layers.
└─────────────────┘
         │
         ▼
  Verified Result
```

---

## What Makes This Different

| | Standard AI coding | Quarterback |
|---|---|---|
| Ambiguity detection | None — agent guesses | DSA regex rule engine, 0ms, before any LLM call |
| Context for agent | Raw request | Symbol map, import graph, test coverage, git activity |
| Verification | Developer reviews diff | Independent LLM judges each AC against the diff |
| Cost | Per-call API fees | Fully local — DeepSeek-R1:7b via Ollama, no API key |
| Scope drift | Common | Diff scope check flags unexpected file changes |

---

## Repository Structure

```
quaterback/
├── README.md
├── intent/        ← Layer 1: Intent Compiler
├── context/       ← Layer 2: Context Engine
├── agent/         ← Layer 3: Agent Orchestrator
├── verify/        ← Layer 4: Verification Engine
├── landing_page/  ← Marketing site (live on Netlify)
└── devudu_docs/   ← Project thesis
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
# Or chain from Layer 1:
node ../intent/cli.js "Add Gemini Flash provider" --repo /path --save --context
```

---

## Layer 3: Agent Orchestrator (`agent/`)

Builds a structured **Agent Briefing** and invokes the coding agent.

**Stage 1 (DSA — 0ms):** Assembles a 140+ line markdown briefing from the contract + context: goal, AC checklist, symbol map, relevant files with import graph, test files, agent brief, verification plan. No LLM, no I/O.

**Stage 2 (Execution):** Invokes the coding agent (`claude --print` subprocess) and captures the resulting git diff as a structured Changeset.

```bash
cd agent && npm install
# Dry-run: print briefing only
node cli.js --contract ../intent/contracts/<id>.json --context ../context/packages/<id>.json --dry-run

# Full chain L1→2→3 in one command:
node sandbox/run.js --live
```

---

## Layer 4: Verification Engine (`verify/`)

Independent verification — never sees the original request or the briefing. Only the diff and one AC at a time.

**Stage 1 (DSA):**
- Runs the test suite (detects jest/vitest/mocha/pytest/go-test from patterns)
- Diff scope check — flags files modified outside the relevant set
- Keyword signal scan — maps AC terms against the diff

**Stage 2 (LLM — independent):** One Ollama call per acceptance criterion. Verdict per AC: `met: true | false | null` with a one-sentence evidence string.

**Verdicts:** `pass` (all met) | `fail` (any false) | `partial` (any uncertain) | `no-diff`

**Verified against mock partial implementation:**
```
AC-1 ✓ MET     — Gemini Flash integration present in diff
AC-2 ✓ MET     — Anthropic backward compat maintained
AC-3 ✓ MET     — User flow unchanged
AC-4 ✗ NOT MET — config param exists but no switching UI
AC-5 ✗ NOT MET — no fallback logic, config param unused
Verdict: FAIL  → repair hints generated for AC-4, AC-5
```

```bash
cd verify && npm install
node sandbox/run.js --no-llm   # DSA only — instant
node sandbox/run.js            # Full LLM judgment (~90s for 5 ACs on 7B model)
```

---

## Layer 5: Memory (next)

Will store accepted outcomes, failures, and repair patterns as project knowledge — scoped per repo, surfaced only when a future task is relevant.

---

## Full Pipeline Demo

```bash
# From quaterback/ root — chains all three live layers:
node agent/sandbox/run.js --live

# Output:
# [L1] Contract produced in 36.5s
# [L2] Context: 24 files, 7 symbols  in 526ms
# [L3] Briefing built in 0ms (146 lines)
```

---

## Landing Page

Static HTML site assembled by `build.js` from 14 section files in `src/`. Deployed on Netlify — `node build.js` runs on every push.

```bash
cd landing_page
# Edit any src/*.html section, then:
node build.js  # regenerates index.html
```

**Never edit `index.html` directly.**

### Design tokens

| Token | Value |
|---|---|
| Background | `#0D100F` |
| Text | `#F4F1EA` |
| Accent / Orange | `#E08A4C` |
| Green | `#6FBF9F` |
| Muted | `#9AA5A0` |
| Border | `#262E2B` |
| Body font | IBM Plex Sans |
| Mono font | IBM Plex Mono |
| Display font | Instrument Serif |

---

## Build Progress

### Completed

- [x] Landing page — 14-section build system, dark design, mobile responsive
- [x] Layer 1 — Intent Compiler: DSA ambiguity pre-filter + Ollama/DeepSeek-R1:7b → TaskContract
- [x] Layer 2 — Context Engine: symbol extraction (ESM + CJS), import graph, test finder, git activity → ContextPackage
- [x] Layer 3 — Agent Orchestrator: briefing builder (0ms DSA) + claude-code invocation + diff capture → ExecutionResult
- [x] Layer 4 — Verification Engine: test runner + diff scope check + per-AC LLM judgment → VerificationReport

### Next

- [ ] Layer 5 — Memory: outcome storage, failure pattern index, relevance-scored retrieval
- [ ] Repair loop: wire Layer 4 failures back into Layer 3 for automatic re-execution
- [ ] Real agent execution: test full L1→2→3→4 loop on a live feature request

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
