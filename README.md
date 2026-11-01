# Quarterback

### Review AI-written code with evidence, not just a diff.

[![ci](https://github.com/arshad8049/quaterback/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/arshad8049/quaterback/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Quarterback runs Claude Code against requirements you approve, checks the resulting changes, and returns a reviewable patch with verification evidence. You decide whether to apply it.

[Get started](docs/onboarding.md) · [Supported environments](docs/support.md) · [Engineering reference](docs/engineering.md)

Pre-release software for supervised beta use.

---

## What a run looks like

You ask for a change in plain language:

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" \
   --repo qb-demo --agent claude-code --contract-file quaterback/docs/demo/clamp-contract.json
```

The run is held to an approved contract. These are its executable checks:

| Check | Call | Expected |
|---|---|---|
| exported | `clamp` is a function | — |
| lower bound | `clamp(-5, 0, 10)` | `0` |
| upper bound | `clamp(50, 0, 10)` | `10` |
| in range, at the bounds | `clamp(7, 0, 10)`, `clamp(0, 0, 10)`, `clamp(10, 0, 10)` | `7`, `0`, `10` |

Claude Code makes the change in an isolated workspace. Quarterback then runs the checks and the repository's tests on exactly that result:

```text
  [L4]   Verdict: ✓ PASS  (60ms)
     ✓ [AC-1] src/utils.js exports clamp as a function
     ✓ [AC-2] below the lower bound: clamp(-5, 0, 10) returns 0
     ✓ [AC-3] above the upper bound: clamp(50, 0, 10) returns 10
     ✓ [AC-4] in range: clamp(7, 0, 10) returns 7, and the bounds them

  RESULT: ✓ PASS
  Run:      03e4e16e-c8a3-464b-8855-dfeec81fe579  outcome=VERIFIED
```

<sub>Recorded output, excerpted (criterion text is truncated as printed). Onboarding walkthrough, attempt 4, GitHub Codespace (Ubuntu 24.04, 4-core / 16 GB), Quarterback commit `54c2f24`, 2026-10-12. [Full log](docs/review/qb31-walkthrough/attempt-4-2026-10-12-codespaces/logs/07-demo-run.log).</sub>

Your checkout is untouched. You export the patch with `qb patch <run_id>`, read it, and apply it yourself.

This demo supplies a pre-reviewed contract, so you can inspect the execution and verification workflow without first generating requirements. The full walkthrough is in [docs/onboarding.md](docs/onboarding.md).

---

## How it works

1. **Describe the task** in plain language, pointing at a repository.
2. **Quarterback turns your request into proposed requirements** and may ask clarifying questions. It grounds them in your repository's code.
3. **You review and approve the contract**, an approved checklist of requirements, constraints and checks. Changing it later voids the approval.
4. **Claude Code runs in an isolated workspace**, briefed with the contract and the relevant code.
5. **Quarterback verifies the result.** The repository's tests and the contract's executable checks run on the exact captured change. An independent model judge reviews only the criteria that can't be executed, such as documentation or naming. If verification fails, Quarterback sends repair hints back to the agent for another attempt.
6. **You get a verdict and a patch**, with the evidence behind it, and decide whether to apply it.

Every run is recorded, so you can inspect it later. Architecture details: [engineering reference](docs/engineering.md).

---

## Beta status and limitations

- **Pre-release 0.1.0, supervised beta, best-effort support, no SLA.** There is no published release tag. Install from the exact commit SHA you were given; branch names move.
- **Scope.** JavaScript / Node.js repositories tested with **node:test** and an npm lockfile. On repositories that use another runner (Jest, Mocha, Vitest, …), agent runs are refused before any model call; only a dry run still plans. Claude Code is the only coding agent that executes; Cursor, Codex and Gemini are not supported yet. See [support.md](docs/support.md).
- **Checks cover what the contract states.** A PASS means the configured checks and tests passed, not that every possible bug was ruled out. Writing good checks takes effort, and a criterion without a check stays unresolved rather than passing.
- **Evaluation so far.** Two exploratory comparisons of Claude Code alone against Claude Code with Quarterback show no measured Quarterback advantage. Controlled results and an independent holdout evaluation are pending. Details: [evaluation status](docs/engineering.md#evaluation-status).
- **Onboarding validation.** The fresh-machine walkthrough passed at commit `54c2f24` in a GitHub Codespace. That validates that revision and environment, not every later commit.

---

## Requirements

- **OS:** Ubuntu 24.04 LTS on x86_64 with Docker Engine (validated). macOS with Docker Desktop works for development but is not validated. Windows is not supported.
- **Memory:** at least 16 GB RAM for Claude Code runs (a run needs about 11.1 GiB free when it starts).
- **Software:** Node.js 20 or newer (24 recommended), git, Docker, and [Ollama](https://ollama.com) with `deepseek-r1:7b` pulled.
- **Claude access** for Claude Code runs: a Claude subscription, or an Anthropic API key.

Full install steps for each prerequisite: [docs/onboarding.md §1](docs/onboarding.md#1-install).

**No 16 GB machine?** The documented Codespace configuration (`.devcontainer/qb31-walkthrough`, 4-core / 16 GB machine type) runs the whole walkthrough. Check your own Codespaces allowance before you start: [docs/review/qb31-codespaces.md](docs/review/qb31-codespaces.md).

---

## Getting started

### 1. Install

```bash
git clone https://github.com/arshad8049/quaterback.git
cd quaterback
git checkout <commit-sha-you-were-given>
git rev-parse HEAD        # record this SHA for feedback
npm ci
npm link                  # optional: puts `qb` on your PATH (otherwise use `node quaterback/qb.js`)
cd ..
```

The commands below run from this parent directory, next to the `quaterback` checkout. Create the small demo repository there, using the commands in [onboarding §3](docs/onboarding.md#3-demo-task).

### 2. Choose a path

**Dry run: see the contract and briefing, nothing executes.** No coding agent runs, so Docker and Claude access aren't needed:

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" \
   --repo qb-demo --agent dry-run --contract-file quaterback/docs/demo/clamp-contract.json
```

It ends `outcome=DRY_RUN` (verdict `no-diff`) and changes nothing. Without `--contract-file`, a dry run asks the local model to propose the contract, so Ollama must be running.

**Claude Code run: real agent execution and verification.** Continue with steps 3–5.

### 3. Authenticate (Claude Code runs only)

Use **one** of these:

- **Claude subscription:** run `qb auth login`. Open the printed URL, sign in, paste the code back into the terminal and press Enter. It ends with `signed in; access token expires …`. The login is QB-scoped: your own `~/.claude` login is neither used nor changed.
- **API key or token:** start `qb` with `ANTHROPIC_API_KEY` set in the environment, or with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. QB passes it to the sandbox by name and redacts it from run records.

### 4. Check the machine

```bash
qb doctor --repo qb-demo
```

It should end `Ready (1 warning)`: every line `✓` except `agent-auth`, which always shows `!` "validity not verified" because doctor makes no API call. Fix any `✗` with the `fix:` line it prints.

### 5. Run the demo

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" \
   --repo qb-demo --agent claude-code --contract-file quaterback/docs/demo/clamp-contract.json
```

Read [`docs/demo/clamp-contract.json`](docs/demo/clamp-contract.json) before you run it: passing a contract file is your approval. A successful run ends like the recorded output above, with `RESULT: ✓ PASS` and `outcome=VERIFIED`. If it doesn't, see [troubleshooting](docs/onboarding.md#4-when-something-fails).

### On your own repository

```bash
qb "<your request>" --repo /path/to/repo --agent claude-code
```

Without `--contract-file`, QB proposes a contract and asks you to approve it in the terminal. Useful options:
- `--clarify "<answer>"` answers a clarifying question without the prompt (repeatable);
- `--max-retries <1-10>` sets the number of repair attempts;
- `--deadline <minutes>` cancels a run that takes too long;
- `--agent manual` prints the briefing for your own agent.

All options: `qb --help`.

---

## Inspecting results

```bash
qb runs                                # recent runs
qb show <run_id>                       # manifest, contract, attempts, verdicts
qb patch <run_id> --out change.patch   # export the captured change
qb replay <run_id>                     # recompute the verdicts from saved evidence
```

**Verification results** (per attempt) say what the evidence establishes:

| Verdict | Meaning |
|---|---|
| `pass` | Every criterion met and the tests passed |
| `fail` | A criterion not met, a new failing test, or a change to a protected path |
| `partial` | Some criteria could not be decided |
| `unresolved` | The evidence couldn't establish the result, for example a criterion with no executable check, or tests that didn't run |

Two other states mean nothing was verified: `error` (the execution itself failed, for example a timeout or an infrastructure problem) and `no-diff` (there was no change to verify).

**Run outcomes** say how the whole run ended: `VERIFIED` (pass), `FAILED`, `UNRESOLVED`, `ERROR`, `BLOCKED` (for example, the contract was not approved, or setup was refused), `CANCELLED` (deadline or interruption), `DRY_RUN` or `ABANDONED`. `qb` exits 0 only when the verdict is `pass`.

- **`qb patch`** exports the patch with its verification status in the header, which may be fail or partial. It refuses to export a patch it can't trust and never writes into your checkout. Applying the patch is what changes your code.
- **`qb replay`** recomputes each verdict from the saved evidence and checks it matches the record. It does not rerun the agent or the tests.

Run records are stored in `~/.qb/runs` (or `QB_RUNS_DIR`).

---

## Safety, privacy and feedback

### Safety controls and limitations

- **Isolated execution.** The agent works in a disposable workspace seeded from a read-only copy of your checkout. Your files and `.git` are not written during a run; applying the exported patch changes your checkout.
- **Restricted network during agent execution.** While the agent runs, its only network access is the Claude inference endpoint, through a policy proxy. Dependency installs inside the sandbox go to the npm registry through a separate proxy. Your own installation steps use your normal network.
- **Protected paths.** Your approved contract can list paths (globs) the task must not change. A change to any of them fails the task.
- **Refused dependencies.** `link:`, `file:` and git dependencies and root lifecycle scripts are refused by the sandbox.
- **Limits.** The sandbox is a safety control, not a production-security guarantee. Design and threat model: [docs/security/agent-sandbox.md](docs/security/agent-sandbox.md).

### Where your data goes

- **On your machine.** Quarterback's own model calls (intent, context, judge) go to Ollama at `QB_OLLAMA_URL`, which is local by default. Run records, memory and judge caches are stored under `~/.qb` and `~/.quarterback`. They can contain source code and task text (known secret patterns are redacted from run records); delete them whenever you like.
- **To Anthropic, during Claude Code runs.** The agent's briefing (task, contract, file paths, code context) and whatever code the agent reads in the sandbox are sent to Anthropic under your Claude account.
- **To Quarterback, only if you opt in.** Telemetry is off by default. It needs `--telemetry` and a token on each run, sends a small outcome payload (no code, task text or file names), and is linked to your token, so it is not anonymous. `--telemetry-dry-run` prints the exact payload and sends nothing.

Claude Code execution uses an external model service. Review the [data-flow documentation](docs/privacy/data-flows.md) before using confidential repositories. Disabling telemetry does not disable the model requests needed to perform the task.

### Feedback

Open an issue on [GitHub](https://github.com/arshad8049/quaterback/issues) with:
- the commit SHA you installed and your OS;
- sanitized steps to reproduce;
- what you expected and what happened;
- redacted excerpts of `qb doctor` or run output.

Don't include source code, credentials, proprietary prompts or private paths. A run id is local to your machine: it doesn't give the maintainers access to your run, so describe what you saw.

---

## Documentation

| | |
|---|---|
| [Onboarding](docs/onboarding.md) | Full install, `qb doctor`, demo, recovery, inspecting runs |
| [Support matrix](docs/support.md) | Supported agents, platforms, test runners and options |
| [Engineering reference](docs/engineering.md) | Pipeline, verification rules, tests and evaluation status |
| [Agent sandbox](docs/security/agent-sandbox.md) | Isolation design and threat model |
| [Data flows](docs/privacy/data-flows.md) | What is sent where, and what is stored locally |
| [Verification design](docs/verify/) | Test oracle, scope policy, executable checks, evidence, calibration |
| [README history](docs/history/readme-2026-10.md) | The previous README, kept as a dated snapshot |

---

## License

[MIT](LICENSE) © 2026 Arshad Ahmed Shaik. Built by **Velora LLC**. Quarterback is not published to npm; install it from this repository.
