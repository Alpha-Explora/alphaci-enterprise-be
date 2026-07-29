-- Keep the workspace membership constraint aligned with the backend role model.
-- The deployed database had an older constraint that rejected the owner role
-- used when a personal or team workspace is bootstrapped.

ALTER TABLE orgs.workspace_members
  DROP CONSTRAINT IF EXISTS workspace_members_role_check;

ALTER TABLE orgs.workspace_members
  ADD CONSTRAINT workspace_members_role_check
  CHECK (role IN ('owner', 'admin', 'developer', 'viewer'));
