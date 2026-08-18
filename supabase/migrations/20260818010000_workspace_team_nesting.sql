-- Migration: 20260818010000_workspace_team_nesting
--
-- Purpose: give workspaces a level below them — a workspace CONTAINS teams —
-- without disturbing what `workspace_id` means anywhere else.
--
-- Until now a "workspace" and a "team" were the same row: orgs.workspaces with
-- kind='team'. That is why the header switcher and the Teams page listed the
-- same records from two angles.
--
-- WHY A PARENT POINTER AND NOT AN orgs.teams TABLE.
-- `workspace_id` is the scoping key for the whole product — it is on
-- projects.provisioned_projects, on every hierarchy.* table as group_id, on
-- audit.audit_events, and it drives every authorization check. A separate teams
-- table would force each of those to choose workspace-or-team and would
-- duplicate the entire membership model (a second *_members table with its own
-- roles, statuses and access assertions). A parent pointer expresses the same
-- containment while leaving `workspace_id` meaning exactly what it means today:
-- the TEAM that owns the thing. Nothing downstream migrates.
--
--   workspace : parent_workspace_id IS NULL, kind = 'workspace'
--   team      : parent_workspace_id = <workspace id>, kind = 'team'
--   personal  : parent_workspace_id IS NULL, kind = 'personal'
--
-- ON DELETE RESTRICT, not CASCADE. Deleting a workspace that still holds teams
-- would silently destroy several teams' membership from one click; the database
-- refuses, and GroupsService raises a readable error before it ever gets here.
--
-- DEPTH is capped at two by a trigger rather than a CHECK: a CHECK cannot see
-- another row, and the guard has to hold even against direct SQL, not just the
-- service layer.
--
-- Additive and idempotent.

ALTER TABLE orgs.workspaces
  ADD COLUMN IF NOT EXISTS parent_workspace_id UUID NULL
    REFERENCES orgs.workspaces(id) ON DELETE RESTRICT;

COMMENT ON COLUMN orgs.workspaces.parent_workspace_id IS
  'NULL for a top-level workspace (or a personal one). Set to the owning workspace for a team. Depth is capped at two.';

-- ─── kind: state the depth instead of inferring it from a null parent ───────
ALTER TABLE orgs.workspaces
  DROP CONSTRAINT IF EXISTS workspaces_kind_check;

ALTER TABLE orgs.workspaces
  ADD CONSTRAINT workspaces_kind_check
    CHECK (kind IN ('personal', 'workspace', 'team'));

-- Existing top-level 'team' rows ARE workspaces under the new model: they have
-- no parent and everything already hangs off them.
UPDATE orgs.workspaces
SET kind = 'workspace'
WHERE kind = 'team'
  AND parent_workspace_id IS NULL;

-- ─── Structural rules the application must not be the only thing enforcing ──
CREATE OR REPLACE FUNCTION orgs.enforce_workspace_nesting()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  parent_kind   TEXT;
  parent_parent UUID;
BEGIN
  IF NEW.parent_workspace_id IS NULL THEN
    -- A row with no parent may not call itself a team: 'team' is what having a
    -- parent MEANS, and a parentless team would be invisible to every
    -- workspace-scoped list.
    IF NEW.kind = 'team' THEN
      RAISE EXCEPTION 'A team must belong to a workspace (parent_workspace_id is null)';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_workspace_id = NEW.id THEN
    RAISE EXCEPTION 'A workspace cannot be its own parent';
  END IF;

  SELECT kind, parent_workspace_id
    INTO parent_kind, parent_parent
  FROM orgs.workspaces
  WHERE id = NEW.parent_workspace_id;

  IF parent_kind IS NULL THEN
    RAISE EXCEPTION 'Parent workspace % does not exist', NEW.parent_workspace_id;
  END IF;

  -- Two levels only. Nesting a team under a team would make every
  -- "teams of this workspace" query wrong in a way that is invisible until
  -- someone has already built the third level.
  IF parent_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Teams cannot be nested inside another team';
  END IF;

  IF parent_kind = 'personal' THEN
    RAISE EXCEPTION 'A personal workspace cannot contain teams';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workspaces_nesting ON orgs.workspaces;

CREATE TRIGGER trg_workspaces_nesting
  BEFORE INSERT OR UPDATE OF parent_workspace_id, kind ON orgs.workspaces
  FOR EACH ROW
  EXECUTE FUNCTION orgs.enforce_workspace_nesting();

-- Hot path: "the teams of this workspace".
CREATE INDEX IF NOT EXISTS idx_workspaces_parent
  ON orgs.workspaces (parent_workspace_id)
  WHERE parent_workspace_id IS NOT NULL;
