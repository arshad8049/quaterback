# Getting started (QB-31)

From a fresh machine to an inspected run:
1. install;
2. `qb doctor`;
3. a demo task;
4. recovering from a failure;
5. inspecting what QB recorded.

Supported setups are listed in [support.md](support.md).

**Validated profile:** Ubuntu 24.04 LTS on x86_64, Node 24, Docker Engine, **at least 16 GB RAM**. A `--agent claude-code` run is admitted only with about 11.1 GiB of memory free (the sandbox's per-run peak plus a 2 GiB reserve), so an 8 GB machine cannot run it. macOS + Docker Desktop works for development but is not validated, and Windows is not supported.

A guided script for the fresh-machine walkthrough, which records the evidence as it goes, is in [`scripts/qb31-walkthrough.sh`](../scripts/qb31-walkthrough.sh).

## 1. Install

### Prerequisites (Ubuntu 24.04)

```bash
# git, curl
sudo apt-get update && sudo apt-get install -y git curl ca-certificates

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

### QB

QB is pre-release and not on npm. Check out the **exact ref you were given**, and record it. During the beta, features may exist only on a release branch, not on `main`.

```bash
git clone https://github.com/arshad8049/quaterback.git
cd quaterback
git checkout <ref-you-were-given>      # e.g. a reviewed commit SHA
git rev-parse HEAD                     # record this SHA
npm ci
npm link                               # optional: puts `qb` on your PATH (otherwise use `node qb.js`)
qb auth login                          # sign the sandboxed Claude Code in with your Claude subscription
```

`qb auth login` prints a URL. Open it, sign in, and paste the code back. It uses a QB-scoped login: your own `~/.claude` login is neither used nor changed. An `ANTHROPIC_API_KEY` works too, but isn't required.

## 2. Check the machine: `qb doctor`

```bash
qb doctor                          # for --agent claude-code (the default here)
qb doctor --repo /path/to/repo     # also checks the repository and its test runner
qb doctor --agent dry-run --json   # machine-readable report (qb-doctor/1)
```

Each check prints `✓` ok, `!` warning, `✗` problem or `–` skipped, with a `fix:` line. Exit code 0 means no `✗`; 1 means fix the `✗` lines first.

| Check | What it needs |
|---|---|
| `runtime` | Node 20 or newer |
| `git` | git on PATH |
| `docker` | the Docker daemon answers (required for `claude-code`) |
| `memory` | free memory covers the sandbox admission need, about 11.1 GiB (only for `claude-code`; Linux; elsewhere it shows `!` not measured) |
| `agent-auth` | a credential is **present**: the `qb auth login` volume or `ANTHROPIC_API_KEY` (only for `claude-code`). Doctor makes no API call, so it can't tell whether the credential is valid; it always shows `!` "validity not verified". The first authenticated call of a real run is the proof. |
| `model` | Ollama at `QB_OLLAMA_URL` with `QB_MODEL` pulled |
| `agent-adapter` | a supported agent (`qb-agent-adapter/1`) |
| `check-registry` | the executable-check registry loads |
| `repository`, `test-runner` | with `--repo`: a git work tree (required for `claude-code`); node:test as the runner |

## 3. Demo task

A small repository with a node:test suite. Run this next to the `quaterback` checkout:

```bash
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
cd ..

qb doctor --repo qb-demo
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" --repo qb-demo --agent claude-code --contract-file quaterback/docs/demo/clamp-contract.json
```

The placeholder test proves nothing about `clamp`. What makes this demo meaningful is the **reviewed contract**, `docs/demo/clamp-contract.json`. Read it before approving. Its executable checks are:

| Check | Call | Expected |
|---|---|---|
| exported | `clamp` is a function | — |
| lower bound | `clamp(-5, 0, 10)` | `0` |
| upper bound | `clamp(50, 0, 10)` | `10` |
| in range | `clamp(7, 0, 10)` | `7` |
| at the bounds | `clamp(0, 0, 10)`, `clamp(10, 0, 10)` | `0`, `10` |

**What happens:**
1. QB loads the contract file as the test oracle; passing it is your approval (QB-13).
2. Claude Code runs in the sandbox.
3. The checks and the node:test suite run on the captured tree.
4. QB prints a verdict and the run id (`[RUN] <run_id>`).

**Your checkout is not changed.** Check it before applying anything:

```bash
git -C qb-demo status --porcelain     # prints nothing: the run did not modify qb-demo
```

Without Docker or a sign-in, `--agent dry-run` shows the contract and briefing and changes nothing.

## 4. When something fails

**A recovery you can try safely:** stop Docker, see doctor name the problem, start it, retry.

```bash
sudo systemctl stop docker docker.socket
qb doctor                              # ✗ docker: not running or not reachable
sudo systemctl start docker
qb doctor                              # ✓ docker
```

Then rerun the demo command.

| You see | Do |
|---|---|
| `qb: invalid options: …` (exit 2) | Fix the listed options. Nothing ran and no model was called. |
| `qb doctor` shows `✗` | Apply its `fix:` line, then run it again. |
| A clarifying question | Answer it in the terminal, or pass `--clarify "<answer>"` (repeat for later rounds). |
| Verdict `fail` | QB already retried up to `--max-retries` (1–10) with repair hints. Read the report with `qb show <run_id>`. The failing criteria and new test failures are listed with their evidence. |
| Verdict `unresolved` / `partial` | Something couldn't be verified, such as a criterion with no executable check or tests that were `not_run`. `qb show` names what is missing. |
| `error` / `infra_error` / `blocked` | An environment problem: Docker down, sign-in invalid or expired (`qb auth status`, then `qb auth login`), or the setup gate refused the project's dependencies. Run `qb doctor`, then rerun. |
| A run that takes too long | `--deadline <minutes>` ends it as `CANCELLED`, naming the stage it was in. |

## 5. Inspect what QB recorded

```bash
qb runs                                # recent runs
qb show <run_id>                       # manifest, contract, attempts, verdicts
qb replay <run_id>                     # recompute every verdict from the stored evidence
qb patch <run_id> --out clamp.patch    # the captured change, labelled with its verification status
```

Apply the patch only to the disposable demo, then check the behaviour yourself:

```bash
git -C qb-demo apply --check ../clamp.patch && git -C qb-demo apply ../clamp.patch
node -e "const { clamp } = require('./qb-demo/src/utils'); console.log(clamp(-5, 0, 10), clamp(50, 0, 10), clamp(7, 0, 10))"   # 0 10 7
```

Records live in `~/.qb/runs` (or `QB_RUNS_DIR`). `qb patch` refuses to export a change it can't trust, and states the verification status in the patch header.
