-- Migration: project_ci_tokens
-- Stores revocable per-project CI authorization tokens. Only hashes are stored.

CREATE SCHEMA IF NOT EXISTS ci;

CREATE TABLE IF NOT EXISTS ci.project_ci_tokens (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,
  token_prefix  TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  revoked_at    TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id)
);

CREATE INDEX IF NOT EXISTS idx_project_ci_tokens_hash_active
  ON ci.project_ci_tokens (token_hash)
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION ci.set_project_ci_tokens_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_ci_tokens_updated_at ON ci.project_ci_tokens;

CREATE TRIGGER trg_project_ci_tokens_updated_at
  BEFORE UPDATE ON ci.project_ci_tokens
  FOR EACH ROW EXECUTE FUNCTION ci.set_project_ci_tokens_updated_at();
