-- Migration: 20260617_platform_admins
--
-- Purpose: introduce a PLATFORM-LEVEL admin role, distinct from the per-workspace
-- roles in orgs.workspace_members. A workspace 'admin' administers a single team;
-- a platform admin can see across all users for support / oversight.
--
-- Two-tier, grantable model:
--   * 'admin'        — read-only oversight (view users, workflows, errors, feedback)
--   * 'super_admin'  — everything an admin can do, PLUS grant/revoke admin on others
--
-- Absence of a row = ordinary user. Keeping the privileged set in its own table
-- (rather than a boolean column on app_users) keeps it explicit, auditable
-- (granted_by / granted_at), and small.
--
-- Security: deny-by-default RLS, same rationale as the other app tables — the
-- backend service-role bypasses RLS, anon/authenticated are blocked, and all
-- authorization is enforced in the API layer (PlatformAdminGuard / SuperAdminGuard).

CREATE TABLE IF NOT EXISTS identity.platform_admins (
  user_id    UUID        NOT NULL PRIMARY KEY
               REFERENCES identity.app_users(id) ON DELETE CASCADE,
  role       TEXT        NOT NULL CHECK (role IN ('admin', 'super_admin')),
  granted_by UUID        NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_admins_role
  ON identity.platform_admins (role);

ALTER TABLE identity.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON identity.platform_admins FROM anon, authenticated;

COMMENT ON TABLE identity.platform_admins
  IS 'Platform-level admin grants (admin | super_admin). Distinct from orgs.workspace_members. RLS deny-by-default; reachable only via backend service-role.';

-- ── Bootstrap super-admin ────────────────────────────────────────────────────
-- The first super-admin must be seeded here because admin can only be granted by
-- an existing super-admin via the UI (chicken/egg). Seeded by GitHub login so the
-- statement is portable across environments. Idempotent: ON CONFLICT DO NOTHING,
-- and self-granted (granted_by = the same account) to satisfy the audit trail.
--
-- To change the bootstrap account, edit the login below. To add more later, use
-- the super-admin UI (POST /api/v1/admin/users/:id/role) rather than this file.
INSERT INTO identity.platform_admins (user_id, role, granted_by)
SELECT u.id, 'super_admin', u.id
FROM identity.app_users AS u
WHERE u.login = 'lloydlim1'
ON CONFLICT (user_id) DO NOTHING;
