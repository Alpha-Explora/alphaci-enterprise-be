-- =============================================================================
-- Migration: 20260614_account_archive.sql
-- Date: 2026-06-14
--
-- Feature: Account archive (soft-delete) for identity.app_users
--
-- Semantics
--   archived_at IS NULL          → active account (normal state for all existing rows)
--   archived_at IS NOT NULL      → archived / soft-deleted account
--
-- Hard-delete ("start fresh") path
--   DELETE FROM identity.app_users WHERE id = $1
--   All child rows in every schema cascade automatically via ON DELETE CASCADE
--   foreign keys, so no manual cleanup is required.
--
-- Auto-purge
--   SELECT identity.purge_expired_archived_accounts(30);
--   Deletes rows from identity.app_users where archived_at is older than
--   `retention_days` (default 30 days). Child rows cascade automatically.
--   Call this from a scheduled job (e.g. pg_cron or an Edge Function cron).
--
-- Schema note
--   This database uses domain schemas (identity.*, billing.*, workflow.*, etc.)
--   rather than the public schema. All object references below use fully
--   schema-qualified names to match the live database reality. These migrations
--   have diverged from the initial scaffolding SQL — always use the qualified
--   names shown here.
--
-- No backfill: existing rows keep archived_at = NULL (treated as active).
-- The github_user_id UNIQUE constraint is unchanged.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- 1. Add archived_at column (idempotent)
-- ----------------------------------------------------------------------------
ALTER TABLE identity.app_users
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- 2. Partial index for purge lookups
--    Only indexes archived rows, keeping the index small and the purge fast.
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_app_users_archived_at
  ON identity.app_users (archived_at)
  WHERE archived_at IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Fix FK whose delete rule was SET NULL → rebuild with ON DELETE CASCADE
--
--    billing.subscription_events.user_id → identity.app_users(id)
--    Before: ON DELETE SET NULL  (left orphan rows on user deletion)
--    After:  ON DELETE CASCADE   (child rows removed with the user)
--
--    All other FKs referencing identity.app_users were already CASCADE:
--      billing.user_subscriptions_user_id_fkey
--      ci.ci_token_usage_user_id_fkey
--      ci.ci_tokens_user_id_fkey
--      env_provisioning.project_env_var_metadata_last_provisioned_by_fkey
--      env_provisioning.provider_connections_user_id_fkey
--      github_app.github_installation_accounts_user_id_fkey
--      github_app.github_installations_user_id_fkey
--      projects.provisioned_projects_user_id_fkey
--      workflow.workflow_generations_user_id_fkey
-- ----------------------------------------------------------------------------
ALTER TABLE billing.subscription_events
  DROP CONSTRAINT subscription_events_user_id_fkey;

ALTER TABLE billing.subscription_events
  ADD CONSTRAINT subscription_events_user_id_fkey
  FOREIGN KEY (user_id)
  REFERENCES identity.app_users(id)
  ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- 4. Purge function
--    Returns the number of hard-deleted rows for logging / observability.
--    Relies on ON DELETE CASCADE to clean up all child tables automatically.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity.purge_expired_archived_accounts(
  retention_days integer DEFAULT 30
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM identity.app_users
  WHERE archived_at IS NOT NULL
    AND archived_at < NOW() - (retention_days || ' days')::interval;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;
