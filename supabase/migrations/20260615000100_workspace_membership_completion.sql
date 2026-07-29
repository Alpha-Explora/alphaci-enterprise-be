-- Complete workspace membership support for dashboard Phase 12.
-- Keeps projects.workspace_id nullable so legacy user-owned projects continue to work.

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace
  ON orgs.workspace_members(workspace_id, role);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_user
  ON orgs.workspaces(owner_user_id);

WITH ranked_personal_workspaces AS (
  SELECT
    id,
    owner_user_id,
    first_value(id) OVER (
      PARTITION BY owner_user_id
      ORDER BY created_at ASC, id ASC
    ) AS canonical_workspace_id,
    row_number() OVER (
      PARTITION BY owner_user_id
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM orgs.workspaces
  WHERE kind = 'personal'
    AND owner_user_id IS NOT NULL
),
duplicate_members AS (
  SELECT
    ranked.canonical_workspace_id AS workspace_id,
    member.user_id,
    member.role
  FROM ranked_personal_workspaces AS ranked
  JOIN orgs.workspace_members AS member
    ON member.workspace_id = ranked.id
  WHERE ranked.rank > 1
)
INSERT INTO orgs.workspace_members (workspace_id, user_id, role)
SELECT workspace_id, user_id, role
FROM duplicate_members
ON CONFLICT (workspace_id, user_id)
DO UPDATE SET role = CASE
  WHEN orgs.workspace_members.role = 'owner' OR EXCLUDED.role = 'owner' THEN 'owner'
  WHEN orgs.workspace_members.role = 'admin' OR EXCLUDED.role = 'admin' THEN 'admin'
  WHEN orgs.workspace_members.role = 'developer' OR EXCLUDED.role = 'developer' THEN 'developer'
  ELSE 'viewer'
END;

WITH ranked_personal_workspaces AS (
  SELECT
    id,
    owner_user_id,
    first_value(id) OVER (
      PARTITION BY owner_user_id
      ORDER BY created_at ASC, id ASC
    ) AS canonical_workspace_id,
    row_number() OVER (
      PARTITION BY owner_user_id
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM orgs.workspaces
  WHERE kind = 'personal'
    AND owner_user_id IS NOT NULL
)
UPDATE projects.provisioned_projects AS project
SET workspace_id = ranked.canonical_workspace_id
FROM ranked_personal_workspaces AS ranked
WHERE ranked.rank > 1
  AND project.workspace_id = ranked.id;

WITH ranked_personal_workspaces AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY owner_user_id
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM orgs.workspaces
  WHERE kind = 'personal'
    AND owner_user_id IS NOT NULL
)
DELETE FROM orgs.workspaces AS workspace
USING ranked_personal_workspaces AS ranked
WHERE workspace.id = ranked.id
  AND ranked.rank > 1;

-- Predicate must match the ON CONFLICT (owner_user_id) WHERE kind = 'personal'
-- used by createPersonalWorkspace() and the backfill below. Postgres requires the
-- index predicate to be implied by the inference clause; "kind = 'personal'" does
-- not imply "owner_user_id IS NOT NULL", so the extra term breaks inference.
-- owner_user_id is NOT NULL at the table level, so the row set is identical.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_personal_owner
  ON orgs.workspaces(owner_user_id)
  WHERE kind = 'personal';

CREATE INDEX IF NOT EXISTS idx_app_users_login_lower
  ON identity.app_users (lower(login));

CREATE INDEX IF NOT EXISTS idx_app_users_email_lower
  ON identity.app_users (lower(email))
  WHERE email IS NOT NULL;

WITH project_owners AS (
  SELECT DISTINCT user_id::uuid AS user_id
  FROM projects.provisioned_projects
  WHERE workspace_id IS NULL
),
inserted_workspaces AS (
  INSERT INTO orgs.workspaces (owner_user_id, name, kind)
  SELECT user_id, 'Personal workspace', 'personal'
  FROM project_owners
  ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING
  RETURNING id, owner_user_id
),
all_owner_workspaces AS (
  SELECT id, owner_user_id
  FROM inserted_workspaces
  UNION
  -- DISTINCT ON + ORDER BY created_at must live in a derived table: a UNION's
  -- ORDER BY can only reference the union output columns, not created_at.
  SELECT id, owner_user_id
  FROM (
    SELECT DISTINCT ON (owner_user_id) id, owner_user_id
    FROM orgs.workspaces
    WHERE kind = 'personal'
    ORDER BY owner_user_id, created_at ASC
  ) AS existing_personal
)
INSERT INTO orgs.workspace_members (workspace_id, user_id, role)
SELECT id, owner_user_id, 'owner'
FROM all_owner_workspaces
ON CONFLICT (workspace_id, user_id) DO NOTHING;

UPDATE projects.provisioned_projects AS project
SET workspace_id = workspace.id
FROM (
  SELECT DISTINCT ON (owner_user_id) id, owner_user_id
  FROM orgs.workspaces
  WHERE kind = 'personal'
  ORDER BY owner_user_id, created_at ASC
) AS workspace
WHERE project.workspace_id IS NULL
  AND project.user_id::uuid = workspace.owner_user_id;
