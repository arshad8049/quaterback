# Getting started (QB-31)

From a fresh machine to an inspected run: install, `qb doctor`, a demo task, recovering from a failure, and inspecting what QB recorded. Supported setups are listed in [support.md](support.md).

## 1. Install

You need Node 20+, git, Docker (Docker Engine on Linux; Docker Desktop on macOS for development) and [Ollama](https://ollama.com).

```bash
git clone https://github.com/arshad8049/quaterback.git
cd quaterback
npm ci
npm link                 # optional: puts `qb` on your PATH (otherwise use `node qb.js`)
ollama pull deepseek-r1:7b
qb auth login            # signs the sandboxed Claude Code in (or set ANTHROPIC_API_KEY)
```

`qb auth login` uses a QB-scoped login. Your own `~/.claude` login is neither used nor changed.

## 2. Check the machine: `qb doctor`

```bash
qb doctor                          # for --agent claude-code (the default here)
qb doctor --repo /path/to/repo     # also checks the repository and its test runner
qb doctor --agent dry-run --json   # machine-readable report (qb-doctor/1)
```

Each check prints `✓` ok, `!` warning, `✗` problem or `–` skipped, with a `fix:` line. Exit code 0 means ready; 1 means fix the `✗` lines first.

| Check | What it needs |
|---|---|
| `runtime` | Node 20 or newer |
| `git` | git on PATH |
| `docker` | the Docker daemon answers (required for `claude-code`) |
| `agent-auth` | `qb auth login` or `ANTHROPIC_API_KEY` (only for `claude-code`) |
| `model` | Ollama at `QB_OLLAMA_URL` with `QB_MODEL` pulled |
| `agent-adapter` | a supported agent (`qb-agent-adapter/1`) |
| `check-registry` | the executable-check registry loads |
| `repository`, `test-runner` | with `--repo`: a git work tree (required for `claude-code`); node:test as the runner |

## 3. Demo task

A small repository with a node:test suite:

```bash
mkdir qb-demo && cd qb-demo && git init -q
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
qb "Add a clamp(n, min, max) function to src/utils.js that bounds n to [min, max]" --repo qb-demo --agent claude-code
```

**What happens:**
1. QB compiles a contract and shows it, with examples recomputed by trusted arithmetic.
2. You approve it: it becomes the test oracle (QB-13).
3. Claude Code runs in the sandbox.
4. Tests and checks run on the captured tree.
5. QB prints a verdict and the run id (`[RUN] <run_id>`).

Your checkout is never written. The change comes back as a patch.

Without Docker or a sign-in, `--agent dry-run` shows the contract and briefing and changes nothing.

## 4. When something fails

| You see | Do |
|---|---|
| `qb: invalid options: …` (exit 2) | Fix the listed options. Nothing ran and no model was called. |
| `qb doctor` shows `✗` | Apply its `fix:` line, then run it again. |
| A clarifying question | Answer it in the terminal, or pass `--clarify "<answer>"` (repeat for later rounds). |
| Verdict `fail` | QB already retried up to `--max-retries` (1–10) with repair hints. Read the report with `qb show <run_id>`. The failing criteria and new test failures are listed with their evidence. |
| Verdict `unresolved` / `partial` | Something couldn't be verified, such as a criterion with no executable check or tests that were `not_run`. `qb show` names what is missing. |
| `error` / `infra_error` / `blocked` | An environment problem: Docker down, sign-in expired (`qb auth status`, then `qb auth login`), or the setup gate refused the project's dependencies. Run `qb doctor`, then rerun. |
| A run that takes too long | `--deadline <minutes>` ends it as `CANCELLED`, naming the stage it was in. |

## 5. Inspect what QB recorded

```bash
qb runs                                # recent runs
qb show <run_id>                       # manifest, contract, attempts, verdicts
qb replay <run_id>                     # recompute every verdict from the stored evidence
qb patch <run_id> --out clamp.patch    # the captured change, labelled with its verification status
git -C qb-demo apply --check ../clamp.patch && git -C qb-demo apply ../clamp.patch
```

Records live in `~/.qb/runs` (or `QB_RUNS_DIR`). `qb patch` refuses to export a change it can't trust, and states the verification status in the patch header.
