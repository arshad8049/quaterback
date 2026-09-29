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
