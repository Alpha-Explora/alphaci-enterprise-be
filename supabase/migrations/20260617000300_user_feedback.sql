-- Migration: 20260617_user_feedback
--
-- Purpose: user-submitted feedback / bug reports that platform admins triage.
-- This is the only NET-NEW data path required by the admin feature — system
-- errors are already captured in workflow.ci_run_reports and audit.audit_events.
--
-- Lives in its own `support` schema to keep the support surface clearly separated
-- from identity / billing / workflow domains.

CREATE SCHEMA IF NOT EXISTS support;

CREATE TABLE IF NOT EXISTS support.feedback (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id       UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  category      TEXT        NOT NULL DEFAULT 'general'
                  CHECK (category IN ('general', 'bug', 'feature_request', 'billing', 'other')),
  subject       TEXT        NOT NULL,
  body          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed')),
  admin_response TEXT       NULL,
  responded_by  UUID        NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  responded_at  TIMESTAMPTZ NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_feedback_user_created
  ON support.feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_status_created
  ON support.feedback (status, created_at DESC);

ALTER TABLE support.feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON support.feedback FROM anon, authenticated;

COMMENT ON TABLE support.feedback
  IS 'User-submitted feedback / bug reports, triaged by platform admins. RLS deny-by-default; reachable only via backend service-role.';
