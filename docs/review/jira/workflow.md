# Jira workflow and migration: Engineering Review v1.0 tickets

The issue register (`../issue-register.md`) moves to Jira. After migration, **Jira is the system of record for status**. The register keeps the review baseline and the closure log.

Migration payloads: [`migration.json`](migration.json). It holds 6 phase epics, 38 tasks and 4 issue links, each with a description taken from the review plus a dated "where it stands" section.

## Statuses

Five statuses, in board order. "Sent Back" and "Accepted" are the two possible outcomes of a review.

| Status | Category | Means | Enter when | Leave when |
|---|---|---|---|---|
| **To Do** | To Do | Accepted finding, no implementation started. A seeded failing reproduction may already exist. | Created from the review, or deprioritised back | Someone starts implementation → In Progress |
| **In Progress** | In Progress | Being designed or implemented. Includes design-review iterations that approved continuing (e.g. QB-02 spikes). | Work starts, or rework starts after Sent Back | A fix plus evidence is ready for senior review → In Review |
| **In Review** | In Progress | Fix landed on the work branch. The failing pre-fix reproduction and the passing regression are recorded. **Awaiting senior sign-off.** | Developer submits it with the closure-template evidence | Reviewer decides → Sent Back or Accepted |
| **Sent Back** | In Progress | **Post-review: changes requested**, or a reviewed fix was reopened because a defect was found. The ticket says what must change and links the review. | Reviewer requests changes, or a regression/defect reopens a reviewed fix | Developer resumes → In Progress |
| **Accepted** | Done | **Post-review: accepted.** Senior sign-off recorded with the closure template (commit, evidence, CI run, limitations, date). | Reviewer approves | Reopened by a later defect → Sent Back |

Rules:

- Nothing reaches **Accepted** without a recorded sign-off. A merged commit is not acceptance.
- Every move into **In Review**, **Sent Back** or **Accepted** gets a comment: what was reviewed (commit or doc version), the decision, and the next action.
- Transitions: To Do → In Progress → In Review → (Sent Back → In Progress → In Review)* → Accepted. Allow Accepted → Sent Back for reopens, and any status → To Do for deprioritisation.

## Field mapping

| Register / review | Jira |
|---|---|
| ID (QB-01 …) | Summary prefix `[QB-01]`, so the original ID survives whatever keys Jira assigns |
| Finding | Summary |
| Problem / Implement / Done when | Description sections. "Done when" is the acceptance criteria. |
| Priority: Critical / High / Medium | Highest / High / Medium. QB-36 ("Critical if deployed") is Highest, with label `critical-if-deployed`. |
| Phase 0–5 | Parent epic "Phase N – …", plus label `phase-N` |
| Effort S/M/L | Label `effort-S` / `effort-M` / `effort-L` |
| Evidence type | Label, e.g. `evidence-reproduced` |
| All review tickets | Label `eng-review-v1` |
| Status | Per the table above, with the dated explanation in the description |

## Current status at migration (2026-10-02)

| Status | Tickets |
|---|---|
| In Review | QB-01, QB-04, QB-05, QB-22 (partial: no_change→VERIFIED needs Phase 2), QB-26, QB-36 (live Netlify check outstanding), QB-38 |
| In Progress | QB-02 (v3.1 approved for experiments; E1–E4 and implementation pending) |
| Sent Back | QB-03 (reopened: host capture executes agent-written git config; blocked by QB-02) |
| To Do | QB-06 … QB-21, QB-23 … QB-25, QB-27 … QB-35, QB-37. QB-06/07/08 have seeded failing reproductions. |
| Accepted | none yet (no senior sign-off recorded) |

Epics: Phase 0 and Phase 1 are In Progress; Phases 2–5 are To Do.

## Setup (done once, by you, before migration)

1. **Connect Jira to Claude.** In claude.ai, open *Settings → Connectors* and add **Atlassian** (sign in and grant your Jira site), then restart this Claude Code session so the Jira tools load. Alternatively, run `/mcp` in Claude Code and add Atlassian's remote MCP server.
2. **Create the project.** Use a team-managed **Scrum** or **Kanban** project with key **`QB`**. Jira numbers issues itself (`QB-1`, not `QB-01`). If the project is new and empty, issues are created in register order, so **`QB-1` … `QB-38` will match `QB-01` … `QB-38`**, and the epics follow as `QB-39` … `QB-44`.
3. **Statuses.** In *Project settings → Workflow* (team-managed: *Board → ⋯ → Manage workflow*):
   - keep **To Do**, **In Progress**, **In Review**;
   - add **Sent Back** (category In Progress);
   - rename **Done** to **Accepted** (category Done);
   - add the transitions above;
   - paste each "Means" cell into the status description.

   Workflow editing needs project-admin rights and the Jira UI. The connector can create and transition issues, but it cannot create statuses.
4. Tell me the **site URL and project key**. I'll then create the tickets, epics and links, transition each ticket to its status, and add a migration comment to each, without changing any status definitions.

After migration I'll record the Jira keys back into the register and into `migration.json`.
