-- Rollback: 20260617_provisioned_projects_example_flag
-- Reverses the is_example flag + partial index added on
-- projects.provisioned_projects. Drops any seeded demo rows first so the
-- column drop does not silently strand orphaned "fake repo" rows that would
-- otherwise look like real projects once the flag distinguishing them is gone.

DELETE FROM projects.provisioned_projects
WHERE is_example = true;

DROP INDEX IF EXISTS projects.idx_provisioned_projects_user_real;

ALTER TABLE projects.provisioned_projects
  DROP COLUMN IF EXISTS is_example;
