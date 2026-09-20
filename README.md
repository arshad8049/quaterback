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
│  1. INTENT      │  Compile the request into a machine-executable Task Contract
│                 │  with explicit goals, behaviors, constraints, and acceptance criteria
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  2. CONTEXT     │  Ground the contract in the actual repo — surfaces relevant
│                 │  files, symbols, patterns, and architectural decisions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  3. AGENT       │  Execute against the contract — not against a vague prompt.
│                 │  The agent knows exactly what done looks like.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  4. VERIFICATION│  Independent agent checks the diff against the contract's
│                 │  acceptance criteria — without asking the builder what they meant
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  5. MEMORY      │  Stores outcomes per contract — what was accepted, what was
│                 │  caught, what patterns recur — feeds back into future layers
└─────────────────┘
         │
         ▼
  Verified Result
```

---

## Repository Structure

```
quaterback/
├── README.md                   ← you are here
├── CONTEXT.md                  ← local progress log (gitignored)
├── .gitignore
├── devudu_docs/                ← project thesis PDF
│
├── landing_page/               ← marketing site (live on Netlify)
│   ├── build.js                ← assembles src/ sections → index.html
│   ├── index.html              ← compiled output (do not edit directly)
│   ├── netlify.toml
│   └── src/
│       ├── nav.html
│       ├── hero.html
│       ├── social-proof.html
│       ├── today-vs-future.html
│       ├── the-gap.html
│       ├── north-star-metric.html
│       ├── the-loop.html
│       ├── task-contract.html
│       ├── verification.html
│       ├── repair.html
│       ├── report.html
│       ├── positioning.html
│       ├── beta-cta.html
│       ├── footer.html
│       ├── styles/
│       │   ├── main.css
│       │   └── fonts.css
│       └── scripts/
│           └── interactions.js
│
└── intent/                     ← Layer 1: Intent Compiler (Node.js CLI)
    ├── package.json
    ├── schema.js               ← Zod: TaskContract + ClarifyingResponse schemas
    ├── compiler.js             ← Claude API call + JSON validation
    ├── context.js              ← repo tree walker + relevance scoring
    ├── cli.js                  ← CLI entry point
    ├── .env.example
    ├── prompts/
    │   └── system.md           ← compiler system prompt (core IP)
    ├── contracts/              ← saved Task Contracts (gitignored)
    └── sandbox/
        ├── run.js              ← fixture runner for prompt tuning
        └── fixtures/
            └── requests.json   ← 5 test requests
```

---

## Layer 1: Intent Compiler

### What it is

The Intent Compiler is **not** a fine-tuned model. It is a structured system prompt sent to `claude-sonnet-4-6` that transforms a developer's natural-language request into a validated **Task Contract** — a machine-executable specification with no ambiguity.

Like a language compiler turning human-readable code into bytecode, the Intent Compiler turns an informal request like *"Add Google login and make it work like normal signup"* into a contract that specifies every required behavior, every constraint, and every acceptance criterion — so the coding agent has no room to guess, and the verifier has no room to ask the builder what they meant.

### The Task Contract

```json
{
  "id": "uuid-v4",
  "created_at": "ISO timestamp",
  "raw_request": "original developer request",
  "repo_path": "/absolute/path/to/repo",
  "goal": "one-sentence objective — what changes in the world",
  "required_behavior": [
    "Observable behavioral statement a verifier can check"
  ],
  "constraints": [
    "What the implementation must NOT do — explicit and inferred"
  ],
  "acceptance_criteria": [
    { "id": "AC-1", "criterion": "Independently verifiable behavior", "met": null }
  ],
  "verification_plan": [
    "Specific mechanical steps for the verification agent"
  ],
  "relevant_context": ["file/paths/or/symbols"],
  "ambiguity_flags": ["Any genuine ambiguity noted"],
  "clarifying_question": null
}
```

If `clarifying_question` is non-null, the CLI prompts the user and re-compiles before saving.

### Setup

```bash
cd intent
npm install

# Add your Anthropic API key
cp .env.example .env
# Edit .env: ANTHROPIC_API_KEY=sk-ant-...
```

### Usage

```bash
# Compile a request (stdout only)
node cli.js "Add Google login and make it work like normal signup"

