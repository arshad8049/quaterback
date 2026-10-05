# Issue register — Engineering Review v1.0

Source: `devudu_docs/Quarterback_Engineering_Review_and_Product_Roadmap.pdf`
(reviewed snapshot `4ecc6a7`, 1 Oct 2026). The review itself is the baseline; this file tracks status.

Work branches: Phases 0–2 are merged into `main` (tag `phase-0-2-accepted`); Phase 3 is on `phase-3-context-memory`. Rule: a failing regression test lands before each fix.
Status (same workflow as Jira, see `jira/workflow.md`): `To Do` · `In Progress` · `In Review` (fixed, awaiting senior sign-off) · `Sent Back` (post-review changes requested or reopened) · `Accepted` (post-review sign-off recorded).

**Tracked in Jira since 2026-10-02:** project **QB** (key `KAN`) at https://arshadahmedsworkspace-40204141.atlassian.net/jira/software/projects/KAN. `QB-NN` = `KAN-NN`; phase epics are KAN-39 (Phase 0) to KAN-44 (Phase 5). **Jira is authoritative for status.** This file keeps the review baseline and the closure log; the status column is a snapshot, last refreshed 2026-10-03 (end of day).

| ID | Jira | Finding | Priority | Phase | Status | Regression test |
|---|---|---|---|---|---|---|
| QB-01 | [KAN-1](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-1) | Repository filenames can execute shell commands | Critical | 1 | Accepted | `test/unit/qb01-shell-injection.test.js` |
| QB-02 | [KAN-2](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-2) | Agent execution has no enforced containment | High | 1 | Accepted (sandbox implemented; Linux CI green) | `docs/security/agent-sandbox.md`, `test/integration/qb02-sandbox-*.test.js`, `test/daemon/` |
| QB-03 | [KAN-3](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-3) | Change capture omits parts of the actual result | High | 1 | Accepted | `test/integration/qb02-sandbox-capture.test.js`, `test/unit/hostile-tree-seeds.test.js` |
| QB-04 | [KAN-4](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-4) | Model output can overwrite trusted metadata | High | 1 | Accepted | `test/unit/qb04-trusted-metadata.test.js` |
| QB-05 | [KAN-5](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-5) | Benchmark reset is destructive and not reproducible | High | 1 | Accepted | `test/unit/qb05-bench-workspace.test.js` |
| QB-06 | [KAN-6](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-6) | Test-command failure can still produce PASS | Critical | 2 | Accepted | `test/unit/qb06-test-evidence.test.js`, `test/fixtures/node-test-reports/`, `phase2-seeds` Recipe C |
| QB-07 | [KAN-7](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-7) | Loose response parsing reverses negative judgments | Critical | 2 | Accepted | `test/unit/qb07-judge-parsing.test.js`, `phase2-seeds` Recipe B |
| QB-08 | [KAN-8](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-8) | An empty or clarification-only contract can pass | Critical | 2 | Accepted | `test/unit/qb08-contract-gate.test.js`, `phase2-seeds` Recipe A |
| QB-09 | [KAN-9](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-9) | Scope and constraints are not enforced as policy | High | 2 | To Do | |
| QB-10 | [KAN-10](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-10) | Failure routing loses test failures and repair actions | High | 2 | To Do | |
| QB-11 | [KAN-11](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-11) | Judge evidence is incomplete and lacks provenance | High | 2 | To Do | |
| QB-12 | [KAN-12](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-12) | Keyword signals claim facts that were not established | Medium | 2 | To Do | |
| QB-13 | [KAN-13](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-13) | L1 generates mathematically incorrect specifications | Critical | 2 | To Do | |
| QB-14 | [KAN-14](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-14) | The AC checklist omits the essential requested behavior | High | 2 | To Do | |
| QB-15 | [KAN-15](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-15) | Voting and preservation rules are not calibrated | High | 2 | To Do | |
| QB-16 | [KAN-16](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-16) | Verification plans are prose rather than executable checks | High | 2 | In Review (`549cc17`) | `test/unit/qb16-executable-checks.test.js`, `docs/verify/executable-checks.md` |
| QB-17 | [KAN-17](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-17) | Intent is finalized before repository grounding | High | 2 | To Do | |
| QB-18 | [KAN-18](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-18) | Context selection and graph depth do not match the claims | Medium | 3 | To Do | |
| QB-19 | [KAN-19](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-19) | Symbol extraction silently drops valid exports | Medium | 3 | To Do | |
| QB-20 | [KAN-20](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-20) | Test discovery is mistaken for test coverage | Medium | 3 | To Do | |
| QB-21 | [KAN-21](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-21) | Deadlines, cancellation, and cost budgets are incomplete | High | 3 | To Do | |
| QB-22 | [KAN-22](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-22) | Execution errors are conflated with dry-run or no change | High | 1 | In Review (`a4641b5`, 3rd submission) | `test/unit/qb22-already-satisfied.test.js`, `test/unit/qb03-qb22-capture-and-states.test.js` |
| QB-23 | [KAN-23](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-23) | Successful repairs never reach normal memory persistence | High | 3 | To Do | |
| QB-24 | [KAN-24](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-24) | Memory can mix repositories and opposite instructions | Medium | 3 | To Do | |
| QB-25 | [KAN-25](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-25) | Memory persistence lacks safe lifecycle and concurrency | Medium | 3 | To Do | |
| QB-26 | [KAN-26](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-26) | The project has no effective root regression gate | High | 0 | Accepted | `npm test`, `.github/workflows/ci.yml` (Node 20/22/24), `scripts/ci-evidence.js` |
| QB-27 | [KAN-27](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-27) | The benchmark lets QB define its own scoring target | Critical | 4 | To Do | |
| QB-28 | [KAN-28](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-28) | Baseline resources and verification paths are unequal | High | 4 | To Do | |
| QB-29 | [KAN-29](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-29) | Latest-per-task aggregation mixes experiments | High | 4 | To Do | |
| QB-30 | [KAN-30](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-30) | Six tuned utility tasks do not establish effectiveness | High | 4 | To Do | |
| QB-31 | [KAN-31](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-31) | Supported adapters and onboarding are not productized | Medium | 5 | To Do | |
| QB-32 | [KAN-32](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-32) | Telemetry and privacy descriptions overstate anonymity | High | 5 | To Do | |
| QB-33 | [KAN-33](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-33) | Metrics can be forged with a known registration email | High | 5 | To Do | |
| QB-34 | [KAN-34](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-34) | Admin exports expose avoidable credential and CSV risks | High | 5 | To Do | |
| QB-35 | [KAN-35](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-35) | Signup input, delivery, and abuse handling are fragile | High | 5 | To Do | |
| QB-36 | [KAN-36](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-36) | Legacy proxy permits unauthenticated paid upstream calls | Critical* | 1 | Pending (repo fix done; the retired Netlify site is left running by owner decision 2026-10-03) | `test/unit/qb36-legacy-proxy.test.js` |
| QB-37 | [KAN-37](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-37) | Deployment and public claims have drifted | High | 5 | To Do | |
| QB-38 | [KAN-38](https://arshadahmedsworkspace-40204141.atlassian.net/browse/KAN-38) | Runs lack a durable, versioned evidence record | High | 0 | Accepted | `test/unit/run-store.test.js`, `test/unit/qb-cli.test.js` |

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

### 2026-10-03 — Phase 0–1 review round, Phase 2 started

**Accepted by the senior reviewer:**
- **QB-01, 02, 03, 04, 05, 26, 38** (Phase 0–1).
- **QB-06, 07, 08** (Phase 2). These were started ahead of the Phase 1 gate, because the remaining Phase 1 items were waiting on review, ops or decisions rather than code.

Highlights, each with a failing pre-fix reproduction and a passing regression:
- **QB-02:** CI found two Linux-only defects:
  - `node --test <dir>` loaded nothing on Node 22.23;
  - seed couldn't read 0700 checkouts (now read as the host uid).
  - The T-LIFE variants found two more: CLI waits used the wall clock, and an unanswered Docker was read as "nothing running" (G5c).
- **QB-06:** test evidence is a complete, validated machine-readable report, written by QB's node:test reporter. Console output decides nothing; cancelled, incomplete and contradictory reports can't pass.
- **QB-07:** a strict judgment schema; the keyword fallback is deleted.
- **QB-08:** only a finalized contract reaches the agent or verification. The compiler no longer invents criteria or drops real questions.
- **QB-26:** a Node 20/22/24 matrix, plus a per-job evidence record. Failing tests are published as public annotations.
- **QB-38:** replay checks the final outcome; the record carries base, agent version and structured checks.

**In review:**
- **QB-16:** executable checks. Registry `qb-checks/1`, sandbox stage ⑥; behavioural ACs need executed checks.
- **QB-22:** a no-change run passes only on independent evidence from the same tested tree. Sent back twice: the live checkout was read, then newline paths could be split. Both fixed.

**Pending: QB-36.** The repository fix is done. The retired Netlify site is left running by owner decision. The live site is Cloudflare only: https://quaterback.velorallc.workers.dev/.

**Seeded TODOs:** all three Phase 2 false-PASS recipes are now real tests, so no seeded TODOs remain. That is a statement about the seeded list, not a claim that all defects are fixed.

