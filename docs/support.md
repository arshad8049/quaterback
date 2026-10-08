# Support matrix (QB-31)

What QB supports today, narrowly. Anything not listed here is unsupported. `qb doctor` checks a machine against this page, and `qb` refuses an unsupported agent or an invalid option before any model call (exit code 2).

## Agents (`--agent`)

Agents are adapters in a versioned registry, `agent/adapters.js`, interface **`qb-agent-adapter/1`**.

| Agent | Support | What it does | Needs |
|---|---|---|---|
| `claude-code` | **supported** | Runs the Claude Code CLI in the QB sandbox. Tests and checks run there too, and the result comes back as a patch (`qb patch`). The only adapter that can end in `pass`. | Docker, `qb auth login` or `ANTHROPIC_API_KEY` |
| `manual` | builtin | Prints the briefing; you run your own agent. There is no sandbox evidence, so a manual run ends `unresolved`, never `pass`. | — |
| `dry-run` | builtin (default) | Compiles the contract and briefing only. Nothing is changed or verified. | — |
| Cursor, Codex, Gemini | **not supported yet** (planned) | `qb` exits 2 with "not supported yet". | — |

**Interface `qb-agent-adapter/1`:**
- **In:** an approved contract (QB-08, QB-13), the context package, the repository path and the run options.
- **Out:** an `ExecutionResult` (`agent/schema.js`) built by trusted code from the captured tree, never from the agent's own account of what it did.
- **Rule:** an agent that edits code runs only in the QB sandbox, never on the host (QB-02).

A change to this contract is a new interface version.

## Platform

| | Status |
|---|---|
| Node | **20 or newer** (`engines`). CI runs Node 20, 22 and 24. The agent image uses Node 24. |
| OS | **Linux x86_64 + Docker Engine: validated.** macOS + Docker Desktop works for development but is not validated. Windows is not supported. |
| git | Required. With `--agent claude-code` the target repository must be a git work tree (the sandbox captures changes as git trees). |
| Local model | An Ollama server (`QB_OLLAMA_URL`, default `http://127.0.0.1:11434`) with `QB_MODEL` (default `deepseek-r1:7b`). Used by the intent, context and judge stages. |

## Target repositories and tests

| | Status |
|---|---|
| Language | JavaScript / Node.js repositories. |
| Test runner | **node:test is the only validated runner** (QB-20). It is detected from `package.json`, or set in `.quarterback.json` as `{ "test": { "runner": "node-test", "command": [...] } }`. |
| Other runners (Jest, Mocha, Vitest, …) | Detected and named, never executed. Tests are `not_run`, so the task can't `pass`; `qb doctor --repo` warns. |
| Dependencies | `package-lock.json` (lockfile v2/v3) from the npm registry. `link:`, `file:` and `git` dependencies and root lifecycle scripts are refused by the sandbox. |
| Executable checks | Registry `qb-checks/2` (`module_exports`, `call_returns`, `call_throws`, `call_sequence`). |

## Options validated before a run

`--agent` (registered adapter) · `--max-retries` (whole number 1–10) · `--deadline` (positive minutes) · `--repo` (an existing directory; a git work tree for `claude-code`) · `--contract-file` (exists) · `--telemetry` (needs a token unless `--telemetry-dry-run`) · a non-empty request. Every problem is reported at once.

## Release, licence and support

- **Release:** `0.1.0`, pre-release. Install from the repository (`docs/onboarding.md`); QB is not published to npm.
- **Support:** supervised beta (Phase 5), best effort, no SLA. The supported surface is this page.
- **Licence: no open-source licence has been granted.** The repository has no LICENSE file, and every `package.json` declares `"license": "UNLICENSED"` and `"private": true` (it can't be published to npm by accident). The code being publicly visible is **not** permission to copy, modify, redistribute or reuse it.
  - A public beta distribution needs an explicit, owner-approved licence or terms decision. That is a **release gate**, and nothing here grants one.
  - This is QB's own distribution policy. It is separate from the coding agent's terms (a Claude subscription or API key) and from the licences of the repositories QB benchmarks.
