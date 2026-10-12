# Deployment (QB-37)

**Canonical path:** Cloudflare Workers, defined by `wrangler.toml`.
- `main = "landing_page/_worker.js"`; the static assets are `landing_page/`, minus `.assetsignore`.
- The cron trigger `*/10 * * * *` is from QB-35.
- The site deploys from `main` through Cloudflare's Git integration.

**Removed:**
- `netlify.toml` (the Netlify site was deleted on 2026-10-04);
- the legacy Pages functions in `landing_page/functions/api/*`, removed in QB-33, QB-34 and QB-35 together with their security flaws.

**Never served** (`.assetsignore`): `_worker.js`, `wrangler.toml`, `schema.sql`, `migrations/`.

## Before merging to `main`

Apply the D1 migrations, in order:
```
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0002_qb33_telemetry_auth.sql
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0003_qb35_signup_delivery.sql
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0004_phase5_rereview.sql
npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0005_delivery_completions.sql
```
**Gate:** rotate `ADMIN_SECRET` (QB-34) with `npx wrangler secret put ADMIN_SECRET`. Refusing URL credentials can't remove URLs that already leaked into histories or logs, so the old secret must stop working.

## After every deploy

```
npm run smoke                       # https://quaterback.velorallc.workers.dev
npm run smoke -- https://<preview>  # any other deployment
```

`scripts/smoke.js` checks, **without creating any data or sending any email**:
- the static pages;
- that the worker source, schema, migrations and legacy functions are **not** served;
- every API route's wiring and its fail-closed answers: the signup preflight, invalid input (400) and GET (405); metrics without a token (401); a bad telemetry code (400); revoke/delete without a token (401); the admin report and export without credentials (401, no-store, no data); a URL secret (400).

**Local staging:** `test/unit/qb37-deployment.test.js` runs the same smoke checks against the real worker behind a real HTTP server, with a real SQLite D1, static assets served under the same `.assetsignore` rules, and mocked mail. It also runs an end-to-end signup → telemetry token → metrics → admin report flow there. Node 22+; CI 22/24.

## Public claims

QB-37 also requires evidence-linked benchmark claims and agent, cost and local-processing claims that match the implementation. Those copy changes are **pending the site owner's decision** and are not part of this change.
