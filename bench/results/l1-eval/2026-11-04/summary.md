# L1 live eval (KAN-106)

- host: {"platform":"darwin","arch":"arm64","cpus":11,"mem_gib":18,"node":"v20.20.2"}
- models: ["deepseek-r1:7b (0a8c26691023)","qwen2.5-coder:14b (9ec8897f747e)"]
- commits: ["d946ff3","ab835c7"]

| model | trials | usable | finalized | 1st draft | after corr. | asked | blocked: syntax | blocked: validation | timeout/error | proxy failed | calls/trial | s/trial |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek-r1:7b | 30 | 2 (6.7%) | 3 | 1 | 2 | 0 | 3 | 23 | 1 | 1 | 1.97 | 99 |
| qwen2.5-coder:14b | 30 | 12 (40%) | 12 | 8 | 4 | 0 | 0 | 15 | 3 | 0 | 1.73 | 161 |

`usable` = finalized and every expected check present (a proxy, not proof of correctness).

## deepseek-r1:7b

First-draft failures: 4 not JSON, 25 rejected by the validator.

| task | trials | finalized | usable |
|---|---|---|---|
| greeting | 5 | 0 | 0 |
| cart | 5 | 0 | 0 |
| clamp | 5 | 0 | 0 |
| duration | 5 | 1 | 0 |
| slugify | 5 | 2 | 2 |
| port | 5 | 0 | 0 |

Validator errors by category (all rejected drafts): scope_policy 36, quote_not_verbatim 31, request_untraced 18, requirement_uncovered 9, criterion_untraced 7, syntax 7, schema_incomplete 4, default_uncovered_or_new 1

## qwen2.5-coder:14b

First-draft failures: 0 not JSON, 22 rejected by the validator.

| task | trials | finalized | usable |
|---|---|---|---|
| greeting | 5 | 3 | 3 |
| cart | 5 | 0 | 0 |
| clamp | 5 | 5 | 5 |
| duration | 5 | 0 | 0 |
| slugify | 5 | 4 | 4 |
| port | 5 | 0 | 0 |

Validator errors by category (all rejected drafts): request_untraced 78, quote_not_verbatim 24, criterion_duplicate 10, scope_policy 2, requirement_uncovered 1

