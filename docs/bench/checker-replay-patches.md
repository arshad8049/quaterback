# Checker replay: every patch (KAN-75)

One row per patch of the frozen dev-r2 set, 128 in all, from [run 39172392965](https://github.com/arshad8049/quaterback/actions/runs/39172392965) (QB 2aeb2a6).
- **Source:** each row is that run's own per-patch annotation (`<ID> <patch>: final <verdict> after <n> attempt(s) | …`), one per replay job.
- **Summary:** the corrected summary of the same 128 records is [run 40057636081](https://github.com/arshad8049/quaterback/actions/runs/40057636081) (`kan75-reprocess`, see checker-replay.md). It agrees with every count here.
- **Truth** is the benchmark's label from the hidden suite, not QB's judgement.
- **Why** is QB's first-attempt evidence, condensed: the test outcome and, for a regression, the first failing visible test.

| task | patch | group | truth | final verdict | attempts | why |
|---|---|---|---|---|---|---|
| AV-01 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-01 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-01 | incorrect:drop-label | incorrect | wrong | PARTIAL | 1 | visible tests timed out (routed as environment) |
| AV-01 | incorrect:shift-first | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-02 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-02 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-02 | incorrect:boot-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-02 | incorrect:one-level | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-03 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-03 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-03 | incorrect:function-name-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-03 | incorrect:top-level-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-04 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-04 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-04 | incorrect:deferred-error | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-04 | incorrect:generic-error | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-05 | base | base (already satisfied) | correct | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-05 | incorrect:accept-arrays | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-05 | incorrect:typeof-only | incorrect | wrong | FAIL | 2 | visible-test regression: test/lib/validate-plugin.test.js › validatePlugin |
| AV-06 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| AV-06 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-06 | incorrect:arrow-copy-kept | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-06 | incorrect:copy-kept | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-06 | incorrect:default-export | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| AV-06 | incorrect:drops-branch-marker | incorrect | wrong | PARTIAL | 1 | visible tests timed out (routed as environment) |
| FJ-01 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-01 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-01 | incorrect:reset-mechanism-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-01 | incorrect:reset-size-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-02 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-02 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-02 | incorrect:date-time-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-02 | incorrect:empty-string | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-03 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-03 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-03 | incorrect:finite-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-03 | incorrect:seconds | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-03 | incorrect:unguarded | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-03 | incorrect:unquoted | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-04 | base | base (already satisfied) | correct | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-04 | incorrect:reject-bigint | incorrect | wrong | FAIL | 2 | visible-test regression: test/bigint.test.js › render a bigint as JSON |
| FJ-04 | incorrect:via-number | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-05 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-05 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-05 | incorrect:number-coercion | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-05 | incorrect:strings-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-05 | incorrect:truthy-guard | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-06 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FJ-06 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-06 | incorrect:negatives-round | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-06 | incorrect:plain-round | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FJ-06 | incorrect:serializer-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-01 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FP-01 | reference | reference | correct | FAIL | 2 | visible-test regression: test/test.js › Should accept an option object |
| FP-01 | incorrect:copy-on-autoname | incorrect | wrong | FAIL | 2 | visible-test regression: test/test.js › Should accept an option object |
| FP-01 | incorrect:delete-after | incorrect | wrong | FAIL | 2 | visible-test regression: test/composite.test.js › anonymous function should be named composite.test0 |
| FP-02 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FP-02 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-02 | incorrect:dash-runs-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-02 | incorrect:lowercase-rest | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-03 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FP-03 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-03 | incorrect:coerce | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-03 | incorrect:truthy-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-04 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| FP-04 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-04 | incorrect:live-object | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-04 | incorrect:unguarded | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| FP-05 | base | base (already satisfied) | correct | UNRESOLVED | 1 | no change; criteria not independently verified |
| FP-05 | incorrect:reject-strings | incorrect | wrong | FAIL | 2 | visible-test regression: test/test.js › should check the fastify version |
| FP-05 | incorrect:string-as-name | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-01 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-01 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-01 | incorrect:string-not-json | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-01 | incorrect:zero-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-02 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-02 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-02 | incorrect:delete-existing | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-02 | incorrect:empty-string | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-02 | incorrect:top-level-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-03 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-03 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-03 | incorrect:remote-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-03 | incorrect:unguarded | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-04 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-04 | reference | reference | correct | FAIL | 2 | visible-test regression: test/index.test.js › correctly handles no string headers |
| LM-04 | incorrect:drop-null | incorrect | wrong | FAIL | 2 | visible-test regression: test/index.test.js › correctly handles no string headers |
| LM-04 | incorrect:other-wording | incorrect | wrong | FAIL | 2 | visible-test regression: test/index.test.js › correctly handles no string headers |
| LM-05 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-05 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-05 | incorrect:copy-kept | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-05 | incorrect:default-export | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-05 | incorrect:reworded-error | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-06 | base | base (already satisfied) | correct | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-06 | incorrect:cookies-first | incorrect | wrong | FAIL | 2 | visible-test regression: test/index.test.js › send cookie with header already set |
| LM-06 | incorrect:overwrite | incorrect | wrong | FAIL | 2 | visible-test regression: test/index.test.js › send cookie with header already set |
| LM-07 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| LM-07 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-07 | incorrect:headers-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| LM-07 | incorrect:mutating-merge | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-01 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-01 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-01 | incorrect:arguments-length | incorrect | wrong | FAIL | 2 | visible-test regression: test/emit-interpolated-string.test.js › emit with interpolated string |
| PW-01 | incorrect:first-arg-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-01 | incorrect:null-excluded | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-02 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-02 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-02 | incorrect:always-three | incorrect | wrong | FAIL | 2 | visible-test regression: test/spy-warning.test.js › Spy ProcessWarning - unlimited: false |
| PW-02 | incorrect:filter-undefined | incorrect | wrong | FAIL | 2 | visible-test regression: test/spy-warning.test.js › Spy ProcessWarning - calls[].arguments |
| PW-02 | incorrect:null-dropped | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-03 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-03 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-03 | incorrect:code-only | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-03 | incorrect:coerce | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-03 | incorrect:truthy-first | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-03 | incorrect:typeerror-wording | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-04 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-04 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-04 | incorrect:duck-typing | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-04 | incorrect:throws-on-null | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-04 | incorrect:truthy-not-boolean | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-05 | base | base (already satisfied) | correct | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-05 | incorrect:always-emit | incorrect | wrong | FAIL | 2 | visible-test regression: test/emit-interpolated-string.test.js › emit with interpolated string |
| PW-05 | incorrect:closure-flag | incorrect | wrong | FAIL | 2 | visible-test regression: test/emit-reset.test.js › a limited warning can be re-set |
| PW-06 | base | base (unchanged, needs a change) | wrong | UNRESOLVED | 1 | no change; criteria not independently verified |
| PW-06 | reference | reference | correct | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-06 | incorrect:copy-kept | incorrect | wrong | PARTIAL | 1 | visible tests pass; criteria unchecked |
| PW-06 | incorrect:own-symbols | incorrect | wrong | FAIL | 2 | visible-test regression: test/spy-warning.test.js › Spy ProcessWarning - unlimited: false |
