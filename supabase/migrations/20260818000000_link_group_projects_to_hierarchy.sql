-- Migration: 20260818000000_link_group_projects_to_hierarchy
--
-- Purpose (docs/GITHUB-TEAMS-INTEGRATION-PLAN.md §3 Gap E, Phase 3):
-- make every GROUP-owned provisioned project assignable.
--
-- Today only repositories created through the create-system path get a
-- hierarchy.repositories row. Projects created from the /workflows Create
-- Project form are plain projects.provisioned_projects rows with no hierarchy
-- row, and hierarchy.repository_assignments references hierarchy.repositories
-- — so there is NO mechanism to assign a developer to a form-created project,
-- and therefore no GitHub team sync for it either.
--
-- This migration does two things:
--   1. Lets hierarchy.repositories record a repository's REAL visibility.
--   2. Backfills the systems -> delivery_projects -> repositories chain for
--      existing group projects that have no link yet.
--
-- New projects are linked in application code (HierarchyProjectLinkService),
-- which performs exactly the same shape of write for consistency.
--
-- Idempotent: re-running links only what is still unlinked.

-- ─── 1. Visibility ────────────────────────────────────────────────────────
-- The original CHECK allowed only 'private', matching the plan's "private
-- only — enforced, not just defaulted" rule for repositories the HIERARCHY
-- creates. That rule still holds: RepositoriesService always passes
-- private:true, so the creation path is unchanged.
--
-- Linked rows are different — they describe a repository that already exists
-- and may legitimately be public. Recording those as 'private' would make the
-- hierarchy row lie about the repo it points at. Widen the constraint so a
-- linked row can state the truth.
ALTER TABLE hierarchy.repositories
  DROP CONSTRAINT IF EXISTS repositories_visibility_check;

ALTER TABLE hierarchy.repositories
  ADD CONSTRAINT repositories_visibility_check
    CHECK (visibility IN ('private', 'public'));

COMMENT ON COLUMN hierarchy.repositories.visibility IS
  'Real visibility of the linked repository. Hierarchy-CREATED repositories are still forced to private by RepositoriesService; linked (form-created) repositories record what the repo actually is.';

-- ─── 2. Backfill ──────────────────────────────────────────────────────────
-- Scope, deliberately narrow:
--   * only projects whose workspace is a TEAM workspace (a Group). Personal
--     workspaces have no hierarchy tree and must not grow one.
--   * only projects with no existing hierarchy.repositories link
--     (provisioned_project_id is UNIQUE, so a linked project is already done).
--   * 'orphaned' projects are skipped — their GitHub repo is gone, so an
--     assignment against them could never be granted.
--
-- Shape mirrors SystemsService.createSystem: one system per project, a
-- same-named delivery project beneath it, then the repository. That keeps a
-- backfilled tree indistinguishable from one built through the UI, rather
-- than inventing a synthetic "ungrouped" bucket that the group pages would
-- then have to special-case.

-- 2a. One system per unlinked group project.
WITH unlinked AS (
  SELECT
    pp.id                AS project_id,
    pp.workspace_id      AS group_id,
    COALESCE(NULLIF(pp.service_name, ''), pp.repo_name, pp.repo_full_name) AS name
  FROM projects.provisioned_projects AS pp
  JOIN orgs.workspaces AS w
    ON w.id = pp.workspace_id AND w.kind = 'team'
  WHERE pp.workspace_id IS NOT NULL
    AND pp.status <> 'orphaned'
    AND NOT EXISTS (
      SELECT 1 FROM hierarchy.repositories AS hr
      WHERE hr.provisioned_project_id = pp.id
    )
)
INSERT INTO hierarchy.systems (group_id, name, description, owner_id, status)
SELECT
  u.group_id,
  u.name,
  'Backfilled from an existing group project so it can be assigned.',
  NULL,
  'active'
FROM unlinked AS u;

-- 2b. A delivery project under each system created above. Matched by
-- (group_id, name) against systems that have no delivery project yet, so a
-- re-run cannot double-insert.
INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, description, manager_id, status)
SELECT
  s.id,
  s.group_id,
  s.name,
  s.description,
  NULL,
  'active'
FROM hierarchy.systems AS s
WHERE s.description = 'Backfilled from an existing group project so it can be assigned.'
  AND NOT EXISTS (
    SELECT 1 FROM hierarchy.delivery_projects AS dp WHERE dp.system_id = s.id
  );

-- 2c. The repository row itself, linked to the provisioned project.
-- DISTINCT ON guards the (unlikely but possible) case of two projects in the
-- same group sharing a service name: each delivery project is consumed once.
WITH unlinked AS (
  SELECT
    pp.id           AS project_id,
    pp.workspace_id AS group_id,
    COALESCE(NULLIF(pp.service_name, ''), pp.repo_name, pp.repo_full_name) AS name,
    pp.repo_full_name,
    CASE WHEN pp.visibility = 'public' THEN 'public' ELSE 'private' END AS visibility,
    pp.user_id,
    pp.status
  FROM projects.provisioned_projects AS pp
  JOIN orgs.workspaces AS w
    ON w.id = pp.workspace_id AND w.kind = 'team'
  WHERE pp.workspace_id IS NOT NULL
    AND pp.status <> 'orphaned'
    AND NOT EXISTS (
      SELECT 1 FROM hierarchy.repositories AS hr
      WHERE hr.provisioned_project_id = pp.id
    )
),
available AS (
  SELECT
    dp.id AS delivery_project_id,
    dp.group_id,
    dp.name,
    ROW_NUMBER() OVER (PARTITION BY dp.group_id, dp.name ORDER BY dp.created_at, dp.id) AS rn
  FROM hierarchy.delivery_projects AS dp
  WHERE NOT EXISTS (
    SELECT 1 FROM hierarchy.repositories AS hr
    WHERE hr.delivery_project_id = dp.id
  )
),
numbered AS (
  SELECT
    u.*,
    ROW_NUMBER() OVER (PARTITION BY u.group_id, u.name ORDER BY u.project_id) AS rn
  FROM unlinked AS u
)
INSERT INTO hierarchy.repositories (
  delivery_project_id, group_id, name, repo_full_name,
  visibility, created_by, status, provisioned_project_id
)
SELECT
  a.delivery_project_id,
  n.group_id,
  n.name,
  n.repo_full_name,
  n.visibility,
  n.user_id,
  CASE WHEN n.status = 'provisioned' THEN 'active' ELSE 'pending' END,
  n.project_id
FROM numbered AS n
JOIN available AS a
  ON a.group_id = n.group_id AND a.name = n.name AND a.rn = n.rn;

-- 2d. Clear the backfill marker so a future run of 2b does not treat these
-- systems as needing another delivery project, and so the description does
-- not leak into the group UI as permanent copy.
UPDATE hierarchy.systems
SET description = NULL
WHERE description = 'Backfilled from an existing group project so it can be assigned.';
