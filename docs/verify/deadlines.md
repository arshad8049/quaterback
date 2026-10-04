# Deadlines, cancellation and budgets (QB-21)

**Status:** implemented on `phase-0-1-hardening`, in review.

## Why
- The Ollama calls (judge, intent compiler, context enricher) and the telemetry POST had **no deadline**, so a hung model or a stalled endpoint hung the whole run.
- The judge's three votes ran **strictly sequentially**.
- `runBounded` killed only the **direct** child on timeout. A grandchild kept the output pipe open, so the call did not return until it exited.
- There was **no total-run deadline**, and no record of which stage was interrupted.

Pre-fix (`a20ba67`), `test/unit/qb21-deadlines.test.js` fails **10 of 10**. Each case either hangs past its guard or lacks the mechanism:
- a judge call against a hung model, whether or not it honours abort;
- the compiler against a hung model;
- a run deadline during L4;
- `qb.js` end-to-end with a hung model;
- a stalled telemetry endpoint;
- a grandchild surviving a timeout, or a cancellation;
- concurrent votes;
- usage recording.

## Design (`lib/budget.js`)
| Mechanism | What it does |
|---|---|
| **Per-call deadline** | Every local-model call (`modelCall`) ends after `QB_MODEL_CALL_TIMEOUT_MS` (default 180 s). The fetch, the body read and the wait for a concurrency slot are all raced against the deadline, so the call ends **even if the transport ignores the abort signal**. The judge records `model call timed out after N ms`; the criterion is unresolved. |
| **Total-run deadline** | `qb --deadline <minutes>` or `QB_RUN_DEADLINE_MS`. When it passes, the run's signal aborts. In-flight and later model calls fail with `run deadline (N ms) exceeded during <stage>`. `qb.js` names each stage (`L1 intent`, `L2 context`, `L3 agent (attempt n)`, `L4 verification (attempt n)`, `L5 memory`) and checks the deadline after each one. The run record ends **CANCELLED** with that reason (exit code 3). |
| **Sandbox cancellation** | The run signal reaches the sandbox pipeline (`o.signal`). Its containers are removed at once, no new stage starts, and the result is `cancelled`. The admission slot and supervisor lease are released in the pipeline's existing `finally`. |
| **Process trees** | `runBounded` starts every command in its **own process group**. On timeout or `signal` the whole group is killed, grandchildren included. Groups still running when Quarterback exits are killed too. |
| **Bounded concurrency** | At most `QB_MODEL_CONCURRENCY` (default 2) model calls run at once. The judge's votes now run concurrently, in order-preserving fashion, within that bound. |
| **Telemetry** | `lib/telemetry.js` `sendMetrics`: one POST with a 3 s deadline. A stalled endpoint is abandoned (`{ sent: false, reason: "timeout" }`) and never fails the run. |
| **Usage** | Per stage: wall time. Per run: model calls, prompt and completion tokens (when the model reports `prompt_eval_count` / `eval_count`), and timeouts. Recorded as the `run.usage` event, also on cancellation. |

## Locks and artifacts on interruption
- **The judge-cache claim (QB-15) is released** in `finally`. An interrupted judgment (`error`) is **not cached**.
- **The run record survives:** attempts already finished keep their artifacts, and the manifest ends CANCELLED with the stage.

## Done-when
- **A hung mock model:** judge calls end at the per-call deadline, whether the transport honours or ignores the abort. The compiler is bounded. `qb.js` end-to-end with a hung model and `QB_RUN_DEADLINE_MS=1500` exits CANCELLED with `run deadline (1500ms) exceeded during L1 intent`.
- **A stalled telemetry endpoint:** a real local HTTP server that never answers is abandoned at the deadline.
- **A child process tree:** the grandchild of a timed-out or cancelled `runBounded` command is dead.
- **Artifacts survive, locks are released, and the final state names the interrupted stage:** all tested.

## Limitations
- `proc.run` (synchronous, used for short `git` / `tar` calls) stays synchronous, bounded only by its optional timeout. Long work (the agent, tests, checks) is asynchronous in the sandbox.
- Tokens are recorded only when the model reports them. The coding agent's own token usage isn't available to QB; its stage time is.
- Sandbox cancellation removes containers by run label. A stage already past its last Docker call finishes its host-side bookkeeping before the run returns `cancelled`.
