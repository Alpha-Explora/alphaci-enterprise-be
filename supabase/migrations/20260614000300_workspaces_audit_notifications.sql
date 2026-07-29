CREATE SCHEMA IF NOT EXISTS orgs;
CREATE SCHEMA IF NOT EXISTS audit;
CREATE SCHEMA IF NOT EXISTS notifications;

CREATE TABLE IF NOT EXISTS orgs.workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'team')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orgs.workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);

ALTER TABLE projects.provisioned_projects
  ADD COLUMN IF NOT EXISTS workspace_id UUID NULL REFERENCES orgs.workspaces(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workspace_members_user
  ON orgs.workspace_members(user_id);

CREATE INDEX IF NOT EXISTS idx_provisioned_projects_workspace
  ON projects.provisioned_projects(workspace_id)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit.audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NULL REFERENCES orgs.workspaces(id) ON DELETE SET NULL,
  project_id UUID NULL REFERENCES projects.provisioned_projects(id) ON DELETE SET NULL,
  actor_user_id UUID NULL,
  event_code TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_project_created
  ON audit.audit_events(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID NULL REFERENCES projects.provisioned_projects(id) ON DELETE SET NULL,
  event_code TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read_created
  ON notifications.notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS notifications.notification_preferences (
  user_id UUID PRIMARY KEY,
  in_app_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
