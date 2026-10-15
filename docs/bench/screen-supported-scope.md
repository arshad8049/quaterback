# Harder-task screen: supported scope (KAN-65)

**Status:** owner decision, option (a), recorded 2026-10-15. Exploratory set; never headline evidence.

## Decision

The 14 Fastify screen tasks (FY-01 … FY-14) were all considered. **10 are included** in the next
supported-scope screen and **4 are excluded**: FY-04, FY-06, FY-11 and FY-12.

The decision was taken **after the screen's results had been seen** (GitHub runs 38409518314
and 38459455639). All original results are kept unchanged, and both arms use the same selection.

## Why the four are excluded

In each excluded task, the correct fix changes behaviour that an **existing, visible repository
test** asserts. Upstream Fastify changed that same test in the fix commit:

| Task | Upstream fix | Existing test that contradicts the fix |
|---|---|---|
| FY-04 | 2ae3e1d7 (#6523) | `test/internals/errors.test.js` › "should expose 88 errors" (and three docs/types consistency tests, see KAN-70) |
| FY-06 | 7299a57d (#6845) | `test/reply-trailers.test.js` › "remove all trailers" |
| FY-11 | 29bdcbb9 (#6865) | `test/content-type.test.js` › "skips invalid quoted string parameters" |
| FY-12 | 6f63ce93 (#6830) | `test/internals/reply.test.js` › "non-string with custom json's content-type…" |

QB protects existing tests: verify-prep restores protected base tests before the candidate's
tests run. A correct patch for these tasks therefore always shows the old test failing, and
QB reports it as a **regression**. Its repair hint then asks the agent to make the old test
pass, which means undoing the required behaviour.

This is a **product limitation**, not a benchmark defect. QB does not yet support a task whose
correct solution must update an existing test.

- **Rewording the prompt would not help.** A prompt can't change a verifier that restores
  protected tests, and it would promise a permission the product doesn't support.
- **The real fix** is narrowly scoped, human-approved test updates, with independent checks
  kept protected. That needs its own design card; it is not part of this benchmark fix.

## The four are diagnostic cases

FY-04, FY-06, FY-11 and FY-12 remain frozen (version 2), and their replays are kept. They
document the limitation above. Removing them is **not** an improvement in performance and must
never be reported as one.

FY-04 has a further, separate problem. Its reference patch also lacks the upstream
documentation and type updates that Fastify's own consistency tests check (KAN-70).

## FY-08: the base failed one of its own tests (found by the v2 replays; fixed in version 3)

In version 2, every FY-08 replay, including the unchanged base, ended in `fail` with
`preexisting_failures_not_waived`. Fastify v5.12.0 itself fails `test/internals/reply.test.js`
› "Once called, Reply should return an object with methods". 430dd4ed made `reply.mediaType`
return `undefined` without a content type, and the test still expected a string. Upstream fixed
the test after the release (65d12da9, "test: fix reply.mediaType (#6949)").

Qualification only ran the hidden suite, so it did not catch this. In the original screen,
FY-08's E arm was internally `fail` while the hidden grade was `pass`; the lint failures
that v2 removed hid the cause.

The fix:
- FY-08 version 3 (disclosed, after viewing results) runs on `qb-bench:fastify-5.12.0-t6949`,
  which is v5.12.0 plus upstream's one-line test fix (`upstream_commits` in
  `bench/repos/repos.json`). Prompt, oracle, reference, incorrect implementations, hidden suite
  and lockfile are unchanged.
- Qualification (`bench/qualify.js`) now also requires the unchanged base to pass the
  repository's own tests. Run against FY-08's version 2 base in the sandbox, it refuses
  it and names that test. FY-08 stays among the included 10; its version 2 replays are kept.

## Reporting rule

Any result on this screen states, next to the numbers:
"14 tasks considered, 10 included, 4 excluded (existing tests contradict the required change;
decided after observing results)". Both arms use the same 10 tasks.

## Evidence

- Version 2 specs: `bench/screen/specs/`. They were rebuilt with `neostandard` and the change
  is disclosed in each spec's changelog. Lock: `bench/screen/specs.lock.json`.
- No-model replays, run through QB's real pipeline in Docker with fixed patches:
  - tool: `scripts/kan65-replay.js`;
  - CI: `.github/workflows/kan65-replay.yml`;
  - for every task, the base, the reference and each incorrect implementation are replayed.
- A missing behavioural check stays **unresolved**, so its verdict is `partial`, never `pass`.
