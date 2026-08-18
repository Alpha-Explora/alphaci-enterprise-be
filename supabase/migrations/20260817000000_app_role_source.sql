-- Migration: 20260817000000_app_role_source
--
-- Purpose: record WHERE a user's global app_role came from, so GitHub org
-- team membership can drive the role without silently overwriting deliberate
-- Admin Console decisions.
--
--   'github_team' — app_role follows GitHub org team membership
--                   (Alpha-Explora `team-lead` / `developers`) and is
--                   re-evaluated on every login and by the membership
--                   webhook while GITHUB_TEAM_ROLE_SYNC = 'enforce'.
--   'manual'      — an admin set this role in the Console. Automatic sync
--                   SKIPS these users entirely until an admin resets them
--                   back to 'github_team' ("Reset to GitHub" in the Console).
--
-- BACKFILL — selective pinning (docs/GITHUB-TEAMS-INTEGRATION-PLAN.md §4.5).
-- The column default is 'github_team', so ordinary existing users start
-- following GitHub. This is deliberate: blanket-pinning everyone to 'manual'
-- would mean an existing developer promoted to `team-lead` in GitHub could
-- NEVER be auto-promoted, defeating the feature for every current account.
--
-- The one group that IS pinned here is platform admins: those rows are
-- deliberate, hand-granted elevations that must survive a team read. Two
-- further protections live in the application layer (GithubTeamRoleService):
-- an 'admin' app_role is never auto-downgraded, and an unreadable GitHub
-- response changes nothing at all.
--
-- Additive and idempotent.
ALTER TABLE identity.app_users
  ADD COLUMN IF NOT EXISTS app_role_source TEXT NOT NULL DEFAULT 'github_team'
    CHECK (app_role_source IN ('github_team', 'manual'));

COMMENT ON COLUMN identity.app_users.app_role_source IS
  'Provenance of app_role: github_team (synced from GitHub org teams) or manual (pinned by an Admin Console edit).';

-- Platform admins and super-admins are deliberate manual grants — never let a
-- GitHub team read move them.
UPDATE identity.app_users AS u
SET app_role_source = 'manual'
WHERE u.app_role_source <> 'manual'
  AND EXISTS (
    SELECT 1 FROM identity.platform_admins AS pa WHERE pa.user_id = u.id
  );

CREATE INDEX IF NOT EXISTS idx_app_users_app_role_source
  ON identity.app_users (app_role_source);
