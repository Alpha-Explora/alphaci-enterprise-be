-- Migration: provisioned_projects
-- Tracks repositories and workflow files provisioned for users via FlowCI Studio.

CREATE TABLE IF NOT EXISTS provisioned_projects (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID          NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  repo_full_name      TEXT          NOT NULL,
  template_id         TEXT          NOT NULL,
  service_name        TEXT          NOT NULL,
  workflow_path       TEXT          NOT NULL,
  status              TEXT          NOT NULL CHECK (status IN ('provisioning', 'provisioned', 'failed')),
  github_commit_sha   TEXT          NULL,
  github_commit_url   TEXT          NULL,
  failure_reason      TEXT          NULL,
  repo_url            TEXT          NULL,
  visibility          TEXT          NULL,
  repo_shape          TEXT          NULL,
  project_type_id     TEXT          NULL,
  workflow_recipe_id  TEXT          NULL,
  project_options     JSONB         NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Index for the common list-by-user query
CREATE INDEX IF NOT EXISTS idx_provisioned_projects_user_id
  ON provisioned_projects (user_id, created_at DESC);

-- Auto-update updated_at on row changes
CREATE OR REPLACE FUNCTION set_provisioned_projects_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_provisioned_projects_updated_at ON provisioned_projects;

CREATE TRIGGER trg_provisioned_projects_updated_at
  BEFORE UPDATE ON provisioned_projects
  FOR EACH ROW EXECUTE FUNCTION set_provisioned_projects_updated_at();
