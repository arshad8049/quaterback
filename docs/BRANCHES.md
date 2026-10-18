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

## Open branches (2026-10-18)
| Branch | Card | Base | Merge when |
|---|---|---|---|
| `qb30-gh-runner` | KAN-65, accepted (also holds Phase 4, QB-27 to QB-30) | main | the senior has reviewed the full 37-commit PR, including the commits no card accepted (73d3405, 0fa061b, the pilot and reproduce workflows). Integration on a trial merge with main is green ([run 39006256145](https://github.com/arshad8049/quaterback/actions/runs/39006256145)) |
| `kan71-dev-requalify` | KAN-71, reviewed; dev-r2 frozen at 22be7d0 | `qb30-gh-runner` | after `qb30-gh-runner` |
| `site-progress-2026-10-14` | KAN-67 | main | the senior signs off and the owner approves |
| `docs-bench-refresh` | bench docs brought up to date | `kan71-dev-requalify` (with `docs-refresh` merged in) | after `kan71-dev-requalify` |
| `trial-merge-qb30-main` | KAN-65 pre-merge check only | `qb30-gh-runner` + main | never; delete after the review |

Merged and ready to delete: `qb31-runner-preflight` (PR #16), `repo-branch-policy` (PR #15) and `docs-refresh`.

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
