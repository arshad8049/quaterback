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

## Re-review 1
### The run deadline also bounds the judge-cache claim wait
- Before, a run waiting for another run's claim on the same evidence (QB-15) polled for its own `waitMs` (15 min by default), ignoring the run deadline.
- Now `acquire(key, { signal })` returns `{ cancelled }` as soon as the run signal aborts, and its poll sleep is cut short too. The judge then reports `judgment_cache: "cancelled"`, and the evidence says "Not judged: run deadline … exceeded during L4 verification …".
- The waiter **never touches the other owner's claim**: nothing is released or cached, and no model call is made. `qb.js` then ends **CANCELLED**, naming the stage.
- **Tested end-to-end** with two real `qb.js` processes sharing one judge cache. Run A holds a live claim behind a hung model. Run B, with a 2.5 s deadline, ends CANCELLED during `L4 verification (attempt 1)`, and A's claim is intact.

### Usage is honest: unknown is never zero (`run.usage`, schema `qb-usage/1`)
| Field | Meaning |
|---|---|
| `model.attempted / completed / failed / timed_out / cancelled` | Every call is counted, including failed, timed-out and cancelled ones. |
| `model.tokens.status` | `complete` (every completed call reported counts), `partial` (the sums cover only `calls_reporting`), `unknown` (none reported: `prompt` and `completion` are **null**), or `none` (no completed calls). |
| `model.models_reported`, `model.endpoints`, `model.configured` | The model ids the server actually reported, the hosts called, and the configured default. |
| `agent` | Identity (type, version, isolation). `usage_status: "unknown"`, `tokens: null`, `cost_usd: null`, with the reason: the sandboxed agent runs `claude -p --output-format text`, which reports no usage. Dry-run and manual are `not_applicable`. |
| `deadlines` | The effective run deadline, the per-call model deadline, model concurrency, and the sandbox stage deadlines. |
| `cost` | `model`: `estimated` $0 only for local Ollama endpoints and non-cloud models (basis stated; hardware and energy not metered), otherwise `unknown`. `agent`: `unknown` (basis stated). `total`: `unknown` whenever any part is unknown. |
| `unsupported` | Budgets QB does **not** enforce: a token budget (tokens are recorded, never capped), a cost budget, and agent token usage. |

- Recorded by `qb.js` (also on cancellation) and **per benchmark run** (`bench/run.js`, both arms). That covers the model-backed paths agreed in KAN-26: the benchmark, and T-POLICY, which runs through `qb.js` with the real agent.

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
- Agent token usage and cost stay **unknown** until the agent reports them. Switching the sandboxed agent to a structured output format would be a separate change to the agent image.
- No token or cost budget is enforced: they are recorded and stated as unsupported.
- Sandbox cancellation removes containers by run label. A stage already past its last Docker call finishes its host-side bookkeeping before the run returns `cancelled`.
