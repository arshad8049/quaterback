# Quarterback

### Review AI-written code with evidence, not just a diff.

[![ci](https://github.com/arshad8049/quarterback/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/arshad8049/quarterback/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Quarterback runs Claude Code against requirements you approve, checks the resulting changes, and returns a reviewable patch with verification evidence. You decide whether to apply it.

**Status: pre-release, in supervised evaluation.** Quarterback is not yet ready for self-service installation: no current commit has been qualified for unsupervised use. If you use Claude Code on JavaScript projects and want to try it on real work, [request a supervised evaluation](https://quaterback.velorallc.workers.dev/#beta).

[Request a supervised evaluation](https://quaterback.velorallc.workers.dev/#beta) · [Setup guide](docs/onboarding.md) · [Supported environments](docs/support.md)

---

## What it does

1. **You describe the task** in plain language, pointing at a repository.
2. **A contract pins it down:** the requirements, the limits (which files may change, which must not), and the executable checks that decide the result. You can supply a contract, or ask Quarterback to draft one with a local model; drafting is still in development and not yet reliable.
3. **You approve the contract.** The coding agent does not execute before approval, and changing the contract later voids it.
4. **Claude Code runs in an isolated workspace**, briefed with the contract and the relevant code.
5. **Quarterback verifies the result.** The repository's tests and the contract's executable checks run on the exact captured change. A separate model reviews only the criteria that can't be executed, such as documentation or naming. If verification fails, the agent gets repair hints for another attempt.
6. **You get a verdict and a patch**, with the evidence behind it, and decide whether to apply it. Your checkout is not changed until you apply the patch.

Every run is recorded, so you can inspect or replay its verdict later. Architecture: [engineering reference](docs/engineering.md).

---

## A real run

Claude Code was asked to add a `clamp(n, min, max)` function to a small demo repository, held to a reviewed contract with these executable checks:

| Check | Call | Expected |
|---|---|---|
| exported | `clamp` is a function | — |
| lower bound | `clamp(-5, 0, 10)` | `0` |
| upper bound | `clamp(50, 0, 10)` | `10` |
| in range, at the bounds | `clamp(7, 0, 10)`, `clamp(0, 0, 10)`, `clamp(10, 0, 10)` | `7`, `0`, `10` |

Quarterback ran the checks and the repository's tests on exactly the change Claude Code made:

```text
  [L4]   Verdict: ✓ PASS  (60ms)
     ✓ [AC-1] src/utils.js exports clamp as a function
     ✓ [AC-2] below the lower bound: clamp(-5, 0, 10) returns 0
     ✓ [AC-3] above the upper bound: clamp(50, 0, 10) returns 10
     ✓ [AC-4] in range: clamp(7, 0, 10) returns 7, and the bounds them

  RESULT: ✓ PASS
  Run:      03e4e16e-c8a3-464b-8855-dfeec81fe579  outcome=VERIFIED
```

<sub>Recorded output, excerpted (criterion text is truncated as printed). Onboarding walkthrough, attempt 4, GitHub Codespace (Ubuntu 24.04, 4-core / 16 GB), Quarterback commit `54c2f24`, 2026-10-12. It is a record of that commit, not a test of later ones. [Full log](docs/review/qb31-walkthrough/attempt-4-2026-10-12-codespaces/logs/07-demo-run.log).</sub>

The checkout was not touched; the change came back as a patch to read and apply. This demo starts from a contract a person had already reviewed, which is the recommended evaluation path today. The [setup guide](docs/onboarding.md) walks through the same run.

---

## Supported today

| | |
|---|---|
| Coding agent | **Claude Code** only, run in Quarterback's Docker sandbox. Cursor, Codex and Gemini are not supported. |
| Repositories | JavaScript / Node.js, tested with **node:test**, with an npm lockfile. Agent runs on repositories using another test runner (Jest, Mocha, Vitest, …) are refused before any model call. |
| Platform | **Ubuntu 24.04 LTS on x86_64 with Docker Engine and 16 GB RAM** is the validated profile. macOS with Docker Desktop works for development but is not validated. Windows is not supported. |
| Also needed | Node 20+, git, [Ollama](https://ollama.com) with `deepseek-r1:7b`, and a Claude subscription or Anthropic API key. |

The full matrix is in [support.md](docs/support.md).

---

## Start here

1. **[Request a supervised evaluation](https://quaterback.velorallc.workers.dev/#beta).** You'll get the exact commit to install, and help while you set it up.
2. **Follow the [setup guide](docs/onboarding.md)** from top to bottom. It covers requirements and cost, a dry run that needs no Docker or Claude access, a real Claude Code run, applying the patch, and removing the demo.
3. **Send feedback** through your evaluation contact or a [GitHub issue](https://github.com/arshad8049/quarterback/issues). The guide has a [template](docs/onboarding.md#sending-feedback) that keeps private code and credentials out.

---

## Limitations

- **Pre-release 0.1.0, best-effort support, no SLA.** There is no published release. The fresh-machine walkthrough passed at commit `54c2f24` in a GitHub Codespace on 2026-10-12. That validates that commit and environment only; qualification of a current commit is pending.
- **Contract drafting is not yet reliable.** When Quarterback drafts a contract from your request with the local model, the draft is often rejected by its own validation, and a draft that passes still needs careful review. Nothing runs on a rejected draft. Starting from a contract you write or review avoids that problem, but it does not make the rest of the product proven.
- **Checks cover what the contract states.** A PASS means the configured checks and tests passed, not that every possible bug was ruled out. Writing good checks takes effort, and a criterion without a check stays unresolved rather than passing.
- **No measured benefit yet.** Two exploratory comparisons of Claude Code alone against Claude Code with Quarterback show no measured Quarterback advantage. Controlled results and an independent holdout evaluation are pending. Details: [evaluation status](docs/engineering.md#evaluation-status).
- **Your code goes to Anthropic during Claude Code runs.** The agent's briefing and the code it reads in the sandbox are sent to Anthropic under your Claude account. Quarterback's own model calls go to a local Ollama by default, and its run records under `~/.qb` and `~/.quarterback` can contain source code and task text. Telemetry is off unless you opt in, and it is not anonymous. Read [data flows](docs/privacy/data-flows.md) before using a confidential repository.
- **The sandbox is a safety control, not a production-security guarantee.** While the agent runs, its only network access is the Claude endpoint through a policy proxy, and changes to protected paths fail the task. Design and threat model: [agent sandbox](docs/security/agent-sandbox.md).

---

## Documentation

| | |
|---|---|
| [Setup guide](docs/onboarding.md) | Install, `qb doctor`, the demo, troubleshooting, your own repository, feedback |
| [Support matrix](docs/support.md) | Supported agents, platforms, test runners, options and validated commits |
| [Engineering reference](docs/engineering.md) | Pipeline, verification rules, tests and evaluation status |
| [Agent sandbox](docs/security/agent-sandbox.md) | Isolation design and threat model |
| [Data flows](docs/privacy/data-flows.md) | What is sent where, and what is stored locally |
| [Verification design](docs/verify/) | Test oracle, scope policy, executable checks, evidence, calibration |
| [README history](docs/history/readme-2026-10.md) | The previous README, kept as a dated snapshot |

---

## License

[MIT](LICENSE) © 2026 Arshad Ahmed Shaik. Built by **Velora LLC**. Quarterback is not published to npm.
