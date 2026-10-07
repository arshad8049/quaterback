-- Quarterback beta — D1 schema
-- Run once: npx wrangler d1 execute qb-beta --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS submissions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT    NOT NULL UNIQUE,
  agent      TEXT,
  created_at TEXT    DEFAULT (datetime('now')),
  ip         TEXT,
  referrer   TEXT
);

CREATE TABLE IF NOT EXISTS metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT    NOT NULL,
  task_hash    TEXT,
  passed       INTEGER,           -- 1 = pass, 0 = fail
  attempts     INTEGER,
  duration_ms  INTEGER,
  tokens_used  INTEGER,
  repair_count INTEGER DEFAULT 0,
  layers_used  TEXT,
  qb_version   TEXT,
  created_at   TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(email);
CREATE INDEX IF NOT EXISTS idx_metrics_email     ON metrics(email);
CREATE INDEX IF NOT EXISTS idx_metrics_created   ON metrics(created_at);

-- QB-33 (also landing_page/migrations/0002_qb33_telemetry_auth.sql for existing databases)
CREATE TABLE IF NOT EXISTS telemetry_verifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT    NOT NULL UNIQUE,        -- sha256 of the one-time code (the code itself is never stored)
  email      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  expires_at TEXT    NOT NULL,
  used_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_tv_email_created ON telemetry_verifications(email, created_at);

CREATE TABLE IF NOT EXISTS telemetry_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT    NOT NULL UNIQUE,        -- sha256 of the bearer token (the token itself is never stored)
  email      TEXT    NOT NULL,
  scope      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS client_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL UNIQUE,      -- replay protection: one row per client run
  token_id     INTEGER NOT NULL REFERENCES telemetry_tokens(id),
  passed       INTEGER NOT NULL CHECK (passed IN (0, 1)),
  attempts     INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 20),
  duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0),
  repair_count INTEGER NOT NULL CHECK (repair_count >= 0),
  layers_used  TEXT,
  qb_version   TEXT    NOT NULL,
  source       TEXT    NOT NULL DEFAULT 'client_reported' CHECK (source = 'client_reported'),
  created_at   TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cm_token_created ON client_metrics(token_id, created_at);
-- The legacy `metrics` table (email-authorized, unvalidated rows) is no longer written or reported.

-- QB-35 (also landing_page/migrations/0003_qb35_signup_delivery.sql)
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
