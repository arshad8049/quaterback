# L1 live eval (KAN-106)

- scored_with: tasks.json sha256 373ac6afd501 (qb-l1-eval-tasks/2)
- trials: 60

| run | trials | proxy pass | finalized | 1st draft | after corr. | asked | blocked: syntax | blocked: validation | timeout/error | finalized, proxy failed | calls/trial | s/trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-r1:7b | 30 | 2 (6.7%) | 3 | 1 | 2 | 0 | 3 | 23 | 1 | 1 | 1.97 | 99 |
| qwen2.5-coder:14b | 30 | 12 (40%) | 12 | 8 | 4 | 0 | 0 | 15 | 3 | 0 | 1.73 | 161 |

`proxy pass` = finalized and every expected check present (each matcher names the adapter, module, export and values or relation it requires). It is a proxy: it does NOT establish that a contract is complete or correct.

## deepseek-r1:7b

- model digest: 0a8c266910232fd3291e71e5ba1e058cc5af9d411192cf88b6d30e92b6e73163
- commits recorded: d946ff3
- run identity: not recorded in these rows (see PROVENANCE.md next to the data)

First-draft failures: 4 not JSON, 25 rejected by the validator.

| task | trials | finalized | proxy pass |
|---|---|---|---|
| greeting | 5 | 0 | 0 |
| cart | 5 | 0 | 0 |
| clamp | 5 | 0 | 0 |
| duration | 5 | 1 | 0 |
| slugify | 5 | 2 | 2 |
| port | 5 | 0 | 0 |

Validator errors by category (all rejected drafts): scope_policy 36, quote_not_verbatim 31, request_untraced 18, requirement_uncovered 9, criterion_untraced 7, syntax 7, schema_incomplete 4, default_uncovered_or_new 1

## qwen2.5-coder:14b

- model digest: 9ec8897f747e246e970bc5cfdda85d22f1123dc2e3d34978a010a75968716849
- commits recorded: ab835c7
- run identity: not recorded in these rows (see PROVENANCE.md next to the data)

First-draft failures: 0 not JSON, 22 rejected by the validator.

| task | trials | finalized | proxy pass |
|---|---|---|---|
| greeting | 5 | 3 | 3 |
| cart | 5 | 0 | 0 |
| clamp | 5 | 5 | 5 |
| duration | 5 | 0 | 0 |
| slugify | 5 | 4 | 4 |
| port | 5 | 0 | 0 |

Validator errors by category (all rejected drafts): request_untraced 78, quote_not_verbatim 24, criterion_duplicate 10, scope_policy 2, requirement_uncovered 1

