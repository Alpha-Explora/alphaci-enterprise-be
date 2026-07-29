-- Migration: 20260617_enable_rls_exposed_tables
--
-- Why: a live audit (pg_class.relrowsecurity) found 14 application tables with
-- Row Level Security DISABLED. Because Supabase exposes the project over PostgREST
-- with the public anon / authenticated API keys, every one of these tables could be
-- read and written directly with the anon key, bypassing the NestJS authorization
-- layer entirely. The credential-bearing tables (provider_connections,
-- project_ci_tokens, project_env_var_metadata) and identity.oauth_states are the
-- most severe; the rest leak cross-user data (notifications, workspaces, audit log,
-- CI run reports, etc.).
--
-- Approach: deny-by-default — identical to the proven pattern in
-- 20260616_sync_tables_enable_rls.sql. The backend connects with a role that has
-- BYPASSRLS (service-role; see src/supabase/supabase.service.ts and the direct
-- pg pool in src/modules/database/database.service.ts), so enabling RLS WITHOUT a
-- permissive policy leaves the backend fully functional while blocking anon /
-- authenticated. This app uses its own session cookies — not Supabase Auth — so
-- auth.uid() is always NULL here and no owner policy is required. All end-user
-- authorization is enforced in the API layer (SessionAuthGuard + ownership checks).
--
-- Safety: verified safe in production — projects.provisioned_projects already runs
-- with RLS enabled and the live backend reads it without issue, proving the
-- connection role bypasses RLS.
--
-- Idempotent: ENABLE ROW LEVEL SECURITY and REVOKE are safe to re-run.

-- ── Credential / secret-bearing (highest severity) ──────────────────────────────
ALTER TABLE env_provisioning.provider_connections      ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.project_env_var_metadata  ENABLE ROW LEVEL SECURITY;
ALTER TABLE env_provisioning.project_deployment_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci.project_ci_tokens                       ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity.oauth_states                      ENABLE ROW LEVEL SECURITY;

-- ── Cross-user application data ─────────────────────────────────────────────────
ALTER TABLE workflow.ci_run_reports                    ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_events                         ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs.workspaces                            ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs.workspace_members                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.notifications                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.notification_preferences     ENABLE ROW LEVEL SECURITY;
ALTER TABLE github_app.github_installation_accounts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.project_workflow_settings         ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.project_workflow_update_requests  ENABLE ROW LEVEL SECURITY;

-- Defense in depth: strip any table-level grants the public roles may have
-- inherited. RLS already blocks them, but revoking the grants closes the exposure
-- even if RLS is ever toggled off again.
REVOKE ALL ON env_provisioning.provider_connections       FROM anon, authenticated;
REVOKE ALL ON env_provisioning.project_env_var_metadata   FROM anon, authenticated;
REVOKE ALL ON env_provisioning.project_deployment_targets FROM anon, authenticated;
REVOKE ALL ON ci.project_ci_tokens                        FROM anon, authenticated;
REVOKE ALL ON identity.oauth_states                       FROM anon, authenticated;
REVOKE ALL ON workflow.ci_run_reports                     FROM anon, authenticated;
REVOKE ALL ON audit.audit_events                          FROM anon, authenticated;
REVOKE ALL ON orgs.workspaces                             FROM anon, authenticated;
REVOKE ALL ON orgs.workspace_members                      FROM anon, authenticated;
REVOKE ALL ON notifications.notifications                 FROM anon, authenticated;
REVOKE ALL ON notifications.notification_preferences      FROM anon, authenticated;
REVOKE ALL ON github_app.github_installation_accounts     FROM anon, authenticated;
REVOKE ALL ON projects.project_workflow_settings          FROM anon, authenticated;
REVOKE ALL ON projects.project_workflow_update_requests   FROM anon, authenticated;
