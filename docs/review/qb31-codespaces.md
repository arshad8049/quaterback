# QB-31 walkthrough in GitHub Codespaces

A free way to run the QB-31 fresh-machine walkthrough: no credit card, no local VM. The Codespace uses `.devcontainer/qb31-walkthrough`, which gives you:
- Ubuntu 24.04 on x86_64;
- 4 cores and 16 GB of RAM;
- Docker preinstalled.

The walkthrough script installs Node 24, Ollama and QB itself, as it would on a fresh VM, and writes the evidence record.

**Rehearsed:** the same container passed every step that doesn't need a real agent on a fresh GitHub runner (workflow `qb31-rehearsal`, job `codespace`, 2026-10-12). That covers the install, the model, `qb doctor` with 14.1 GiB free, the demo repository and the Docker recovery drill.

**Differences from a VM, for the reviewer:**
- A Codespace is a container. It runs without `systemd`, so the script starts Ollama directly.
- In step 9 it stops and restarts the Docker daemon through the container's own init script, instead of `systemctl`.
- Everything else is the same as `docs/onboarding.md`.

## Cost

- **Free for a personal account.** Each month you get 120 core-hours and 15 GB of storage. A 4-core machine uses 4 core-hours per hour, so the allowance covers about 30 hours. The walkthrough takes about 1 hour.
- **No overage charges.** Without a payment method on file, GitHub stops the Codespace when the allowance runs out; it doesn't bill you. You can check usage at <https://github.com/settings/billing>.
- **Claude usage.** The walkthrough runs **two real Claude Code tasks** on your Claude subscription: the demo, and the rerun after the Docker drill.

## 1. Create the Codespace (about 3 minutes)

1. Open <https://github.com/arshad8049/quaterback>. Make sure you're signed in to GitHub.
2. Click the green **Code** button, open the **Codespaces** tab, then the **⋯** menu, and choose **New with options…**
3. Set the options:
   - **Branch:** `main`
   - **Dev container configuration:** *QB-31 walkthrough (Ubuntu 24.04, 16 GB)*
   - **Region:** the one nearest you
   - **Machine type:** **4-core** (16 GB RAM). Smaller machines are greyed out; the sandbox needs about 11.1 GiB free.
4. Click **Create codespace**. A browser VS Code opens and builds the container, which takes a few minutes the first time.

## 2. Run the walkthrough (about 45–60 minutes)

1. Open the terminal at the bottom of VS Code. If you don't see it, use **☰ → Terminal → New Terminal**.
2. Run this in the terminal:

```bash
QB31_EVIDENCE=/workspaces/quaterback/qb31-evidence bash scripts/qb31-walkthrough.sh --ref "$(git rev-parse HEAD)"
```

3. The script runs 11 steps and prints `→ <step>: PASS/FAIL` after each one. You act in three places:

| Step | What you do |
|---|---|
| 1 Prerequisites | Nothing. `sudo` needs no password in a Codespace, and Docker already works. |
| **4 `qb auth login`** | It prints a URL. **Ctrl-click** it (**Cmd-click** on a Mac) to open it. Sign in to Claude, copy the code it shows, paste it into the terminal and press Enter. **This step is not recorded.** |
| **7 Demo run** | One real Claude Code task. If QB asks a clarifying question, answer it in the terminal. |
| **9 Recovery drill** | Nothing. The script stops Docker, shows `qb doctor` failing, restarts Docker, and then reruns the demo (the second real task). |

4. If anything stops the script, fix it and resume from that step. For example, to resume at step 7:

```bash
QB31_EVIDENCE=/workspaces/quaterback/qb31-evidence bash scripts/qb31-walkthrough.sh --ref "$(git rev-parse HEAD)" --from 7
```

## 3. Collect the evidence

1. The script ends with `Evidence written to /workspaces/quaterback/qb31-evidence/evidence.md`.
2. Open `qb31-evidence/evidence.md` in the Explorer. Fill in **operator** and **provider**: write *GitHub Codespaces, 4-core*.
3. Add any place where the docs confused you under **Documentation gaps found**.
4. Right-click the `qb31-evidence` folder in the Explorer and choose **Download…**.
5. Send the folder to Claude, or attach it to KAN-31.

`qb31-evidence/` is git-ignored, so it won't be committed by accident. **Don't** commit or push from the Codespace.

The logs are redacted automatically: keys, tokens and codes are removed, and the sign-in step isn't recorded. Skim them anyway before sharing.

## 4. Delete the Codespace

1. Go to <https://github.com/codespaces>.
2. Find the codespace, open its **⋯** menu and choose **Delete**.

This frees its storage. It also stops by itself after 30 minutes idle, but a stopped Codespace still counts against your storage allowance until it is deleted. Your QB sign-in lived only inside the Codespace, so it is deleted with it.
