# KAN-103 fixtures

Fixed model replies for the beta repro (run `911bbb8f-d420-4e5e-8228-e176f1b663cc`, QB `ca0f126`,
starter-node-js `e6fe8ee`, `deepseek-r1:7b` digest `0a8c2669…`). The run record kept only the
validator's errors, not the model's raw draft, so `bad-draft.json` is a reconstruction that produces
the same four errors: the "as integer" misquote (`asinteger`), the request left untraced, and the two
invented defaults (16-bit integers, an exact "Invalid input" message) cited by no criterion.

- `bad-draft.json`: the first draft (invalid).
- `corrected-draft.json`: a correction that traces all six parts of the request, with no defaults.
- `still-bad-draft.json`: a correction that is still invalid (the misquote is kept).
- `justified-defaults-draft.json`: a correction the validator alone would accept, because it adds
  criteria citing the invented defaults. QB must refuse it.
