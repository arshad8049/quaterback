# Hero run, 2026-10-15: contract and run bundle

These are the files behind the terminal capture on the home page (`hero-run.log`).

**The run:**
- QB `3fc08fd` (main), run `e01b3273-1737-4ca6-8f0a-5a172f4e74e6`, outcome **VERIFIED**;
- Claude Code 2.1.288 in QB's Docker sandbox;
- local model `deepseek-r1:7b`, used for context and the judge.

The patch was proposed, not applied.

## Files

| File | What it is | sha256 |
|---|---|---|
| `contract.json` | The human-reviewed contract the run used (`--contract-file`), byte-for-byte as approved | `baa7c3f237de580837900393835902d0039a54279581f3070640d2a95b9f22ad` |
| `sample-repo.bundle` | The two-file sample repository as a git bundle. Base `14fcfe4efa8f965ae2fb08b44fe0ef2a3869cf50`; the author is a placeholder (`demo@example.invalid`) | `044ce30d298ff4f9260867996830d5163f12bb526aaaffdd905ff70c28771d4b` |
| `run/manifest.json` | QB's run manifest | `971883b6397d20ad71db0f96f21723b85770cfb617e09f31a16cbd3b97f39248` |
| `run/events.jsonl` | QB's event log for the run | `089bee74e588ab748be0977d0a66ca9fc6ff0681328eebd5dcc648edcef8bafa` |
| `run/artifacts/` | The run's stored artifacts. Each file is named by its own sha256. `0213…87ea.diff` is the proposed patch, and `6793…0cf6.json` is the contract as QB stored it (the manifest's `contract_hash`) | as named |
| `hero-run.log` | The captured log shown on the page | `5b83f5e2b27934890f01e34e031ab3c3679b05192a32f82512a40bde33ea76b6` |

**What was edited:** in `run/manifest.json` and `run/events.jsonl`, the local folder holding the sample repository and the contract was shortened to `~/demo`, as in `hero-run.log`. Nothing else was edited. The artifacts are unchanged and still match their names.

**No credentials:** the run used a stored sign-in (`credential_mode` S), which is not part of the record. The only token field in the events is QB's redacted usage count.

`contract_hash` in the manifest is QB's hash of the contract it stored, which is the artifact `6793…0cf6.json`. It is not the hash of the file on disk. The file on disk is `contract.json`, and its sha256 is `baa7c3f2…` (in the table).

## Checking it without an agent

```
git clone sample-repo.bundle hero-demo && cd hero-demo
git apply ../run/artifacts/021328960d9d5b7c6fca0377ebbdeba04fbf1e14ee1bb98011ee05a78acf87ea.diff
node --test test/
node -e "const { formatDuration: f } = require('./src/duration'); console.log(f(30000), '|', f(90000))"
```

- The repository's own test passes.
- The output is `30s | 1m 30s`, which is what the contract's checks CHK-1 and CHK-2 expect (`call_returns`).

## Running it again with QB

This needs QB at `3fc08fd`, Docker, a Claude Code sign-in and a local `deepseek-r1:7b`:

```
qb "formatDuration should show durations under one minute as seconds only, for example 30000 ms as \"30s\" instead of \"0m 30s\". Durations of one minute or more keep the current format." \
  --repo hero-demo --agent claude-code --contract-file contract.json
```

This calls a real agent, so the new patch can differ from the recorded one. The contract, the checks and the sample repository are the same.

**Where the contract came from:**
- The local model compiled it on 2026-10-14 (QB build `850c282`; see `../2026-10-14-hero-run/hero-run.log`, step 1). The owner reviewed and edited it before approval.
- On main, the local model did not produce a usable contract for this request in 22 attempts (Jira KAN-73).
