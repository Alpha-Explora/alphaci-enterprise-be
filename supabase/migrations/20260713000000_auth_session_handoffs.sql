-- One-time OAuth session handoff tokens.
--
-- After GitHub/Google OAuth the API sets a session cookie and redirects to the
-- frontend on a different origin/port. Browsers often drop that cookie on the
-- bounce (or never send it on the subsequent cross-origin /auth/me call).
--
-- Flow: OAuth success → insert handoff row → redirect ?handoff=<token>
--       FE POSTs /auth/session/claim → BE establishes session + Set-Cookie
--       on a credentialed response the browser keeps.

CREATE TABLE IF NOT EXISTS identity.auth_session_handoffs (
  token       TEXT        NOT NULL PRIMARY KEY,
  payload     JSONB       NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_session_handoffs_expires_at
  ON identity.auth_session_handoffs (expires_at);

CREATE OR REPLACE FUNCTION identity.clean_expired_auth_session_handoffs()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM identity.auth_session_handoffs WHERE expires_at <= NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
