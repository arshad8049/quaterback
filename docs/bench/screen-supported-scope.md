# Harder-task screen: supported scope (KAN-65)

**Status:** owner policy decision, option (a), 2026-10-14 (Jira KAN-65, comment 10319).
Exploratory set; never headline evidence. This plan does **not** approve a paid run.

## Decision

The 14 Fastify screen tasks (FY-01 … FY-14) were all considered. **10 are included** in the new
supported-scope execution plan and **4 are excluded** from it: FY-04, FY-06, FY-11 and FY-12.

- The decision was taken **after the screen's results had been seen** (GitHub runs 38409518314
  and 38459455639): `after_viewing_results = true`.
- The excluded four stay in the historical 14-task record and its denominator, with their
  original results, failures and reruns. They are named compatibility cases, not invalid tasks.
- Both arms use the same selection. Supported-subset outcomes are reported separately from
  full-set coverage and limitations. v1 and v2 scores are never combined.

The plan is `bench/pilot/screen-supported.json`. It names all 14 tasks, the 10 included, the
4 excluded with their reason, the rule, the decision and its date, and `after_viewing_results`.
The experiment runner copies the whole config, with its hash, into the manifest of any run made
from it. `test/unit/qb30-screen-set.test.js` checks it against the original screen and the lock.

## Eligibility rule

A task is eligible when, in the no-model fixed-patch replay at the pinned QB commit:
1. the unchanged base passes the repository's own tests, and
2. the known-correct reference passes the repository's protected visible tests with no regression.

The rule is applied to every task the same way, from the replay records, not from earlier
agent-run verdicts. It gives exactly the owner's selection:

| Task | Spec | (1) Base passes own tests | (2) Reference: protected tests | Reference replay | Plan |
|---|---|---|---|---|---|
| FY-01 | v2 | pass | pass | partial, 1 attempt | included |
| FY-02 | v2 | pass | pass | partial, 1 attempt | included |
| FY-03 | v2 | pass | pass | partial, 1 attempt | included |
| FY-04 | v2 | pass | **5 regressions** | fail, 2 attempts | excluded |
| FY-05 | v2 | pass | pass | partial, 1 attempt | included |
| FY-06 | v2 | pass | **1 regression** | fail, 2 attempts | excluded |
| FY-07 | v2 | pass | pass | partial, 1 attempt | included |
| FY-08 | v3 | pass (v2: **fail**, see below) | pass | partial, 1 attempt | included |
| FY-09 | v2 | pass | pass | partial, 1 attempt | included |
| FY-10 | v2 | pass | pass | partial, 1 attempt | included |
| FY-11 | v2 | pass | **1 regression** | fail, 2 attempts | excluded |
| FY-12 | v2 | pass | **1 regression** | fail, 2 attempts | excluded |
| FY-13 | v2 | pass | pass | partial, 1 attempt | included |
| FY-14 | v2 | pass | pass | partial, 1 attempt | included |

On every included task, the correct reference stops after one attempt at `partial`, a non-fail
outcome. The behavioural checks have no evidence in a no-model replay, so they stay
**unresolved**; nothing becomes `pass`.

## Why the four are excluded

Exclusion reason: **required behavior change conflicts with protected base-test expectations
under the current product policy.** In each case, upstream Fastify changed the same visible test
in the fix commit:

