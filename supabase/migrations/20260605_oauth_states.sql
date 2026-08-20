-- ─── oauth_states ────────────────────────────────────────────────────────────
-- Transient table for cross-origin OAuth CSRF state verification.
--
-- Motivation: SameSite=None cookies require HTTPS, and Render terminates TLS
-- at the edge. Storing state in the session cookie introduced a race condition
-- on cold starts where the session write might not flush before GitHub calls
-- back. Persisting state in Supabase eliminates both dependencies.
--
-- Row lifecycle: INSERT on startGitHubAuth, DELETE+RETURNING on callback.
-- Rows that are never consumed (abandoned flows) are cleaned up by expires_at.

CREATE TABLE IF NOT EXISTS oauth_states (
  state       TEXT        NOT NULL PRIMARY KEY,
  return_to   TEXT        NOT NULL DEFAULT '/',
  provider    TEXT        NOT NULL DEFAULT 'github',
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the expiry sweep in clean_expired_oauth_states().
--
-- Deliberately NOT partial. A `WHERE expires_at > NOW()` predicate is
-- rejected outright — index predicates must be IMMUTABLE and NOW() is
-- only STABLE — and it would have indexed the *unexpired* rows, which is
-- the opposite of the set the DELETE sweep scans.
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
  ON oauth_states (expires_at);

-- ─── Cleanup function (optional — for pg_cron or manual invocation) ──────────
-- Removes expired rows that were never consumed (abandoned OAuth flows).
-- Run periodically: SELECT clean_expired_oauth_states();
CREATE OR REPLACE FUNCTION clean_expired_oauth_states()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM oauth_states WHERE expires_at <= NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
