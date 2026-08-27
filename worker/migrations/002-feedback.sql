-- Adds the in-app feedback table. New table only — nothing existing is
-- touched, so this is safe to run against the live database.
CREATE TABLE IF NOT EXISTS feedback (
  id           TEXT PRIMARY KEY,
  author_email TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('bug','idea','other')),
  body         TEXT NOT NULL,
  user_agent   TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
