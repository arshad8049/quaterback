-- QB-35: signup abuse control and durable, idempotent email delivery.
-- Apply BEFORE deploying the worker that uses it:
--   npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0003_qb35_signup_delivery.sql

CREATE TABLE IF NOT EXISTS signup_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash    TEXT    NOT NULL,                -- sha256, never the raw IP
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sa_ip_created ON signup_attempts(ip_hash, created_at);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT    NOT NULL UNIQUE,    -- welcome:<email> | owner-notify:<email>: one delivery per signup and kind
  kind            TEXT    NOT NULL CHECK (kind IN ('welcome', 'owner_notify')),
  recipient       TEXT    NOT NULL,
  payload         TEXT    NOT NULL DEFAULT '{}',
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT    NOT NULL,
  next_attempt_at TEXT    NOT NULL,
  claimed_at      TEXT,
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_ed_status_next ON email_deliveries(status, next_attempt_at);
