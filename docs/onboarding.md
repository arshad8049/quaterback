# Quarterback setup guide

This guide takes you from a fresh machine to a verified demo run and an applied patch, in order. Follow it top to bottom: every step says where it runs, what you should see, and what to do next.

**Before you install: this is a supervised evaluation.** Quarterback (QB) is pre-release software. There is no published release, and no current commit has been qualified for installation without support. You install the exact commit you are given when you [request a supervised evaluation](https://quaterback.velorallc.workers.dev/#beta), and the maintainer is available while you go through this guide.

**Contents:**
- [Before you start](#before-you-start): requirements, cost, which commit, what approving a contract means
- [1. Install the prerequisites](#1-install-the-prerequisites)
- [2. Install Quarterback](#2-install-quarterback)
- [3. Make the `qb` command available](#3-make-the-qb-command-available)
- [4. Create the demo repository](#4-create-the-demo-repository)
- [5. Read the demo contract](#5-read-the-demo-contract)
- [6. Dry run](#6-dry-run)
- [7. Sign in to Claude](#7-sign-in-to-claude)
- [8. Check the machine](#8-check-the-machine)
- [9. Run the demo with Claude Code](#9-run-the-demo-with-claude-code)
- [10. Inspect, check and apply the patch](#10-inspect-check-and-apply-the-patch)
- [11. Remove the demo](#11-remove-the-demo)
- [When something goes wrong](#when-something-goes-wrong)
- [On your own repository](#on-your-own-repository)
- [Reference](#reference): `qb doctor` checks, verdicts, run outcomes
- [Sending feedback](#sending-feedback)
- [Uninstalling Quarterback completely](#uninstalling-quarterback-completely) (optional, deletes data)

---

## Before you start

### What you need

| | Dry run (step 6) | Claude Code run (steps 7–10) |
|---|---|---|
| OS | Linux or macOS | **Ubuntu 24.04 LTS on x86_64** is the validated profile. macOS with Docker Desktop works for development but is not validated. Windows is not supported. |
| Node.js 20 or newer, git | ✓ | ✓ |
| Docker Engine | — | ✓ |
| Memory | — | **16 GB RAM**. A run starts only with about 11.1 GiB free (the sandbox's peak plus a 2 GiB reserve), so an 8 GB machine cannot run it. QB unloads the local model before the sandbox starts, so its memory is not counted on top. |
| [Ollama](https://ollama.com) with `deepseek-r1:7b` | — | ✓ (used for context and the reviewer model) |
| Claude access | — | A Claude subscription, or an Anthropic API key |
| Target repository | — | JavaScript / Node.js, tested with **node:test**, with an npm lockfile. The demo repository in step 4 meets this. |

The full support matrix is in [support.md](support.md). No 16 GB machine? The documented GitHub Codespace configuration (4-core / 16 GB) runs this whole guide; check your own Codespaces allowance first: [review/qb31-codespaces.md](review/qb31-codespaces.md).

### What it costs

- **Claude usage.** Every Claude Code attempt uses your Claude subscription's limits or is billed to your API key. A run can make up to 3 attempts by default (`--max-retries`) when verification fails. Quarterback adds no charge of its own. The dry run uses no Claude access.
- **Downloads and disk.** `deepseek-r1:7b` is a download of several GB. The first Claude Code run builds Quarterback's sandbox images, which takes several minutes and needs network access.
- **Time.** The local model is slow on a CPU-only machine; a step that uses it can take minutes. The recorded demo run took 226 seconds end to end in the validated Codespace.

### Which commit to install

Install the **exact commit SHA you were given** for your evaluation, and quote it in any feedback. Don't install the tip of `main` or a branch: they move, and they may contain unqualified changes.

Commits that passed this walkthrough are listed in [support.md](support.md#validated-commits). So far that is only `54c2f24`, on 2026-10-12, which predates later fixes. That record shows the walkthrough passed for that commit in that environment; it does not qualify a later commit, and it is not a reason to install the old one.

### What approving a contract means

The contract is the task written down: requirements, which files may and may not change, and the executable checks that decide PASS or FAIL. **The coding agent does not execute until a person has approved a contract.** Other preparation, such as drafting a contract with the local model, can run before that.

There are two ways to approve one:
- **`--contract-file <file>`:** passing a file **is** your approval, so read it first. Quarterback records the file's hash, and any change to it voids the approval. Quarterback never rewrites a file you supply; if the file is invalid, the run stops.
- **Without `--contract-file`:** Quarterback drafts a contract from your request, prints it, and asks `Approve this contract as the test oracle? [y/N]`. Without a terminal it saves the draft for review and stops.

**Recommended evaluation path:** start from a contract you have written or reviewed, as the demo below does. Automatic drafting is still in development and often fails Quarterback's own validation. Using a reviewed contract avoids that problem; it does not make the rest of the product proven.

---

## 1. Install the prerequisites

Run in: any folder. These commands are for Ubuntu 24.04. On macOS, install Node 20+, git, [Docker Desktop](https://docs.docker.com/desktop/) and [Ollama](https://ollama.com/download) from their installers, then run `ollama pull deepseek-r1:7b`.

```bash
# git, curl; zstd is needed by the Ollama installer
sudo apt-get update && sudo apt-get install -y git curl ca-certificates zstd

# Node 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs

# Docker Engine (https://docs.docker.com/engine/install/ubuntu/)
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"     # then log out and back in, so `docker` works without sudo

# Ollama (local model server; installs and starts a systemd service)
curl -fsSL https://ollama.com/install.sh | sh
ollama pull deepseek-r1:7b
```

Expected: `node --version` prints v20 or newer, `docker run --rm hello-world` works without `sudo` (after logging back in), and `ollama list` shows `deepseek-r1:7b`. **Next:** step 2. If you only want the dry run, Node and git are enough.

## 2. Install Quarterback

Run in: any folder. Everything from here on uses one work folder, `~/qb-beta`, holding the Quarterback checkout and the demo repository. The commands work in bash and zsh.

```bash
mkdir -p ~/qb-beta && cd ~/qb-beta
git clone https://github.com/arshad8049/quarterback.git quarterback
cd quarterback
git checkout <commit-sha-you-were-given>
git rev-parse HEAD                           # record this SHA for feedback
npm ci
```

Expected: `git rev-parse HEAD` prints the SHA you were given, and `npm ci` finishes without an error. If `git checkout` says `pathspec … did not match`, the SHA is mistyped or not on GitHub. **Next:** step 3, in the same terminal.

## 3. Make the `qb` command available

Run in: `~/qb-beta/quarterback`.

```bash
export QBDIR="$PWD"
qb() { node "$QBDIR/qb.js" "$@"; }
qb --help
```

Expected: `Usage: qb [options] <request>`. You may also see lines like `◇ injected env (0) from intent/.env`; they are harmless.

This defines `qb` for the current terminal only, the way the validated walkthrough runs it. In a new terminal, run `export QBDIR=~/qb-beta/quarterback` and the `qb() …` line again. (`npm link` also puts `qb` on your PATH, but with a system-wide Node install it needs root, so it is not the documented path.) **Next:** step 4.

## 4. Create the demo repository

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

Expected: `npm install` finishes without an error, and `git -C qb-demo log --oneline` shows one commit, `demo base`. The placeholder test proves nothing about `clamp`; the contract's checks in step 5 do. **Next:** step 5.

## 5. Read the demo contract

Run in: `~/qb-beta`.

```bash
cat quarterback/docs/demo/clamp-contract.json
```

It asks for a `clamp(n, min, max)` export in `src/utils.js`. It allows changes to `src/utils.js` and `test/**` only, and protects `package.json` and `package-lock.json`. Its executable checks are:

| Check | Call | Expected |
|---|---|---|
| exported | `clamp` is a function | — |
| lower bound | `clamp(-5, 0, 10)` | `0` |
| upper bound | `clamp(50, 0, 10)` | `10` |
| in range | `clamp(7, 0, 10)` | `7` |
| at the bounds | `clamp(0, 0, 10)`, `clamp(10, 0, 10)` | `0`, `10` |

Passing this file with `--contract-file` in the next steps is your approval of it. **Next:** step 6.

## 6. Dry run

Run in: `~/qb-beta`. This needs only Node and git: no Docker, no Claude access, no Ollama. Nothing executes and nothing in `qb-demo` changes.

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

Each criterion is listed with `~` (not verified: there was no change). The exit code is 1, as for every result other than PASS; that is expected here. **Next:** stop here if you only wanted to see the plan, or continue to step 7 for a real run.

## 7. Sign in to Claude

Run in: `~/qb-beta`. Use **one** of these.

**Claude subscription:**

```bash
qb auth login
```

Open the printed URL, sign in, paste the code the page shows back into the terminal and press Enter. Expected: `signed in; access token expires …`. If it says `sign-in did not complete`, run it again. This login is QB-scoped: your own `~/.claude` login is neither used nor changed.

**API key (or a token from `claude setup-token`):** type it at a prompt that doesn't show it, so it never appears on screen or in your shell history:

```bash
printf 'Anthropic API key: '; read -rs ANTHROPIC_API_KEY; echo
export ANTHROPIC_API_KEY
```

For a `claude setup-token` token, use the same two lines with `CLAUDE_CODE_OAUTH_TOKEN` in place of `ANTHROPIC_API_KEY`. Don't write the key into the command itself (`export ANTHROPIC_API_KEY=sk-…`): that line is saved in your shell history. The variable lasts for this terminal only. Quarterback passes it to the sandbox by name and redacts it from run records.

**Next:** step 8, in the same terminal.

## 8. Check the machine

Run in: `~/qb-beta`.

```bash
qb doctor --repo qb-demo
```

Each check prints `✓` ok, `!` warning, `✗` problem or `–` skipped. Expected: no `✗` line, and a last line that starts with `Ready`. The number of warnings depends on your machine. For example, `agent-auth` always shows `!` "validity not verified" because doctor makes no API call, and `memory` shows `!` "not measured" on systems other than Linux. The checks are described in the [reference](#qb-doctor-checks).

Every `✗` line prints a `fix:` line. Apply it and run doctor again. **Next:** step 9 once there is no `✗`.

## 9. Run the demo with Claude Code

Run in: `~/qb-beta`. This uses your Claude access (see [What it costs](#what-it-costs)).

```bash
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" --repo qb-demo --agent claude-code --contract-file quarterback/docs/demo/clamp-contract.json
```

What happens:
1. QB loads the contract file as the test oracle; passing it is your approval.
2. Claude Code runs in the sandbox. The first run also builds the sandbox images.
3. The contract's checks and the node:test suite run on the captured change.
4. QB prints a verdict and the run id.

The stages print as they run (`[L1]` … `[L4]`). A successful run ends with `RESULT: ✓ PASS` and a line `Run: <run_id>  outcome=VERIFIED`, and exits with code 0. Note the run id. If it ends differently, see [When something goes wrong](#when-something-goes-wrong).

Then check that your checkout is untouched:

```bash
git -C qb-demo status --porcelain     # prints nothing: the run did not modify qb-demo
```

**Next:** step 10.

## 10. Inspect, check and apply the patch

Run in: `~/qb-beta`. Replace `<run_id>` with the id from step 9 (`qb runs` lists recent ones).

```bash
qb show <run_id>                          # contract, attempts, verdicts and evidence
qb replay <run_id>                        # recompute every verdict from the stored evidence
qb patch <run_id> --out clamp.patch       # export the change; the header states its verification status
less clamp.patch                          # read it before applying
git -C qb-demo apply --check ../clamp.patch && git -C qb-demo apply ../clamp.patch
node -e "const { clamp } = require('./qb-demo/src/utils'); console.log(clamp(-5, 0, 10), clamp(50, 0, 10), clamp(7, 0, 10))"
```

Expected: `git apply --check` prints nothing, and the last line prints `0 10 7`. `qb patch` refuses to write over an existing file, so pick a new `--out` name if you export again. Applying the patch is the only step that changes `qb-demo`. **Next:** step 11.

## 11. Remove the demo

Run in: `~/qb-beta`. This removes only what the demo created in your work folder:

```bash
rm -rf ~/qb-beta/qb-demo ~/qb-beta/clamp.patch
```

The demo run's record stays in `~/.qb/runs`, with any other runs you have made; `qb runs` lists them. Keep Quarterback installed to try [your own repository](#on-your-own-repository). If you want to remove Quarterback and its data, see [Uninstalling Quarterback completely](#uninstalling-quarterback-completely).

---

## When something goes wrong

| You see | What it means | Do |
|---|---|---|
| `qb: invalid options: …` (exit 2) | Nothing ran and no model was called. | Fix the listed options. `unsupported test runner: <name>` means the repository doesn't use node:test, which is the only runner QB verifies with. |
| `qb doctor` shows `✗` | A requirement is missing. | Apply the `fix:` line it prints, then run doctor again. |
| `FATAL: model call timed out after 180000ms` | The local model didn't answer within the time limit. Possible causes include Ollama not running, the model still loading on its first call, a busy machine, or a request the model takes too long on. The message alone doesn't say which. | Check that `ollama list` shows `deepseek-r1:7b`, then run again. To tell slowness from a stuck call, you can raise the limit for one run as a diagnostic: `QB_MODEL_CALL_TIMEOUT_MS=600000 qb …`. That is a workaround, not a fix: if it only succeeds with the longer limit, say so in feedback. Starting from a reviewed `--contract-file` skips drafting. |
| `✗ QB couldn't build a reliable checklist. No code was changed.` | Quarterback's own draft failed its validation, and its one automatic correction didn't fix it. This is a limit of Quarterback's drafting, not a problem with your request. Nothing ran. | Run again (a new draft may pass), or start from a contract you write or review. Mention it in feedback: it helps measure drafting. |
| `⚠ Ambiguity detected` and a question | The draft needs a detail only you can give. | Answer in the terminal, or pass `--clarify "<answer>"` (repeat for later rounds). |
| `✗ Contract file rejected: …` | The file you passed is not a valid contract. Quarterback never rewrites it. | Fix the file and run again. |
| Verdict `fail` | A check or test failed after every repair attempt (`--max-retries`, 1–10). | `qb show <run_id>` lists the failing criteria and new test failures with their evidence. |
| Verdict `unresolved` / `partial` | Something couldn't be verified, such as a criterion with no executable check or tests that didn't run. | `qb show <run_id>` names what is missing. |
| Outcome `ERROR` | The execution itself failed, for example a timeout, running out of memory, or an infrastructure problem such as Docker stopping. | Run `qb doctor`; for sign-in problems, `qb auth status`, then `qb auth login`. Then run again. |
| Outcome `BLOCKED` | The run stopped before verification. The reason is recorded: for example, the contract was not approved or was invalid, a clarification is still needed, the sandbox refused the project's dependencies, or the machine lacked memory. Not every `BLOCKED` is an environment problem. | `qb show <run_id>` shows the reason. Fix what it names: approve or correct the contract, answer the question, or fix the environment. |
| A run that takes too long | — | `--deadline <minutes>` ends it as `CANCELLED`, naming the stage it was in. |

**A recovery you can try safely** (Ubuntu): stop Docker, see doctor name the problem, start it again.

```bash
sudo systemctl stop docker docker.socket
qb doctor                              # ✗ docker: not running or not reachable
sudo systemctl start docker
qb doctor                              # ✓ docker
```

On macOS, quit and restart Docker Desktop instead.

---

## On your own repository

Run in: the folder holding your repository, with `qb` defined as in [step 3](#3-make-the-qb-command-available). Your repository must meet the [target requirements](#what-you-need); `qb doctor --repo my-repo` checks it.

Start from a contract you review. Write one by hand using [`demo/clamp-contract.json`](demo/clamp-contract.json) as the model (the fields are described in [verify/](verify/)), or let Quarterback draft one and save it without running anything:

```bash
qb "<your request>" --repo my-repo --agent claude-code < /dev/null
```

Without a terminal on its input, Quarterback stops after drafting and prints `Review (and edit if needed): <file>`. Review that file, then run with `--contract-file <file>`. In a terminal, the same command shows the draft and asks you to approve it.

Useful options:
- `--clarify "<answer>"` answers a clarifying question without the prompt (repeat for later rounds);
- `--max-retries <1-10>` sets the number of repair attempts;
- `--deadline <minutes>` ends a run that takes too long, as `CANCELLED`;
- `--agent manual` prints the briefing for your own agent; the run ends `unresolved`, never `pass`.

All options: `qb --help`.

---

## Reference

### `qb doctor` checks

```bash
qb doctor                          # for --agent claude-code (the default)
qb doctor --repo /path/to/repo     # also checks the repository and its test runner
qb doctor --agent dry-run --json   # machine-readable report (qb-doctor/1)
```

Exit code 0 means no `✗`; 1 means fix the `✗` lines first.

| Check | What it needs |
|---|---|
| `runtime` | Node 20 or newer |
| `git` | git on PATH |
| `docker` | the Docker daemon answers (required for `claude-code`) |
| `memory` | free memory covers the sandbox admission need, about 11.1 GiB (only for `claude-code`; measured on Linux, elsewhere it shows `!` not measured) |
| `agent-auth` | a credential is **stored**: one saved by `qb auth login`, or `ANTHROPIC_API_KEY` (only for `claude-code`). Doctor makes no API call, so it can't tell whether the credential is valid and always shows `!` "validity not verified". The first authenticated call of a real run is the proof. |
| `model` | Ollama at `QB_OLLAMA_URL` with `QB_MODEL` pulled |
| `agent-adapter` | a supported agent (`qb-agent-adapter/1`) |
| `check-registry` | the executable-check registry loads |
| `repository`, `test-runner` | with `--repo`: a git work tree (required for `claude-code`), with node:test as the runner. Any other runner, or an invalid `.quarterback.json`, is `✗`: `qb` refuses an agent run there before any model call (only `--agent dry-run` still plans) |

### Verdicts and run outcomes

**Verification results** (per attempt):

| Verdict | Meaning |
|---|---|
| `pass` | Every criterion met and the tests passed |
| `fail` | A criterion not met, a new failing test, or a change to a protected path |
| `partial` | Some criteria could not be decided |
| `unresolved` | The evidence couldn't establish the result, for example a criterion with no executable check, or tests that didn't run |

Two other states mean nothing was verified: `error` (the execution itself failed) and `no-diff` (there was no change to verify).

**Run outcomes:** `VERIFIED` (pass), `FAILED`, `UNRESOLVED`, `ERROR`, `BLOCKED` (stopped before verification, with a recorded reason), `CANCELLED` (deadline or interruption), `DRY_RUN` or `ABANDONED`. `qb` exits 0 only when the verdict is `pass`.

- **`qb patch`** exports the patch with its verification status in the header, which may be fail or partial. It refuses to export a patch it can't trust and never writes into your checkout.
- **`qb replay`** recomputes each verdict from the saved evidence and checks it matches the record. It does not rerun the agent or the tests.

Run records are stored in `~/.qb/runs` (or `QB_RUNS_DIR`).

---

## Sending feedback

Send feedback through your evaluation contact, or open an issue on [GitHub](https://github.com/arshad8049/quarterback/issues) with this template:

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

Before you send it, check the excerpt: replace your home folder with `~`, repository and file names with placeholders, and remove any code. Don't include credentials, API keys, tokens, proprietary prompts or source code. A run id is local to your machine: it doesn't give the maintainers access to your run, so describe what you saw.

---

## Uninstalling Quarterback completely

**Optional, and it deletes data.** Only do this if you want to remove Quarterback and everything it has stored on this machine. It is not part of the demo.

`~/.qb` and `~/.quarterback` hold **all** of Quarterback's state on this machine, not just the demo's: the records of every run (including runs on your own repositories), project memory, the judge cache and sandbox state. Deleting them cannot be undone, and `qb runs`, `qb show`, `qb replay` and `qb patch` stop working for those runs. Export any patch you still need first (`qb patch <run_id> --out <file>`).

```bash
qb auth logout                     # if you signed in with `qb auth login`; removes QB's stored Claude login
rm -rf ~/.qb ~/.quarterback        # ALL run records, memory, caches and sandbox state on this machine
docker image ls 'qb-sandbox-*'     # Quarterback's sandbox images; remove each with `docker image rm <image>`
rm -rf ~/qb-beta                   # the Quarterback checkout and anything else in the work folder
```

If you set `QB_RUNS_DIR`, your run records are in that folder instead of `~/.qb/runs`.
