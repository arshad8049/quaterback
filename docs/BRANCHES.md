# Branches

## Policy
- **`main` is the only long-lived branch.** The live site deploys from it (Cloudflare).
- **One branch per card,** named `kanNN-short-topic` (for example `kan71-dev-requalify`). A
  branch that depends on another unmerged branch is reviewed as a dependent PR. It is merged
  only after the branch it depends on.
- **Branches reach main through a pull request with a merge commit.** A branch under review
  is never rebased or force-pushed. Jira evidence and exact-commit CI runs cite its SHAs, and
  rewriting the history would leave them pointing at commits that are no longer on any branch.
- **Delete a branch once its PR merges.** GitHub's "Automatically delete head branches"
  setting does this for you.
- **`gh-pages`** is the generated preview site
  (https://arshad8049.github.io/quaterback/, noindex). It is never merged into main.

## Open branches (2026-10-16)
| Branch | Card | Base | Merge when |
|---|---|---|---|
| `qb30-gh-runner` | KAN-65 (also holds Phase 4, QB-28/29/30) | main | KAN-65 is accepted and the full 37-commit diff has been reviewed |
| `kan71-dev-requalify` | KAN-71 | `qb30-gh-runner` | KAN-71 is accepted, after `qb30-gh-runner` |
| `qb31-runner-preflight` | QB-31 fix | main | the fix is reviewed |
| `site-progress-2026-10-14` | KAN-67 | main | the senior signs off and the owner approves |
| `repo-branch-policy` | this file | main | any time |

## Archive
The branch clean-up of 2026-10-16 deleted 17 GitHub branches:
- 14 already merged into main;
- `phase-4-evaluation`, which is contained in `qb30-gh-runner` and tagged
  `archive/phase-4-evaluation`;
- `qb31-walkthrough-accepted`, which is contained in `qb31-runner-preflight`;
- `hero-run-local`, a local test merge, archived.

The owner keeps a bundle of every ref, an inventory of each branch with its full SHA, and the
draft classifications in two copies outside the repository
(`quaterback-archive-2026-10-16`). The restore was tested: all 66 refs match.