# Compile with repo context
node cli.js "Speed up the dashboard query" --repo ../my-project

# Compile and save the contract to contracts/{id}.json
node cli.js "Add email verification to the signup flow" --repo ../my-project --save
```

### Sandbox (prompt tuning loop)

```bash
# Run all 5 fixture requests
node sandbox/run.js --all

# Run a single fixture
node sandbox/run.js --fixture 2
```

The 5 fixtures are designed to stress different compiler capabilities:

| # | Label | Tests |
|---|---|---|
| 1 | `clear-scope` | Baseline — should produce a clean full contract |
| 2 | `ambiguous-behavior` | Should trigger `clarifying_question` |
| 3 | `scope-drift-risk` | Should ask what "cleaner" means |
| 4 | `implicit-constraint` | Should capture implicit "don't regress other queries" |
| 5 | `multi-step` | Should decompose into multiple `required_behavior` items |

---

## Landing Page

The marketing site is a static HTML site assembled by `build.js` from individual section files in `src/`. Each section is independently editable.

### Editing

```bash
cd landing_page

# Edit any section file, then rebuild:
node build.js

# Output: index.html (deploy this)
```

**Never edit `index.html` directly** — it is overwritten on every build.

### Deployment

Deployed via Netlify. Config in `netlify.toml`:

```toml
[build]
  publish = "."
  command = "node build.js"
```

Netlify runs `node build.js` on every push, producing `index.html` from source. No environment variables required — form submissions are handled natively by Netlify Forms.

### Design System

| Token | Value |
|---|---|
| Background | `#0D100F` |
| Text | `#F4F1EA` |
| Accent / Orange | `#E08A4C` |
| Muted Text | `#9AA5A0` |
| Border | `#262E2B` |
| Body Font | IBM Plex Sans |
| Mono Font | IBM Plex Mono |
| Display Font | Instrument Serif |

Scroll animations use `IntersectionObserver` (no external animation libraries). SVG animations use native `<animateTransform>` — not CSS transforms — to avoid coordinate-system quirks.

---

## Build Progress

### Completed

- [x] Unpack and componentize original single-file HTML into 14 section files
- [x] Build system (`build.js`) assembling sections into `index.html`
- [x] Full design system — dark palette, typography, spacing
- [x] Hero section — orbit SVG with radar scan beam (`<animateTransform>`)
- [x] Scroll reveal animations via `IntersectionObserver`
- [x] Sticky nav with `backdrop-filter` blur on scroll
- [x] Social proof section — Stack Overflow 2025 survey stats (66% / 4.4% / 46%)
- [x] The Gap section — 8 failure examples + survey citation callout
- [x] Beta CTA form wired to Netlify Forms (honeypot, required fields)
- [x] Netlify deployment via `netlify.toml`
- [x] `.gitignore` covering secrets, build artifacts, contracts
- [x] Intent Layer — `schema.js` (Zod contracts)
- [x] Intent Layer — `prompts/system.md` (compiler system prompt)
- [x] Intent Layer — `compiler.js` (Claude API + prompt caching + JSON validation)
- [x] Intent Layer — `context.js` (repo tree walker + relevance scoring)
- [x] Intent Layer — `cli.js` (commander CLI with clarifying question loop)
- [x] Intent Layer — `sandbox/run.js` + 5 fixtures

### In Progress / Next

- [ ] Set `ANTHROPIC_API_KEY` in `intent/.env` and validate all 5 sandbox fixtures
- [ ] Test compiler against a real repo (`node cli.js "..." --repo /path/to/repo`)
- [ ] Dog-food: compile every new Quarterback feature through the intent layer before building
- [ ] Layer 2: Context aggregation (deeper repo understanding, symbol graphs)
- [ ] Layer 3: Agent executor (contract-aware coding agent)
- [ ] Layer 4: Verification agent (independent contract checker)
- [ ] Layer 5: Memory layer (outcome storage and feedback loop)

---

## Company

Built by **Velora LLC** — [velorallc.netlify.app](https://velorallc.netlify.app)