| Task | Upstream fix | Existing test that contradicts the fix |
|---|---|---|
| FY-04 | 2ae3e1d7 (#6523) | `test/internals/errors.test.js` › "should expose 88 errors" (and three docs/types consistency tests, see KAN-70) |
| FY-06 | 7299a57d (#6845) | `test/reply-trailers.test.js` › "remove all trailers" |
| FY-11 | 29bdcbb9 (#6865) | `test/content-type.test.js` › "skips invalid quoted string parameters" |
| FY-12 | 6f63ce93 (#6830) | `test/internals/reply.test.js` › "non-string with custom json's content-type…" |

QB protects existing tests: verify-prep restores protected base tests before the candidate's
tests run. A correct patch for these tasks therefore always shows the old test failing, and QB
reports it as a **regression**. Its repair hint then asks the agent to make the old test pass,
which means undoing the required behaviour.

This is a **product limitation discovered after observing results**, not an invalid task and not
a demonstrated improvement. Rewording the prompt (option b) would not help: verify-prep restores
protected tests, and a prompt must not promise a permission the product does not grant. The real
fix, narrowly scoped and human-approved test updates, is a separate design card (option c).

## Diagnostic group: the four compatibility cases

FY-04, FY-06, FY-11 and FY-12 stay frozen at version 2. They are replayed in their own
diagnostic group, and their actual results are kept as they are: each reference ends in `fail`
after 2 attempts with the protected-test regression, and its repair behaviour is recorded. They
are never turned into `pass`. Removing them from the supported plan is **not** an improvement in
performance and must never be reported as one.

FY-04 has a further, separate problem: its reference omits the upstream documentation and type
updates that Fastify's own consistency tests check. That is a reference-completeness issue
(KAN-70). A claim that FY-04's reference is fully correct needs those updates and a disclosed,
re-qualified revision; a hidden-suite pass alone is not enough.

## FY-08: the base failed one of its own tests (found by the v2 replays; corrected in v3)

In version 2, every FY-08 replay, including the unchanged base, ended in `fail` with
`preexisting_failures_not_waived`. Fastify v5.12.0 itself fails `test/internals/reply.test.js`
› "Once called, Reply should return an object with methods". 430dd4ed made `reply.mediaType`
return `undefined` without a content type, and the test still expected a string. Upstream fixed
the test after the release (65d12da9, "test: fix reply.mediaType (#6949)").

Qualification only ran the hidden suite, so it did not catch this. In the original screen,
FY-08's E arm was internally `fail` while the hidden grade was `pass`; the lint failures that
v2 removed hid the cause.

The correction is a benchmark-environment correction, like the neostandard rebuild: the same
task ID, a disclosed new version, nothing a candidate sees or is graded on changes.
- FY-08 version 3 (disclosed, `after_viewing_results: true`) runs on
  `qb-bench:fastify-5.12.0-t6949`: v5.12.0 plus upstream's one-line test fix
  (`upstream_commits` in `bench/repos/repos.json`). Prompt, oracle, reference, incorrect
  implementations, hidden suite and lockfile are unchanged.
- Qualification (`bench/qualify.js`) now also requires the unchanged base to pass the
  repository's own tests. Run against FY-08's version 2 base in the sandbox, it refuses it and
  names that test. FY-08 v3 passed it and was re-qualified and frozen.
- **For the owner to confirm:** this was treated as an environment correction, not a
  replacement task. If it should count as a replacement, FY-08 needs a new task ID instead.

## Negative controls

Every incorrect implementation of an included task is rejected by the **independent hidden
suite** (qualification: `fail`, `tests_failed`, for all 20). QB's internal verifier does not
detect most of them, and is not claimed to:

- **4 of 20** end in `fail`, with real regressions in the repository's visible tests: FY-01
  second-segment, FY-02 trust-every-hop, FY-03 ip-heuristic and FY-09 never-unwrap-value.
- **16 of 20** end in `partial`: the visible tests pass and the behavioural checks stay
  unresolved. Only the hidden suite separates them from the reference.

None reaches `pass`. Hidden tests are never given to the repair loop.

## Original results, setup failures and reruns

All are kept as recorded; nothing is rewritten.
- **Original screen:** GitHub run 38409518314, 14 tasks × arms A/E × 2.
- **Setup failures:** 8 trials (FY-07 and FY-14, 4 per arm) were agent crashes of about one
  second with an empty patch (likely a usage limit, unconfirmed). They were first graded as
  fails. Harness fix 7443bd0 now counts an agent failure as attrition, not a fail.
- **Reruns:** GitHub run 38459455639 reran those 8 trials. In each arm, 4 of 4 passed the hidden
  checks.

## Addressable versions

| What | Where |
|---|---|
| v1 specs and lock (the original screen) | commit 6e0e0de: `bench/screen/specs/`, `bench/screen/specs.lock.json`, `bench/pilot/screen.json` |
| v2 specs (neostandard rebuild) | commit 8cfb159 |
| FY-08 v3 and the base self-test in qualification | commit 2a8d972 |
| Original run artifacts | runs 38409518314 and 38459455639: the trial shards expire 2026-11-12 and the merged experiments 2027-01-11 |

## Reporting rule

Any result on this screen states, next to the numbers:
"14 tasks considered, 10 included, 4 excluded (existing tests contradict the required change;
decided after observing results)". Both arms use the same 10 tasks.

## Evidence

- No-model replays through QB's real pipeline in Docker, with fixed patches (base, reference and
  each incorrect implementation, for every task):
  - tool: `scripts/kan65-replay.js`;
  - CI: `.github/workflows/kan65-replay.yml`, one job per task, records uploaded as artifacts;
  - exact-commit runs: 38686485340 at f21d18e (all 14, FY-08 at v2) and 38767929870 at 2a8d972
    (all 14, FY-08 at v3). Each matches the local replays at the same code line for line (56 of 56).
