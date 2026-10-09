-- Phase 5 re-review (QB-33, QB-35). Apply after 0002 and 0003, BEFORE deploying the worker:
--   npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0004_phase5_rereview.sql

-- QB-33: every telemetry-link request is counted the same way, registered or not (no enumeration).
CREATE TABLE IF NOT EXISTS telemetry_link_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email_hash TEXT    NOT NULL,                -- sha256, never the address
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tlr_hash_created ON telemetry_link_requests(email_hash, created_at);

-- QB-35: signups made before delivery tracking have no jobs. Record them as closed ('dead', with
-- the reason) so the idempotent repair path never re-sends a welcome the old worker already sent.
INSERT INTO email_deliveries (idempotency_key, kind, recipient, payload, status, attempts, last_error, created_at, next_attempt_at)
  SELECT 'welcome:' || email, 'welcome', email, '{}', 'dead', 0, 'legacy signup before delivery tracking; not re-sent', datetime('now'), datetime('now')
  FROM submissions WHERE true
  ON CONFLICT(idempotency_key) DO NOTHING;
INSERT INTO email_deliveries (idempotency_key, kind, recipient, payload, status, attempts, last_error, created_at, next_attempt_at)
  SELECT 'owner-notify:' || email, 'owner_notify', 'owner', '{}', 'dead', 0, 'legacy signup before delivery tracking; not re-sent', datetime('now'), datetime('now')
  FROM submissions WHERE true
  ON CONFLICT(idempotency_key) DO NOTHING;
