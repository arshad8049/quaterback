# Issue register — Engineering Review v1.0

Source: `devudu_docs/Quarterback_Engineering_Review_and_Product_Roadmap.pdf`
(reviewed snapshot `4ecc6a7`, 1 Oct 2026). The review itself is the baseline; this file tracks status.

Work branch: `phase-0-1-hardening`. Rule: a failing regression test lands before each fix.
Status (same workflow as Jira, see `jira/workflow.md`): `To Do` · `In Progress` · `In Review` (fixed, awaiting senior sign-off) · `Sent Back` (post-review changes requested or reopened) · `Accepted` (post-review sign-off recorded).

**Tracking is moving to Jira.** Migration payloads are in `jira/migration.json`, with status as of 2026-10-02. After migration, Jira is authoritative for status. This file keeps the review baseline and the closure log.

| ID | Finding | Priority | Phase | Status | Regression test |
|---|---|---|---|---|---|
| QB-01 | Repository filenames can execute shell commands | Critical | 1 | In Review | `test/unit/qb01-shell-injection.test.js` |
| QB-02 | Agent execution has no enforced containment | High | 1 | In Progress: v3.1 approved as working design (E1–E4 + implementation pending; v1 rejected, v2 changes requested) | `docs/security/agent-sandbox.md`, `test/unit/qb02-no-agent-override.test.js` |
| QB-03 | Change capture omits parts of the actual result | High | 1 | Sent Back: reopened, host git reads agent-written config (fsmonitor/filter execute); fix in QB-02 §6, blocked by QB-02 | `test/unit/qb03-qb22-capture-and-states.test.js`, `test/unit/hostile-tree-seeds.test.js` (KNOWN DEFECT reproductions; regressions todo) |
| QB-04 | Model output can overwrite trusted metadata | High | 1 | In Review | `test/unit/qb04-trusted-metadata.test.js` |
| QB-05 | Benchmark reset is destructive and not reproducible | High | 1 | In Review | `test/unit/qb05-bench-workspace.test.js` |
| QB-06 | Test-command failure can still produce PASS | Critical | 2 | To Do | `test/unit/phase2-seeds.test.js` |
| QB-07 | Loose response parsing reverses negative judgments | Critical | 2 | To Do | `test/unit/phase2-seeds.test.js` |
| QB-08 | An empty or clarification-only contract can pass | Critical | 2 | To Do | `test/unit/phase2-seeds.test.js` |
| QB-09 | Scope and constraints are not enforced as policy | High | 2 | To Do | |
| QB-10 | Failure routing loses test failures and repair actions | High | 2 | To Do | |
| QB-11 | Judge evidence is incomplete and lacks provenance | High | 2 | To Do | |
| QB-12 | Keyword signals claim facts that were not established | Medium | 2 | To Do | |
| QB-13 | L1 generates mathematically incorrect specifications | Critical | 2 | To Do | |
| QB-14 | The AC checklist omits the essential requested behavior | High | 2 | To Do | |
| QB-15 | Voting and preservation rules are not calibrated | High | 2 | To Do | |
| QB-16 | Verification plans are prose rather than executable checks | High | 2 | To Do | |
| QB-17 | Intent is finalized before repository grounding | High | 2 | To Do | |
| QB-18 | Context selection and graph depth do not match the claims | Medium | 3 | To Do | |
| QB-19 | Symbol extraction silently drops valid exports | Medium | 3 | To Do | |
| QB-20 | Test discovery is mistaken for test coverage | Medium | 3 | To Do | |
| QB-21 | Deadlines, cancellation, and cost budgets are incomplete | High | 3 | To Do | |
| QB-22 | Execution errors are conflated with dry-run or no change | High | 1 | In Review: no_change→VERIFIED needs Phase 2 check | `test/unit/qb03-qb22-capture-and-states.test.js` |
| QB-23 | Successful repairs never reach normal memory persistence | High | 3 | To Do | |
| QB-24 | Memory can mix repositories and opposite instructions | Medium | 3 | To Do | |
| QB-25 | Memory persistence lacks safe lifecycle and concurrency | Medium | 3 | To Do | |
| QB-26 | The project has no effective root regression gate | High | 0 | In Review | `npm test`, `.github/workflows/ci.yml` |
| QB-27 | The benchmark lets QB define its own scoring target | Critical | 4 | To Do | |
| QB-28 | Baseline resources and verification paths are unequal | High | 4 | To Do | |
| QB-29 | Latest-per-task aggregation mixes experiments | High | 4 | To Do | |
| QB-30 | Six tuned utility tasks do not establish effectiveness | High | 4 | To Do | |
| QB-31 | Supported adapters and onboarding are not productized | Medium | 5 | To Do | |
| QB-32 | Telemetry and privacy descriptions overstate anonymity | High | 5 | To Do | |
| QB-33 | Metrics can be forged with a known registration email | High | 5 | To Do | |
| QB-34 | Admin exports expose avoidable credential and CSV risks | High | 5 | To Do | |
| QB-35 | Signup input, delivery, and abuse handling are fragile | High | 5 | To Do | |
| QB-36 | Legacy proxy permits unauthenticated paid upstream calls | Critical* | 1 | In Review: fixed in repo; confirm live Netlify route and env cleared | `test/unit/qb36-legacy-proxy.test.js` |
| QB-37 | Deployment and public claims have drifted | High | 5 | To Do | |
| QB-38 | Runs lack a durable, versioned evidence record | High | 0 | In Review | `test/unit/run-store.test.js`, `test/unit/qb-cli.test.js` |

\* Critical only if the legacy proxy is deployed.

## Closure log

Use the review's closure template (p.33) for each ticket:

- **Implementation:** issue ID, owner, commit, affected files, migration/compatibility notes.
- **Evidence:** failing pre-fix reproduction, passing regression, CI run, real integration evidence where relevant, docs updated.
- **Review:** senior sign-off for safety/acceptance policy, remaining limitations, closure date.

<!-- entries appended below as tickets land -->

### 2026-10-02 — QB-02 v1 review

Reviewer rejected v1 (API-key-only auth, unpinned proxy image, EOL Node base, unsafe escape hatch, host-side test execution, internal-network-only isolation, unbounded hostile-tree handling). v2 resubmitted with a point-by-point response (§0). While revising, reproduced host code execution via agent-written `core.fsmonitor` and clean filters during capture → QB-03 reopened; seeds in `test/unit/hostile-tree-seeds.test.js`. Landed code still runs repository tests on the host (`verify/checker.js`) and the agent in the user checkout (`qb.js`): **trusted repositories only** until QB-02 is implemented.

### 2026-10-02: QB-02 v2 and v3 reviews

v2: changes requested; implementation spikes approved (`docs/security/reviews/agent-sandbox-v2-review.md`). v3: approved as the working design for experiments E1–E4 and incremental implementation, with eight targeted corrections applied in v3.1 (`4370778`; review in `docs/security/reviews/agent-sandbox-v3-review.md`). Landed alongside it: the uncontained-execution warning and removal of the production `QB_AGENT_COMMAND` override (`140020a`), and executable KNOWN DEFECT reproductions of the two QB-03 host-capture attacks (`5107056`). QB-02 is not complete. The sandbox must not ship until E1–E4 and §11.2 pass.
