# Telemetry metrics authentication (QB-33)

**Problem (review, QB-33):** `POST /api/metrics` used a registered email as its only authorization. A request with nobody's credentials, just a known email, inserted metrics. The string `"false"` was stored as `passed = 1`, and negative attempts and durations were accepted. The unused Pages function `landing_page/functions/api/metrics.js` had the same flaw.

## Credentials

1. `POST /api/telemetry/request {"email": …}`:
   - **Always 202,** with the same answer for unregistered emails, so registrations can't be enumerated.
   - **For a registered email,** it mails a one-time link that expires in 30 minutes.
   - **Limits and storage:** at most 3 requests per email per hour (then 429). Only the sha256 of the code is stored.
2. `GET /api/telemetry/verify?code=…`:
   - **Single use:** a conditional `UPDATE … WHERE used_at IS NULL`, so a second click gets nothing.
   - **Issues a token:** `qbt_<64 hex>`, scope `metrics:write`, shown **once** with `Cache-Control: no-store`. Only its sha256 is stored.
3. `POST /api/telemetry/revoke` with `Authorization: Bearer <token>` revokes the token. The owner can also set `revoked_at` in D1.

## `POST /api/metrics`

- **Authorization:** `Authorization: Bearer <unrevoked metrics:write token>`, or **401**. An email is never a credential.
- **Body:** at most 4096 bytes (else **413**). It must be a JSON object containing only these fields, each of the exact type and in range (else **400**, listing every problem):

| Field | Rule |
|---|---|
| `run_id` | UUID; **unique**: a replay is **409** |
| `passed` | boolean; the strings "true"/"false" and the numbers 0/1 are rejected |
| `attempts` | integer 1–20 |
| `duration_ms` | integer 0 to 24 h |
| `repair_count` | integer, 0 to `attempts − 1` |
| `layers_used` | optional, `L1..L5` comma list, no repeats |
| `qb_version` | 1–32 characters `[0-9A-Za-z.+-]` |

  Unknown fields (including `email` and `task_hash`) are rejected.
- **Rate limit:** at most 60 records per token per hour (**429**).
- **Storage:** rows go to `client_metrics` with `source = 'client_reported'`, with database `CHECK`s backing the bounds. `GET /api/report` returns them under `client_reported`, labelled "authenticated, schema-validated, NOT independently verified. Not benchmark evidence."
  - The legacy `metrics` table is no longer written or reported.

## Client

`qb --telemetry` sends only with `--telemetry-token` / `QB_TELEMETRY_TOKEN`; with no token, nothing is sent and the CLI says so. The payload is `run_id` (the run record's random UUID), `passed`, `attempts`, `duration_ms`, `repair_count`, `layers_used` and `qb_version`. **No email and no task hash** are sent. The `--beta-email` option is gone.

## Deploying

The worker deploys from `main`. **Apply the migration first:**

```
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0002_qb33_telemetry_auth.sql
```

`schema.sql` includes the same tables for new databases. `migrations/` and `schema.sql` are now excluded from the public static assets (`.assetsignore`); before this change `schema.sql` was publicly served.

## Tests

`test/unit/qb33-metrics-auth.test.js` runs the real worker against a real SQLite D1 (`node:sqlite`, so Node 22+; it runs on CI Node 22/24 and is skipped on Node 20). Before the fix, a known email alone got 200 and a stored row.

## Limits

- Delivering the verification email depends on Resend. With the current `onboarding@resend.dev` sender, Resend only delivers to the account owner, so other users can't receive links until a verified sender domain is set up (a known open item).
- A token proves control of an email inbox, not honest reporting: records are client-reported by design and labelled so.
