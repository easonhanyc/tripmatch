-- TripMatch schema (Cloudflare D1 / SQLite)
--
-- Design notes:
--  * Identity is an email address, not a display name. Ownership checks are
--    `author_email = session.email`, which is why edit/delete now work across
--    devices and survive a differently-typed name (the v1 open question).
--  * Posts are soft-deleted (deleted_at) rather than removed, so the audit
--    log always has a row to point at and a mistaken delete is recoverable.
--  * Every mutating request appends one row to audit_log in the same
--    handler. The log is append-only by convention: nothing in the worker
--    issues UPDATE or DELETE against it.

-- ---------------------------------------------------------------- users

CREATE TABLE IF NOT EXISTS users (
  email          TEXT PRIMARY KEY,          -- verified @berkeley.edu address
  name           TEXT NOT NULL,             -- display name from Google
  picture        TEXT,
  first_seen_at  INTEGER NOT NULL,          -- epoch ms
  last_seen_at   INTEGER NOT NULL,
  login_count    INTEGER NOT NULL DEFAULT 1
);

-- ---------------------------------------------------------------- posts

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  author_email  TEXT,                       -- NULL only for legacy imports
  author_name   TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('driver','rider')),
  seats         INTEGER NOT NULL DEFAULT 0,
  trip_date     TEXT NOT NULL,              -- 'YYYY-MM-DD', local Pacific day
  trip_time     TEXT NOT NULL DEFAULT '',   -- 'HH:MM' 24h, or ''
  notes         TEXT NOT NULL DEFAULT '',
  -- Rider posts only: how many people need a ride, including the poster.
  -- Driver posts leave this at 1 — their `seats` column already states how
  -- many places are free for other people.
  party_size    INTEGER NOT NULL DEFAULT 1,
  origin_city   TEXT NOT NULL,
  dest_city     TEXT NOT NULL,
  origin_region TEXT NOT NULL,
  dest_region   TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  deleted_at    INTEGER                     -- NULL = live
);

-- The board query is always "live posts on or after today, ordered by date".
CREATE INDEX IF NOT EXISTS idx_posts_board ON posts (deleted_at, trip_date);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts (author_email);

-- ------------------------------------------------------------- comments

CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  post_id      TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_email TEXT,
  author_name  TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, created_at);

-- ------------------------------------------------------------ plus_ones

-- One row per (post, person). The composite primary key is what makes the
-- +1 toggle safe under concurrency: two taps racing each other can't create
-- two rows, and the toggle is a single INSERT or DELETE, never a rewrite of
-- a list someone else may have just appended to.
CREATE TABLE IF NOT EXISTS plus_ones (
  post_id      TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_email TEXT NOT NULL,
  author_name  TEXT NOT NULL,
  -- How many people this row accounts for. One account can speak for more
  -- than one traveller — a partner, family without a Berkeley address, or a
  -- classmate who didn't sign up — so a driver's remaining seats is the SUM
  -- of this column, never a row count.
  party_size   INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (post_id, author_email)
);

CREATE INDEX IF NOT EXISTS idx_plusones_post ON plus_ones (post_id);

-- ------------------------------------------------------------ audit_log

CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,             -- epoch ms
  actor_email TEXT,
  actor_name  TEXT,
  action      TEXT NOT NULL,                -- 'login', 'post.create', ...
  entity_type TEXT,                         -- 'post' | 'comment' | 'plusone' | 'session'
  entity_id   TEXT,
  detail      TEXT,                         -- JSON blob, action-specific
  ip          TEXT,
  country     TEXT,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_email, ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log (action, ts DESC);
