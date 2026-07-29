-- ─── app_users.is_internal ───────────────────────────────────────────────────
-- Marks a user as an internal employee (company GitHub org member) rather than
-- an external paying customer. Internal users bypass the subscription/payment
-- gate entirely (see SubscriptionService.getForUser).
--
-- ADDITIVE ONLY. This migration must never drop or rewrite existing data — the
-- database is shared with the external (sold) platform. Adding a NOT NULL column
-- with a constant DEFAULT is a metadata-only change on PostgreSQL 11+ (no table
-- rewrite, no lock on existing rows' data), so it is safe to run on the live DB.
--
-- The INTERNAL deployment (GITHUB_INTERNAL_ORG set) authoritatively recomputes
-- this flag on every GitHub sign-in from live org membership, so it self-heals
-- when a member joins or leaves the org. The EXTERNAL/sold deployment cannot
-- verify org membership and therefore preserves the existing value on login
-- (it only defaults brand-new rows to false), so an employee's internal status
-- is never clobbered by using the customer product on the shared database.

ALTER TABLE identity.app_users
  ADD COLUMN IF NOT EXISTS is_internal BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN identity.app_users.is_internal IS
  'True when the user is a verified member of the internal company GitHub org (GITHUB_INTERNAL_ORG). Internal users skip the subscription/payment gate. Authoritatively recomputed on every sign-in by the internal deployment; preserved (not overwritten) by the external/sold deployment.';
