# Contract compilation rate (KAN-73)

**What it measures:** how often QB's intent compiler turns a request into a **valid** contract,
and why the other attempts are not valid.
- "Valid" means `contractState` says `finalized`: exactly what `qb.js` requires before it asks a
  person to approve the contract.
- It does **not** mean the contract is right. In KAN-73, none of the valid contracts was usable
  without human edits.

**No agent and no spend.** Only the intent model is called. A unit test checks that the script
never loads agent or sandbox code, even indirectly.

## The request set

`bench/compile-requests/v1.json` (`qb-compile-requests/1`, version 1) holds 32 requests:
- **HERO-1 and HERO-2:** the two wordings KAN-73 recorded, on the hero-demo sample repository.
  - The repository is `bench/compile-requests/fixtures/hero-demo`, the website hero run's base
    14fcfe4.
  - Each attempt surveys a fresh copy, committed with a fixed author and date.
- **dev-r2/<ID>:** every frozen dev-r2 task prompt, verbatim, on its task repository at
  `base_rev`, read from the dev-r2 lock.

**The set is fixed once versioned.** A change is a new version file, never an edit. The summary
records a sha256 over the set file, the fixtures and the dev-r2 lock, so two summaries with the
same hash compiled the same inputs.

## Running it

```
node scripts/kan73-compile-rate.js [--n 3] [--only HERO-1,dev-r2/AV-01] [--out <dir>]
```

- **Model:** `QB_MODEL`, default `deepseek-r1:7b`, through `QB_OLLAMA_URL`, as in `qb.js`.
- **Entry point:** each attempt calls `compileIntent` the way `qb.js` does: repository survey,
  then the model. There are no clarification answers and no prompt, so a clarifying question
  counts as not valid, with the reason `needs_clarification`.
- **Order:** attempts run one after another, on one local model.

**Output:**
- `attempts.jsonl`: one record per attempt, with the state, every validation error, the first
  reason and the duration.
- `summary.json`:
  - provenance: the QB commit and whether the tree was dirty, the model name, digest and
    quantisation, Node and the platform;
  - valid counts per request and overall;
  - the count of each first reason.
- **Reason grouping:** a first reason has its ids and quoted values replaced (`<id>`, `"…"`), so
  equal causes group together, for example every "refers to unknown check" mismatch. The raw
  errors stay in `attempts.jsonl`.

## Status

**Step 1 of KAN-73's proposed done-when** (the set and the script) is this change.
- **Step 2,** a recorded baseline for `deepseek-r1:7b` at current main, is not done. The
  number of attempts per request is for the senior to set.
- **Step 3,** changes justified against that baseline, has not started.
- **Validation rules are never weakened** to raise the rate.
