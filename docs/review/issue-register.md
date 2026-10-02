# Issue register — Engineering Review v1.0

Source: `devudu_docs/Quarterback_Engineering_Review_and_Product_Roadmap.pdf`
(reviewed snapshot `4ecc6a7`, 1 Oct 2026). The review itself is the baseline; this file tracks status.

Work branch: `phase-0-1-hardening`. Rule: a failing regression test lands before each fix.
Status: `open` · `in-progress` · `fixed (awaiting review)` · `closed` (senior sign-off recorded).

| ID | Finding | Priority | Phase | Status | Regression test |
|---|---|---|---|---|---|
| QB-01 | Repository filenames can execute shell commands | Critical | 1 | fixed (awaiting review) | `test/unit/qb01-shell-injection.test.js` |
| QB-02 | Agent execution has no enforced containment | High | 1 | open | |
| QB-03 | Change capture omits parts of the actual result | High | 1 | open | |
| QB-04 | Model output can overwrite trusted metadata | High | 1 | open | |
| QB-05 | Benchmark reset is destructive and not reproducible | High | 1 | open | |
| QB-06 | Test-command failure can still produce PASS | Critical | 2 | open (seeded) | `test/unit/phase2-seeds.test.js` |
| QB-07 | Loose response parsing reverses negative judgments | Critical | 2 | open (seeded) | `test/unit/phase2-seeds.test.js` |
| QB-08 | An empty or clarification-only contract can pass | Critical | 2 | open (seeded) | `test/unit/phase2-seeds.test.js` |
| QB-09 | Scope and constraints are not enforced as policy | High | 2 | open | |
| QB-10 | Failure routing loses test failures and repair actions | High | 2 | open | |
| QB-11 | Judge evidence is incomplete and lacks provenance | High | 2 | open | |
| QB-12 | Keyword signals claim facts that were not established | Medium | 2 | open | |
| QB-13 | L1 generates mathematically incorrect specifications | Critical | 2 | open | |
| QB-14 | The AC checklist omits the essential requested behavior | High | 2 | open | |
| QB-15 | Voting and preservation rules are not calibrated | High | 2 | open | |
| QB-16 | Verification plans are prose rather than executable checks | High | 2 | open | |
| QB-17 | Intent is finalized before repository grounding | High | 2 | open | |
| QB-18 | Context selection and graph depth do not match the claims | Medium | 3 | open | |
| QB-19 | Symbol extraction silently drops valid exports | Medium | 3 | open | |
| QB-20 | Test discovery is mistaken for test coverage | Medium | 3 | open | |
| QB-21 | Deadlines, cancellation, and cost budgets are incomplete | High | 3 | open | |
| QB-22 | Execution errors are conflated with dry-run or no change | High | 1 | open | |
| QB-23 | Successful repairs never reach normal memory persistence | High | 3 | open | |
| QB-24 | Memory can mix repositories and opposite instructions | Medium | 3 | open | |
| QB-25 | Memory persistence lacks safe lifecycle and concurrency | Medium | 3 | open | |
| QB-26 | The project has no effective root regression gate | High | 0 | fixed (awaiting review) | `npm test`, `.github/workflows/ci.yml` |
| QB-27 | The benchmark lets QB define its own scoring target | Critical | 4 | open | |
| QB-28 | Baseline resources and verification paths are unequal | High | 4 | open | |
| QB-29 | Latest-per-task aggregation mixes experiments | High | 4 | open | |
| QB-30 | Six tuned utility tasks do not establish effectiveness | High | 4 | open | |
| QB-31 | Supported adapters and onboarding are not productized | Medium | 5 | open | |
| QB-32 | Telemetry and privacy descriptions overstate anonymity | High | 5 | open | |
| QB-33 | Metrics can be forged with a known registration email | High | 5 | open | |
| QB-34 | Admin exports expose avoidable credential and CSV risks | High | 5 | open | |
| QB-35 | Signup input, delivery, and abuse handling are fragile | High | 5 | open | |
| QB-36 | Legacy proxy permits unauthenticated paid upstream calls | Critical* | 1 | open | |
| QB-37 | Deployment and public claims have drifted | High | 5 | open | |
| QB-38 | Runs lack a durable, versioned evidence record | High | 0 | fixed (awaiting review) | `test/unit/run-store.test.js`, `test/unit/qb-cli.test.js` |

\* Critical only if the legacy proxy is deployed.

## Closure log

Use the review's closure template (p.33) for each ticket:

- **Implementation:** issue ID, owner, commit, affected files, migration/compatibility notes.
- **Evidence:** failing pre-fix reproduction, passing regression, CI run, real integration evidence where relevant, docs updated.
- **Review:** senior sign-off for safety/acceptance policy, remaining limitations, closure date.

<!-- entries appended below as tickets land -->
