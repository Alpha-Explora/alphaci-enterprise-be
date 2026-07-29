-- Rollback: project_ci_tokens
--
-- Use only if the project CI token migration must be reverted in production.
-- This is destructive: it removes stored CI token hashes, so gated workflows
-- will stop authorizing until tokens are reissued.

BEGIN;

DROP TRIGGER IF EXISTS trg_project_ci_tokens_updated_at ON ci.project_ci_tokens;
DROP TABLE IF EXISTS ci.project_ci_tokens;
DROP FUNCTION IF EXISTS ci.set_project_ci_tokens_updated_at();
DROP SCHEMA IF EXISTS ci;

COMMIT;
