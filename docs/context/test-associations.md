# Test associations, coverage data and the test plan (QB-20)

## Why

The context package called a source file "covered" when a test file with a matching name existed (`test_coverage.covered_files`), and the briefing told the agent so under "## Test coverage". A file name proves nothing: `clamp.test.js` may not call `clamp` at all. The naming rules also only knew `*.test.*` / `*.spec.*` / `__tests__/`, so `tests/test_auth.py`, `auth_test.go` and `src/test/java/.../AuthTest.java` were never found.

On the verification side, the sandbox always ran `npm test` with QB's node:test reporter. A jest, pytest or `go test` project produced no machine-readable report, and the reason was not stated anywhere. Projects also had no way to say which command QB should run.

## Pre-fix repro (base 81fed18)

`test/unit/qb20-test-associations.test.js`, run against 81fed18 with a stub `context/test-plan.js`: **12 of 13 failed**.

- **Associations not found:**
  - Python: `tests/test_auth.py`, `app/auth_test.py`
  - Go: `auth/auth_test.go`
  - JS: `test/utils/clamp.test.js`, `tests/fmt.spec.js`
  - Java: `src/test/java/a/AuthTest.java`, because `.java` was not scanned at all
- **Coverage claims:**
  - the package had `test_coverage.covered_files`;
  - the briefing printed "## Test coverage";
  - real lcov/istanbul data was ignored.
- **No test plan:**
  - there was no explicit test config;
  - configured and detected unsupported runners were not refused;
  - the briefing gave no note that the detected runner is unused.

The test "verification with an unsupported runner is never PASS" already passed, because `not_run` with any reason other than `no_test_command` is unresolved. It stays as a guard.

## Design

**Associations** (`context/extractor.js` `testCandidates` / `findTestFile` / `isTestFile`):

| Family | Conventions |
|---|---|
| JS/TS | `<stem>.test\|spec.<ext>` beside it or in `__tests__/`; `__tests__/<stem>.<ext>`; `test/` and `tests/` mirrors (a leading `src/`, `lib/` or `app/` is stripped), plus a flat `test/<stem>.test.<ext>` |
| Python | `test_<stem>.py` and `<stem>_test.py` beside it, in a sibling `tests/`, or in a `tests/` or `test/` mirror (also flat) |
| Go | `<stem>_test.go` in the same package directory |
| Java | `<Stem>Test.java` / `<Stem>Tests.java` beside it, or in the `src/main/java` → `src/test/java` mirror |

The package field is `test_associations`:

```
{ basis, test_files, by_file: { src → test }, without_associated_tests }
```

`basis` says in words that these are name matches, not coverage. The briefing heading is "Associated tests (matched by file name only)". The briefing never uses the word "covered" or "coverage" for a name match.

- **Backward compatibility:** a legacy package that carries `test_coverage` still validates (the schema field is optional) and is still briefed, under the association wording.

**Coverage data** (`context/coverage.js`): read only from a report already in the checkout. Reports larger than 5 MB are ignored.

- **`coverage/lcov.info`:** gives `lines_pct` from `LF`/`LH`.
- **`coverage/coverage-final.json` (istanbul):** gives `statements_pct` from the `s` counters.
- **Output:** report paths are matched to the relevant files, and the result is `coverage: { source, path, files }`. There is no report → `null`. Coverage is never inferred from associations.
- **Briefing:** shows "Coverage data (from <path>)", with a note that the report may be out of date.

**Test plan** (`context/test-plan.js`): read from the user's checkout (the base), so the agent cannot change which command verifies its own work.

1. If `.quarterback.json` is present, it wins:

   ```json
   { "test": { "runner": "node-test", "command": ["node", "--test", "test/"] } }
   ```

   `command` is an argv array, never a shell string. Bad JSON or a bad shape gives `not_run` / `invalid_test_config`.

2. Otherwise the runner is detected (`context/detector.js` `detectTestRunner`).

3. Only `node-test` is **validated**: the sandbox injects QB's node:test reporter and classifies its report (QB-06). Any other runner, configured or detected (jest, vitest, mocha, jasmine, pytest, `go test`, …), gives:

   ```
   { status: 'not_run', reason: 'unsupported_runner', runner,
     detail: 'unsupported runner: X — QB cannot execute and parse its results yet' }
   ```

   It is never run. `not_run` with this reason is unresolved, so the task can never PASS. The detail is carried into `test_outcome.detail`. The briefing marks the runner "not used for verification".

4. Without a config, a node:test project, or one whose runner was not detected, runs `npm test`. No `test` script gives `no_test_command`.

**Sandbox** (`lib/sandbox/pipeline.js`, `stages.js`): the pipeline computes the plan before the verify stage.

- **Refused plan:** gives `sandbox.verification = { status: 'not_run', reason, detail, test_plan }`, and no container runs.
- **Accepted plan:**
  - `runVerification` and `runBaseTests` run `plan.command`, using `--entrypoint command[0]`;
  - the reporter is still injected through `NODE_OPTIONS`;
  - the `package.json` test-script probe applies only to the `npm test` command.
- **Contract checks (QB-16):** still run either way.

## Done when

- **Discovery:** fixtures find `tests/test_auth.py`, `auth_test.py`, `auth_test.go`, the JS conventions and the Java mirror (unit).
- **Configured command runs:** the configured node:test command runs in the real sandbox instead of the `package.json` script, and the QB report is produced (integration, Docker).
- **Unsupported runners are refused:**
  - configured or detected, they give `unsupported_runner` with the stated reason (unit);
  - a configured pytest project runs nothing in the sandbox and does not PASS (integration).
- **No coverage claims:** no briefing or package field claims coverage because a test file exists. Real lcov/istanbul data is reported separately (unit).

## Limitations

- **Associations are heuristics.** A test can exist under any name, and a matching name can test something else. Associations are hints for the agent and are never used as verification evidence.
- **Coverage data may be stale.** The report is whatever is in the checkout: it is not regenerated, and it may describe an older revision. QB does not run coverage tools.
- **node:test is the only validated runner.** jest, vitest, mocha, pytest and `go test` projects get no test verification until an adapter that executes and parses their results is added. Their tasks end unresolved, not PASS.
- **Undetected runners still run `npm test`.** A project whose runner is not detected (e.g. a hand-written `node test/run.js`) still runs `npm test`, as before. Without a node:test report such a run cannot PASS either (QB-06).
- **Language support:**
  - Java files are now scanned for associations, but symbols are still extracted by the regex fallback;
  - Rust, C# and other languages have no association conventions yet.
