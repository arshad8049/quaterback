# Harder dev-task candidates (QB-30, 2026-10-12)

**Why.** The exploratory dev pilot (KAN-64, run 38307663205) found a ceiling effect. Arm A, the agent alone, passed 30/30 dev tasks, so the set cannot tell the arms apart. These candidates aim for tasks the agent alone does **not** reliably solve.

**Scope.** These are **dev** candidates, written on the QB side. They are never the holdout, which is authored independently (KAN-63). Picking tasks *because* arm A fails them is selection on the baseline, so results on these tasks are exploratory and never headline evidence.

## Source

**Repository:** `fastify/fastify` (MIT). Its tests use node:test, run through `borp`.

**Pool.** Real upstream bug fixes on the v5 line (v5.0.0 to v5.12.5), filtered to commits that:
- change library code (`lib/`, `fastify.js`) **and** `test/*.test.js`;
- change at most 120 library lines;
- are not docs or types only.

That gives 66 commits.

**Shortlist.** 18 were shortlisted, excluding HTTP/2, socket timing, diagnostics channels and TypeScript-only fixes, and **preferring 2026 fixes** to reduce the chance the model memorised them. The fix was then applied to the last release before it; 14 apply cleanly and 4 conflict (dropped).

**Task shape (if kept):**
- the base is the release before the fix;
- the prompt is written from the upstream issue and fix, stating everything graded;
- the reference is the upstream fix;
- the hidden suite starts from the upstream tests for the fix, hardened per `docs/bench/curation.md`;
- there are at least 2 incorrect implementations, one of which is the unfixed base.

| Commit | Base release | Date | Upstream fix |
|---|---|---|---|
| 6f63ce93 | v5.9.0 | 2026-07-05 | use ContentType to detect `json` and `charset` in reply.send (#6830) |
| 29bdcbb9 | v5.10.0 | 2026-07-30 | honor quoted-string in Content-Type parameter values (#6865) |
| c06fc06d | v5.8.5 | 2026-04-21 | use ContentType parser for response schema lookup (#6685) |
| 2ae3e1d7 | v5.8.5 | 2026-04-21 | validate invalid route logLevel at registration (#6523) |
| 1ef8a60c | v5.12.0 | 2026-08-18 | validation: preserve coerced root values |
| 7299a57d | v5.11.2 | 2026-08-03 | clear trailer state when removing all trailers (#6845) |
| f02d8d4a | v5.12.1 | 2026-09-03 | validation: do not unwrap async validator results |
| b9e54023 | v5.11.3 | 2026-08-12 | remove raw response headers (#6860) |
| 01ca8393 | v5.10.0 | 2026-07-30 | uncatchable throws in writeHead when using async hook (#6881) |
| 0e9a3b35 | v5.11.0 | 2026-07-30 | add http method override warning (#6879) |
| 8dee9be0 | v5.8.4 | 2026-03-28 | restore trustProxy function for number and string types |
| 4e1db5bd | v5.8.2 | 2026-03-23 | gate host and protocol getters on proxy trust function |
| 39f0f242 | v5.8.4 | 2026-03-23 | fix port parsing (#6603) |
| d338dca5 | v5.6.1 | 2025-11-08 | consistent error handling for custom validators in async validation contexts (#6247) |

**Dropped (the fix does not apply to the prior release):** 7de6e816, 93c239a3, cc8d9a3c, dd02e428.

## Next

1. **Difficulty screen.** Arm A only, 2 runs per candidate, graded by the upstream tests for the fix.
2. **Keep and curate.** Keep the tasks arm A fails at least once, and curate them fully.
3. **Freeze.** The owner approves each oracle before freezing.
