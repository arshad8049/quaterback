# Data-flow inventory (QB-32)

This is the factual basis for the privacy page (`landing_page/privacy.html`), the site copy and the emails. When a flow changes, update this file and those texts together.

**Problem (review, QB-32):**
- Opt-in telemetry carried the registration email and a deterministic 32-bit hash of the task text, yet was described as "anonymous".
- The privacy page said "your source code never leaves your machine", although the Claude Code agent path sends code to Anthropic.
- Local artifacts can hold source and task text.

## The Quarterback software

| Flow | Destination | What is sent | When |
|---|---|---|---|
| QB model calls (L1 intent, L2 context enrichment, L4 judge) | `QB_OLLAMA_URL`, default `http://127.0.0.1:11434` (your machine) | request text, contract, code excerpts, diffs, test evidence | every run, unless `--no-llm-*`. If you set a remote URL, this content goes there |
| Coding agent (`--agent claude-code`) | Anthropic, under **your** Claude account (credentials from `qb auth login`) | the briefing (task, contract, file paths, code context) and whatever code the agent reads in the sandbox | every agent attempt. The sandbox's egress proxy allows only the inference endpoint during the agent stage |
| Dependency install (sandbox stage ②) | npm registry, through the DEPS proxy | package names and versions from your lockfile | when the project has dependencies |
| Telemetry | Quarterback (`/api/metrics`) | the payload below | **only** with `--telemetry` and a token |

Nothing is sent to Quarterback's operators unless telemetry is enabled.

## Local storage (your machine)

| Location | Contents | May contain source or task text? |
|---|---|---|
| `~/.qb/runs/<run_id>/` | run manifest, events, contract, patches (`patch_raw`), briefings, evidence | **yes**. Known secret patterns are redacted (`run/store.js` `redact`); other content is stored verbatim |
| `~/.quarterback/memory/` | goals, changed file paths, repair hints, attempt history | yes (goals and hints are task text) |
| `~/.qb/judge-cache/` | judge prompts' evidence hashes and verdicts | yes (evidence includes code) |
| `~/.qb/sandbox/` | sandbox state, auth volume reference | credentials live in a Docker volume, not in files |

Retention is up to you: delete the directories. `qb runs` lists the run records.

## Telemetry

- **Off by default.** `--telemetry` must be passed on each run, with a verified token (QB-33).
- **The exact payload, nothing else:**

  ```json
  {"run_id":"<random uuid>","passed":false,"attempts":2,"duration_ms":1234,"repair_count":1,"layers_used":"L1,L2,L3,L4,L5","qb_version":"0.1.0"}
  ```

  There is no email in the payload, no task text, no task hash, no file names and no code. The old deterministic `task_hash` (a 32-bit hash of the request text, linkable across runs) has been removed.
- **Consent preview:** `--telemetry-dry-run` prints exactly this payload and sends nothing. With `--telemetry`, the payload is printed as it is sent.
- **Not anonymous:** records are tied to the token, and the token is linked to the email that confirmed it. All copy says so.
- **Identifiers:** the run id is random per run (the run record's UUID), not derived from content.
- **Deletion:** `POST /api/telemetry/delete` with `Authorization: Bearer <token>` deletes every record sent with that token and revokes the token.
- **Retention:** 180 days, enforced by the worker's cron handler.

## The website

| Data | Stored where | Retention |
|---|---|---|
| Signup: email, agent (≤ 80 characters), time, IP, referrer | D1 `submissions` | until deletion is requested or the beta ends |
| Signup abuse control: sha256 of IP | D1 `signup_attempts` | 2 days |
| Email deliveries (recipient, status, error) | D1 `email_deliveries` | 30 days after sent/dead |
| Telemetry confirmation codes (hashed) | D1 `telemetry_verifications` | 7 days |
| Telemetry tokens (hashed) and metrics | D1 `telemetry_tokens`, `client_metrics` | metrics 180 days; token until revoked |

Email addresses go to Resend for delivery. The signup notification goes to the site owner.

## Corrected copy (this change)

| Where | Before | Now |
|---|---|---|
| `privacy.html` | "source code never leaves your machine during the beta" | per-flow statements, the Anthropic path stated, local artifacts, telemetry (not anonymous, payload, deletion), retention |
| Signup box (`beta-cta.html`) | "Local-first. Your source stays on your machine" | "Quarterback runs on your machine; the Claude Code agent sends your task and the code it reads to Anthropic under your account" |
| Signup box | "Anonymized metrics only" | "Metrics are opt-in, tied to your account (not anonymous), deletable by you" |
| Positioning ("Local-first by default") | "you decide explicitly what ever leaves it" | "own model calls stay local by default; the coding agent sends your task and code to its provider; telemetry is off unless you turn it on" |
| Welcome email | "No API keys needed. Everything runs locally via Ollama." and "anonymous run metrics" | local Ollama for QB's own calls, with the Claude Code → Anthropic flow stated; telemetry described as not anonymous, with the dry run and deletion |
