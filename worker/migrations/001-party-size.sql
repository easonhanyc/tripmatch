-- Adds party size, so one account can travel with people who aren't on the
-- platform. Existing rows default to 1, which is what they already meant, so
-- this is safe to run against a live board with no backfill.
ALTER TABLE posts     ADD COLUMN party_size INTEGER NOT NULL DEFAULT 1;
ALTER TABLE plus_ones ADD COLUMN party_size INTEGER NOT NULL DEFAULT 1;
