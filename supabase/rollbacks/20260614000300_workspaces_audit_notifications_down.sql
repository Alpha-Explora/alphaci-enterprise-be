DROP TABLE IF EXISTS notifications.notification_preferences;
DROP TABLE IF EXISTS notifications.notifications;
DROP TABLE IF EXISTS audit.audit_events;

ALTER TABLE projects.provisioned_projects
  DROP COLUMN IF EXISTS workspace_id;

DROP TABLE IF EXISTS orgs.workspace_members;
DROP TABLE IF EXISTS orgs.workspaces;

DROP SCHEMA IF EXISTS notifications;
DROP SCHEMA IF EXISTS audit;
DROP SCHEMA IF EXISTS orgs;
