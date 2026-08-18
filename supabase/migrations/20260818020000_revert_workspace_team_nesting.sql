-- Migration: 20260818020000_revert_workspace_team_nesting
--
-- Reverts 20260818010000_workspace_team_nesting.
--
-- Product decision 2026-08-18: **one workspace IS one team.** Splitting them
-- into two levels asked people to create a workspace and then create a team
-- inside it before anything could happen, and made "0 teams in Team1 Test" the
-- normal state of a working install.
--
-- The split also silently emptied the product: every group-scoped query filters
-- kind = 'team', and the nesting migration renamed existing top-level rows to
-- kind = 'workspace' — so /groups, the Teams rail and the dashboard's group
-- panels all returned nothing while the data was still perfectly intact.
--
-- Back to: a workspace row with kind='team' IS the team. No parent, no depth.
--
-- Safe to run: the column is dropped, so nothing can be orphaned by it, and no
-- other table ever referenced it. workspace_id keeps meaning exactly what it
-- always meant.

-- 1. The trigger forbids kind='team' without a parent, so it has to go BEFORE
--    the rows are renamed back.
DROP TRIGGER IF EXISTS trg_workspaces_nesting ON orgs.workspaces;
DROP FUNCTION IF EXISTS orgs.enforce_workspace_nesting();

-- 2. Any team that was created under a workspace is promoted to a workspace of
--    its own — one workspace, one team. Runs before the column is dropped.
UPDATE orgs.workspaces
SET parent_workspace_id = NULL
WHERE parent_workspace_id IS NOT NULL;

-- 3. Restore the single non-personal kind.
UPDATE orgs.workspaces
SET kind = 'team'
WHERE kind = 'workspace';

ALTER TABLE orgs.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_kind_check;

ALTER TABLE orgs.workspaces
  ADD CONSTRAINT workspaces_kind_check
    CHECK (kind IN ('personal', 'team'));

DROP INDEX IF EXISTS orgs.idx_workspaces_parent;

ALTER TABLE orgs.workspaces
  DROP COLUMN IF EXISTS parent_workspace_id;
