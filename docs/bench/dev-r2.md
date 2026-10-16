# Dev set: re-qualification revision r2 (KAN-71)

**Status:** drafted, and reproduced exactly on a fresh GitHub runner: run 38849464285 at
4ba73ef, 30/30. **Not frozen.** Freezing needs the owner's approval
(KAN-65 comment 10324). This revision does not approve a paid evaluation.

## Why

eb3fec6 (the KAN-65 regression-classification fix) changed `verify/tests.js`, one of the files
the grader hashes (`GRADER_FILES` in `bench/grader.js`). Every frozen v1 dev qualification
records grader `3116461e…`, while the current grader is `f088eb07…`. The grader therefore
refuses to grade any v1 dev task (`grader_error`, `grader_changed`), and `qb30-reproduce`
reports 0/30 reproduced for that reason alone.

## What r2 is

- A **new revision beside v1**, not an edit of it.
  - v1 stays as frozen: `bench/specs/*.json` and `bench/specs.lock.json` (sha256 `ee79c548…`,
    pinned by `test/unit/kan71-dev-r2.test.js`).
  - v1 results stay where they are.
- r2 lives in `bench/dev-r2/`: `specs/` and its own `specs.lock.json`, created at freeze. It
  shares the curation (`bench/curation`) and hidden suites (`bench/suites`) with v1
  (`node bench/curate.js … --set dev-r2`).
- **Each task becomes version 2** with one disclosed changelog entry (`after_viewing_results:
  true`).
  - Unchanged: the prompt, requirement, oracle criteria, repository, `base_rev`, hidden suite,
    reference and incorrect implementations.
  - Changed: only the grader hash and `qualified_at`. The oracle approval is given again at
    freeze.
- Qualification now also runs the **base check** (KAN-65). Each draft records it as
  `base_tests: { command, outcome: "passed" }`, and freeze refuses a draft without it.
- v1 and v2 results are never combined.

## How it is checked

`scripts/kan71-requalify-check.js` compares every v2 draft with its frozen v1 spec. The rules
are unit-tested in `test/unit/kan71-dev-r2.test.js`:
- v2 may differ only by version, one new changelog entry, the grader hash (which must be the
  current grader's) and `qualified_at`;
- the base check must have passed;
- with `--committed <dir>`, the fresh draft must also equal the committed draft apart from
  `qualified_at`.

`.github/workflows/kan71-requalify.yml` runs this on a fresh GitHub-hosted runner:
1. builds the 5 pinned task repositories;
2. re-qualifies all 30 tasks with the real grader in Docker;
3. checks them against both v1 and the committed drafts.

## Provenance

`bench/dev-r2/revision.json` records, per task:
- **v1:** version, lock hash, grader and `qualified_at`;
- **v2:** version, grader, `qualified_at` and `base_tests`;
- where each was qualified, and the fresh-runner run that reproduced it.

## Freezing (owner only)

After the owner approves:

```
node bench/curate.js freeze all --set dev-r2 --approver "<name>"
```

This writes `bench/dev-r2/specs/<ID>.json` and `bench/dev-r2/specs.lock.json`. An experiment
then names that lock and the shared suites, as the screen plans do (`"lock"` and `"suites"` in
`bench/pilot/*.json`).
