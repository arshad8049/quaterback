-- QB-35 re-review 2: durable delivery completion that outlives delivery-row retention.
-- Apply after 0004, BEFORE deploying the worker that uses it:
--   npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0005_delivery_completions.sql
--
-- No backfill here: SQL cannot compute the sha256 key. Existing sent/dead rows, including the
-- legacy markers 0004 created, are recorded by the worker's retention step in the same
-- transaction that deletes them, so no completed delivery is ever re-opened.

CREATE TABLE IF NOT EXISTS delivery_completions (
  key_hash     TEXT PRIMARY KEY,            -- sha256('qb-delivery:' || idempotency_key); no address
  outcome      TEXT NOT NULL CHECK (outcome IN ('sent', 'dead')),
  completed_at TEXT NOT NULL
);
