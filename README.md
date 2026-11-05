# Quarterback

### Review AI-written code with evidence, not just a diff.

[![ci](https://github.com/arshad8049/quarterback/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/arshad8049/quarterback/actions/workflows/ci.yml?query=branch%3Amain)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Quarterback runs Claude Code against requirements you approve, checks the resulting changes, and returns a reviewable patch with verification evidence. You decide whether to apply it.

[Get started](docs/onboarding.md) · [Supported environments](docs/support.md) · [Engineering reference](docs/engineering.md)

Pre-release software for supervised beta use.

---

## What a run looks like

A finished run of the demo you'll set up below. Claude Code was asked to add a `clamp(n, min, max)` function, held to a reviewed contract with these executable checks:

| Check | Call | Expected |
|---|---|---|
| exported | `clamp` is a function | — |
| lower bound | `clamp(-5, 0, 10)` | `0` |
| upper bound | `clamp(50, 0, 10)` | `10` |
| in range, at the bounds | `clamp(7, 0, 10)`, `clamp(0, 0, 10)`, `clamp(10, 0, 10)` | `7`, `0`, `10` |

Claude Code made the change in an isolated workspace. Quarterback then ran the checks and the repository's tests on exactly that result:

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

The checkout was not touched. The change came back as a patch to read and apply yourself. The demo starts from a contract a person has already reviewed; that is also how reliable use starts today (see [Beta status](#beta-status-and-limitations)).

---

## How it works

1. **Describe the task** in plain language, pointing at a repository.
2. **A contract pins it down:** the requirements, the limits (which files may change, which must not), and the executable checks that decide the result. You can supply a contract, or ask Quarterback to draft one from your request with a local model; drafting is still in development and not yet reliable.
3. **You approve the contract.** Nothing runs before that, and changing it later voids the approval.
4. **Claude Code runs in an isolated workspace**, briefed with the contract and the relevant code.
5. **Quarterback verifies the result.** The repository's tests and the contract's executable checks run on the exact captured change. A separate model reviews only the criteria that can't be executed, such as documentation or naming. If verification fails, Quarterback sends repair hints back to the agent for another attempt.
6. **You get a verdict and a patch**, with the evidence behind it, and decide whether to apply it.

Every run is recorded, so you can inspect it later. Architecture details: [engineering reference](docs/engineering.md).

---

## Beta status and limitations

- **Pre-release 0.1.0, supervised beta, best-effort support, no SLA.** There is no published release. Install the exact commit you are given; see [Which commit to install](#which-commit-to-install).
- **Scope.** JavaScript / Node.js repositories tested with **node:test** and an npm lockfile. On repositories that use another runner (Jest, Mocha, Vitest, …), agent runs are refused before any model call; only a dry run still plans. Claude Code is the only coding agent that executes; Cursor, Codex and Gemini are not supported. See [support.md](docs/support.md).
- **Contract drafting is not yet reliable.** Reliable use today starts from a contract you write or review (`--contract-file`). When Quarterback drafts one from your request with the local model, the draft is often rejected by Quarterback's own validation, and a draft that passes still needs your careful review. Nothing runs on a rejected draft.
- **Checks cover what the contract states.** A PASS means the configured checks and tests passed, not that every possible bug was ruled out. Writing good checks takes effort, and a criterion without a check stays unresolved rather than passing.
- **Evaluation so far.** Two exploratory comparisons of Claude Code alone against Claude Code with Quarterback show no measured Quarterback advantage. Controlled results and an independent holdout evaluation are pending. Details: [evaluation status](docs/engineering.md#evaluation-status).
- **Onboarding validation.** The fresh-machine walkthrough passed at commit `54c2f24` in a GitHub Codespace on 2026-10-12. That validates that commit and environment only. No later commit has been qualified the same way yet.

---

## Before you start

**What you need**

| | Dry run (step 5) | Claude Code run (steps 6–9) |
|---|---|---|
| OS | Linux or macOS | **Ubuntu 24.04 LTS on x86_64** (validated). macOS + Docker Desktop works for development but is not validated. Windows is not supported. |
| Node.js 20 or newer, git | ✓ | ✓ |
| Docker Engine | — | ✓ |
| Memory | — | **16 GB RAM**: a run starts only with about 11.1 GiB free |
| [Ollama](https://ollama.com) with `deepseek-r1:7b` | — | ✓ (context and the reviewer model) |
| Claude access | — | A Claude subscription, or an Anthropic API key |

Install commands for each prerequisite on Ubuntu: [onboarding §1](docs/onboarding.md#1-install). No 16 GB machine? The documented Codespace configuration (4-core / 16 GB) runs the whole walkthrough; check your own Codespaces allowance first: [docs/review/qb31-codespaces.md](docs/review/qb31-codespaces.md).

**What it costs**

- **Claude usage.** Every Claude Code run, including each repair attempt (up to 3 by default, `--max-retries`), uses your Claude subscription's limits or is billed to your API key. Quarterback adds no charge of its own. The dry run uses no Claude access.
- **Downloads and disk.** `deepseek-r1:7b` is a download of several GB. The first Claude Code run builds Quarterback's sandbox images, which takes several minutes and needs network access.
- **Time.** On a CPU-only machine the local model is slow: a step that uses it can take minutes. The recorded demo run above took 226 seconds end to end.

### Which commit to install

There is no published release yet. Install the **exact commit SHA you were given** with your beta invitation, and quote it in any feedback. Don't install the tip of `main` or a branch: they move, and they may contain unqualified changes.

Validated commits are listed in [support.md](docs/support.md#validated-commits). So far that is only `54c2f24` (2026-10-12), which predates later fixes. If you have no SHA, ask for one in a [GitHub issue](https://github.com/arshad8049/quarterback/issues) rather than guessing.

### Approving a contract

The contract is Quarterback's test oracle: its checks decide PASS or FAIL. **Quarterback runs a coding agent only against a contract a person has approved.** There are two ways to approve one:

- **`--contract-file <file>`:** passing a file **is** your approval. Read it first. Quarterback records the file's hash, and any change to it voids the approval. Quarterback never rewrites a file you supply; if it's invalid, the run stops.
- **Without `--contract-file`:** Quarterback drafts a contract from your request, prints it, and asks `Approve this contract as the test oracle? [y/N]` in the terminal. Without a terminal it saves the draft for review and stops.

The demo below uses the first way, with a contract that ships in the repository.

---

## Getting started

Every command below states where it runs. They use one work folder, `~/qb-beta`, holding the Quarterback checkout (`~/qb-beta/quarterback`) and a small demo repository (`~/qb-beta/qb-demo`). Commands work in bash and zsh.

### 1. Install Quarterback

Run in: any folder.

```bash
mkdir -p ~/qb-beta && cd ~/qb-beta
git clone https://github.com/arshad8049/quarterback.git quarterback
cd quarterback
git checkout <commit-sha-you-were-given>     # see "Which commit to install"
git rev-parse HEAD                           # record this SHA for feedback
npm ci
```

Expected: `npm ci` ends `added … packages` with no `ERR!` lines. If `git checkout` says `pathspec … did not match`, the SHA is mistyped or not on GitHub.

### 2. Make the `qb` command available

Run in: `~/qb-beta/quarterback`.

```bash
export QBDIR="$PWD"
qb() { node "$QBDIR/qb.js" "$@"; }
qb --help
```

Expected: `Usage: qb [options] <request>`. This defines `qb` for the current terminal only, the way the validated walkthrough runs it. In a new terminal, run the first two lines again with `QBDIR` set to your checkout, e.g. `export QBDIR=~/qb-beta/quarterback`. You may see lines like `◇ injected env (0) from intent/.env`; they are harmless.

### 3. Create the demo repository

Run in: `~/qb-beta`.

```bash
cd ~/qb-beta
mkdir qb-demo && cd qb-demo && git init -q
git config user.name "QB Demo" && git config user.email "demo@example.invalid"   # a local identity for the demo commit
mkdir src test
echo "module.exports = {};" > src/utils.js
cat > test/utils.test.js <<'EOF'
const { test } = require('node:test');
test('placeholder', () => {});
EOF
echo '{ "name": "qb-demo", "version": "1.0.0", "scripts": { "test": "node --test" } }' > package.json
npm install --package-lock-only
git add -A && git commit -qm "demo base"
cd ~/qb-beta
```

Expected: `npm install` reports `found 0 vulnerabilities`, and `git -C qb-demo log --oneline` shows one commit, `demo base`. The placeholder test proves nothing about `clamp`; the contract's checks do.

### 4. Read the demo contract

Run in: `~/qb-beta`.

```bash
cat quarterback/docs/demo/clamp-contract.json
```

It asks for a `clamp` export in `src/utils.js` with the checks in the table [above](#what-a-run-looks-like). It allows changes to `src/utils.js` and `test/**` only, and protects `package.json` and `package-lock.json`. Passing this file in the next steps is your approval of it.

### 5. Dry run: see the plan, nothing executes

Run in: `~/qb-beta`. Needs only Node and git: no Docker, no Claude access, no Ollama.

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" \
   --repo qb-demo --agent dry-run --contract-file quarterback/docs/demo/clamp-contract.json
```

Expected, ending:

```text
  RESULT: ○ NO-DIFF
  Attempts: 1 / 3
  Total time: …
  Run:      <run_id>  outcome=DRY_RUN
```

Each criterion is listed with `~` (not verified: there was no change). The exit code is 1, as for every result other than PASS; that is expected here. Nothing in `qb-demo` changed. **Next:** stop here if you only wanted to see the plan, or continue for a real run.

### 6. Sign in to Claude (Claude Code runs only)

Run in: `~/qb-beta`. Use **one** of these:

- **Claude subscription:** `qb auth login`. Open the printed URL, sign in, paste the code the page shows back into the terminal and press Enter. Expected: `signed in; access token expires …`. If it says `sign-in did not complete`, run it again. The login is QB-scoped: your own `~/.claude` login is neither used nor changed.
- **API key or token:** `export ANTHROPIC_API_KEY=…` (or `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) in the terminal you run `qb` from. Quarterback passes it to the sandbox by name and redacts it from run records.

### 7. Check the machine

Run in: `~/qb-beta`.

```bash
qb doctor --repo qb-demo
```

Expected on the validated Linux profile: `Ready (1 warning)`. Every line is `✓` except `agent-auth`, which always shows `!` "validity not verified" because doctor makes no API call. On macOS, `memory` also shows `!` (not measured), so it reads `Ready (2 warnings)`. Any `✗` line prints a `fix:`; apply it and run doctor again before continuing.

### 8. Run the demo with Claude Code

Run in: `~/qb-beta`. This uses your Claude access (see [What it costs](#before-you-start)).

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" \
   --repo qb-demo --agent claude-code --contract-file quarterback/docs/demo/clamp-contract.json
```

Expected: the stages print as they run (`[L1]` … `[L4]`), and a successful run ends like the [recorded output](#what-a-run-looks-like): `RESULT: ✓ PASS` and `outcome=VERIFIED`, exit code 0. Note the run id. If it ends differently, see [If something goes wrong](#if-something-goes-wrong).

Check that your checkout is untouched:

```bash
git -C qb-demo status --porcelain     # prints nothing
```

### 9. Inspect, check and apply the patch

Run in: `~/qb-beta`. Replace `<run_id>` with the id from step 8 (`qb runs` lists recent ones).

```bash
qb show <run_id>                          # contract, attempts, verdicts and evidence
qb patch <run_id> --out clamp.patch       # export the change; the header states its verification status
less clamp.patch                          # read it before applying
git -C qb-demo apply --check ../clamp.patch && git -C qb-demo apply ../clamp.patch
node -e "const { clamp } = require('./qb-demo/src/utils'); console.log(clamp(-5, 0, 10), clamp(50, 0, 10), clamp(7, 0, 10))"
```

Expected: `git apply --check` prints nothing, and the last line prints `0 10 7`. `qb patch` refuses to write over an existing file, so pick a new `--out` name if you export again. Applying the patch is the only step that changes `qb-demo`.

### 10. Clean up

Run in: `~/qb-beta`. Remove what the demo created when you're done:

```bash
rm -rf qb-demo clamp.patch
qb auth logout                     # if you used `qb auth login`
rm -rf ~/.qb ~/.quarterback        # run records, memory, caches and sandbox state (they can contain code and task text)
docker image ls 'qb-sandbox-*'     # the sandbox images; remove them with `docker image rm <image>` if you want the disk back
```

To remove Quarterback itself, delete `~/qb-beta`.

---

## On your own repository

Run in: the folder holding your repository, with `qb` defined as in step 2.

**Recommended: start from a contract you review.** Write one by hand using [`docs/demo/clamp-contract.json`](docs/demo/clamp-contract.json) as the model (the fields are described in [docs/verify/](docs/verify/)), or let Quarterback draft one and save it without running anything:

```bash
qb "<your request>" --repo my-repo --agent claude-code < /dev/null
```

Without a terminal on its input, Quarterback stops after drafting and prints `Review (and edit if needed): <file>`. Review that file, then run with `--contract-file <file>`. In a terminal, the same command shows the draft and asks you to approve it.

Useful options:
- `--clarify "<answer>"` answers a clarifying question without the prompt (repeat for later rounds);
- `--max-retries <1-10>` sets the number of repair attempts;
- `--deadline <minutes>` ends a run that takes too long, as `CANCELLED`;
- `--agent manual` prints the briefing for your own agent.

All options: `qb --help`.

---

## If something goes wrong

| You see | What it means | Do |
|---|---|---|
| `qb: invalid options: …` (exit 2) | Nothing ran and no model was called. | Fix the listed options. `unsupported test runner: <name>` means the repository doesn't use node:test. |
| `qb doctor` shows `✗` | The machine isn't ready. | Apply the `fix:` line it prints, then run doctor again. |
| `FATAL: model call timed out after 180000ms` | The local model didn't answer in time. That's an environment limit, not a problem with your request. It is common on a CPU-only machine, especially on the first call while the model loads. | Check `ollama list` shows `deepseek-r1:7b`. Give it longer: `export QB_MODEL_CALL_TIMEOUT_MS=600000`, then run again. Or skip drafting with a reviewed `--contract-file`. |
| `✗ QB couldn't build a reliable checklist. No code was changed.` | Quarterback's own draft failed its validation, and its one automatic correction didn't fix it. That's Quarterback's mistake, not your request's. Nothing ran. | Run again (the local model may do better), or start from a contract you write or review. Mention it in feedback: it helps us measure drafting. |
| `⚠ Ambiguity detected` and a question | The draft needs a detail only you can give. | Answer in the terminal, or pass `--clarify "<answer>"` (repeat for later rounds). |
| `✗ Contract file rejected: …` | The file you passed is not a valid contract. Quarterback never rewrites it. | Fix the file and run again. |
| Verdict `fail` | A check or test failed after every repair attempt. | `qb show <run_id>` lists the failing criteria with their evidence. |
| Verdict `unresolved` / `partial` | Something couldn't be verified, such as a criterion with no executable check. | `qb show <run_id>` names what is missing. |
| `error`, or outcome `ERROR` / `BLOCKED` | An environment problem: Docker down, sign-in expired, or the project's dependencies were refused. | Run `qb doctor`; for sign-in, `qb auth status`, then `qb auth login`. Then run again. |

More recovery steps: [onboarding §4](docs/onboarding.md#4-when-something-fails).

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

Open an issue on [GitHub](https://github.com/arshad8049/quarterback/issues) and copy this template into it:

```markdown
**Quarterback commit:** <output of `git -C ~/qb-beta/quarterback rev-parse HEAD`>
**OS / machine:** <e.g. Ubuntu 24.04 x86_64, 16 GB; or macOS 15, Docker Desktop>
**Node version:** <output of `node --version`>
**Agent and path:** <dry run / Claude Code run; contract file or drafted>

**Steps** (sanitized: no private code, names or paths):
1.
2.

**Expected:**

**What happened:** <verdict and outcome line, e.g. `RESULT: ✗ FAIL` / `outcome=FAILED`>

**Output excerpt** (redacted):
```

Before you post, check the excerpt: replace your home folder with `~`, repository and file names with placeholders, and remove any code. Don't include credentials, API keys, tokens, proprietary prompts or source code. A run id is local to your machine: it doesn't give the maintainers access to your run, so describe what you saw.

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
