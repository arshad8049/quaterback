-- QB-33: verified, revocable telemetry tokens; strict client-reported metrics with replay protection.
-- Apply BEFORE deploying the worker that uses it:
--   npx wrangler d1 execute qb-beta --remote --file=landing_page/migrations/0002_qb33_telemetry_auth.sql

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
