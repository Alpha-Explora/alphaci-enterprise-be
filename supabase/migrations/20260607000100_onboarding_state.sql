-- Migration: 20260607_onboarding_state
-- Purpose: Track whether a user has completed (or skipped) the one-time onboarding tour.
--
-- Column semantics:
--   NULL                 = onboarding not yet completed; user is brand-new and SHOULD see the tour.
--   TIMESTAMPTZ value    = onboarding completed or skipped; user should NOT see the tour again.
--
-- Backfill: all rows that existed BEFORE this migration are set to their created_at timestamp.
-- This ensures only accounts created AFTER this migration runs will see the tour.
-- New users inserted by upsertGitHubUser / upsertGoogleUser will have NULL (not in INSERT list).
--
-- Schema note: the live database organizes tables into domain schemas; the users
-- table is identity.app_users (the BE reaches it via the connection search_path,
-- which is why its repository queries use the unqualified name app_users).
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent; UPDATE only touches NULL rows.

ALTER TABLE identity.app_users
  ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill existing users so they are not shown the onboarding tour.
-- COALESCE guards against running this UPDATE more than once (re-run safety).
UPDATE identity.app_users
  SET onboarding_completed_at = COALESCE(onboarding_completed_at, created_at)
  WHERE onboarding_completed_at IS NULL;
