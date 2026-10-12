# Beta signup: input, abuse and delivery (QB-35)

**Problem (review, QB-35):**
- `null` or wrongly typed JSON threw before validation (`body.email` on `null`).
- There were no payload bounds and no rate limits.
- Deduplication was select-then-insert, so two concurrent submissions raced.
- Both emails were sent with `Promise.allSettled`, so a failure was silently dropped while the API reported success, and there was no retry.
- The legacy Pages function `functions/api/beta-access.js` had the same code.

## Input

`POST /api/beta-access` accepts a JSON object of at most **2 KiB** (else **413**) with only these fields; anything else is a defined **400**:

| Field | Rule |
|---|---|
| `email` | a string, trimmed and lower-cased, ≤ 254 characters, an address |
| `agent` | optional; a string of ≤ 80 printable characters, or null |

Unknown fields, `null`, arrays, numbers and unparsable bodies are all rejected.

## Abuse control

At most **10 attempts per IP per hour** (**429**). The limiter stores only `sha256("qb-signup:" + IP)` (`signup_attempts`). The `submissions` table still records the IP as before; QB-32 reviews that data flow.

## Atomic registration

`INSERT … ON CONFLICT(email) DO NOTHING`. Concurrent duplicates create exactly one row, and the others answer `{ ok, registered, duplicate: true }` with no email sent.

## Delivery, tracked separately

- **One queue row per email:** each signup queues one row per email in `email_deliveries`, keyed `welcome:<email>` and `owner-notify:<email>` (`UNIQUE`).
  - A send **claims** the row with a conditional update, so only one sender at a time.
  - Each send carries that key as Resend's `Idempotency-Key`.
  - The result is recorded: `sent`, or `failed` with `last_error` and exponential backoff.
  - After 6 attempts the row becomes `dead`.
- **The response says what happened:** `welcome_email: "sent"` or `"pending_retry"`. Registration success never depends on delivery.
- **Cron retry:** `wrangler.toml [triggers] crons = ["*/10 * * * *"]` runs `scheduled()`, which retries due `pending`/`failed` rows. A send stuck in `sending` for more than 10 minutes is retried, and Resend's idempotency key prevents a duplicate delivery.
- **Observable:** `GET /api/report` (admin) shows deliveries by status and the latest failures.

## Form

The landing-page form shows the server's actual outcome:
- registered, with the email either sent or "delayed and will be retried";
- "already on the list";
- invalid input;
- rate limited.

## Deploying

Apply **before** merging to `main`:

```
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0003_qb35_signup_delivery.sql
```

The cron trigger deploys with the worker.

## Tests

`test/unit/qb35-signup.test.js` runs the real worker on a real SQLite D1 (Node 22+; CI 22/24). It covers:
- defined responses for bad input;
- 4 concurrent duplicates → 1 row and 1 welcome email;
- a mocked provider failure → registered and `pending_retry`, with the failure visible; the cron retry delivers each email **once**; a re-signup changes nothing;
- dead after 6 attempts;
- an interrupted send is retried;
- the per-IP limit.

Pre-fix, all 5 fail, the first with `TypeError: Cannot read properties of null (reading 'email')`.

## Limits

Welcome emails can only reach the account owner until a verified Resend sender domain replaces `onboarding@resend.dev`. Until then they fail visibly (`failed`/`dead`) instead of silently.

## Re-review 1: registration and delivery intents commit atomically

- **One transaction:** a signup runs ONE D1 batch (one transaction) holding the `submissions` insert (`ON CONFLICT DO NOTHING`) and **both** delivery intents (`ON CONFLICT(idempotency_key) DO NOTHING`). A database failure anywhere, before either enqueue or between the two, leaves **nothing**, and the client simply retries. Pre-fix, the registration survived without jobs, and the duplicate early-return meant they were never created.
- **Repair path:** the idempotent enqueues also run for duplicates, so a registration missing its jobs (made by an older worker, or by a crash) is repaired on the next signup attempt. Completed jobs are never re-sent: only `pending`/`failed` jobs are claimed.
- **Sends stay outside the transaction:** each job carries a stable payload and its idempotency key. The owner-notification count is computed at send time.
- **Legacy signups:** migration `0004` records them as closed (`dead`, with "legacy signup before delivery tracking; not re-sent"), so a returning legacy user doesn't get a second welcome email.
- **Regressions:** faults injected before either enqueue and between the two (no registration, then retry → each email once); legacy repair (one welcome, never repeated); concurrent duplicates with a transient enqueue failure (1 row, 1 welcome).

## Re-review 2: completion outlives retention

The senior's reproduction: register, let retention delete the sent delivery rows after 30 days, register again. The repair path recreated both jobs and sent a second welcome. The legacy markers from migration `0004` expired the same way.

- **Durable completion state:** `delivery_completions` (migration `0005`) holds one row per completed delivery: `sha256("qb-delivery:" + idempotency key)`, the outcome (`sent` or `dead`) and the time. It contains no address, payload or log.
  - It is written in the same transaction that marks a delivery `sent` or `dead`.
  - Retention records it, in the same transaction, before deleting each expired sent/dead row. That covers rows written before the table existed and the `0004` legacy markers, which SQL can't hash during the migration.
- **Never-enqueued vs completed:** the enqueue is `INSERT … SELECT … WHERE NOT EXISTS (completion)`. A completed or legacy-suppressed delivery is never queued again; a registration whose jobs were never enqueued has no completion, so it is still repaired.
- **Retention still deletes** the delivery rows (address, payload, error log) after 30 days.
- **Signup quota:** the IP limiter admits atomically (see `metrics-auth.md` § Re-review 2).
- **Regressions** (`test/unit/phase5-rereview2.test.js`):
  - retention then repeat signup → still one welcome and one owner notice (pre-fix: 2);
  - legacy markers expire, then a repeat signup → no welcome (pre-fix: 1);
  - a never-enqueued registration is still repaired after retention ran, while a completed one isn't re-sent;
  - completion rows contain no address.
