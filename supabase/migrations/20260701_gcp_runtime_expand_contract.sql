-- Migration: gcp_runtime_expand_contract
--
-- Adds GCP runtime metadata beside the existing Vercel/Render compatibility
-- tables. This is expand-only: it does not alter or delete env_provisioning
-- provider connection/target rows.

BEGIN;

CREATE SCHEMA IF NOT EXISTS runtime_deployments;

CREATE SCHEMA IF NOT EXISTS runtime_domains;

CREATE SCHEMA IF NOT EXISTS runtime_secrets;

CREATE SCHEMA IF NOT EXISTS billing_lifecycle;

CREATE SCHEMA IF NOT EXISTS gcp_operations;

CREATE OR REPLACE FUNCTION gcp_operations.set_gcp_runtime_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS runtime_deployments.deployment_targets (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  project_id                 UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  owner_type                 TEXT        NOT NULL CHECK (owner_type IN ('alphaexplora_product', 'alphaci_customer')),
  runtime_scope              TEXT        NOT NULL CHECK (runtime_scope IN ('shared_project', 'dedicated_customer_project')),
  product_slug               TEXT        NULL,
  customer_slug              TEXT        NOT NULL,
  app_slug                   TEXT        NOT NULL,
  environment                TEXT        NOT NULL CHECK (environment IN ('dev', 'stg', 'uat', 'prod', 'preview')),
  service_slot               TEXT        NOT NULL CHECK (service_slot IN ('web', 'api', 'worker', 'standalone')),
  provider                   TEXT        NOT NULL DEFAULT 'gcp' CHECK (provider = 'gcp'),
  deployment_strategy        TEXT        NOT NULL DEFAULT 'gcp_cloud_run' CHECK (deployment_strategy IN ('gcp_cloud_run')),
  gcp_project_id             TEXT        NOT NULL,
  gcp_project_number         TEXT        NULL,
  region                     TEXT        NOT NULL,
  artifact_registry_location TEXT        NOT NULL,
  artifact_registry_repo     TEXT        NOT NULL,
  image_name                 TEXT        NOT NULL,
  cloud_run_service_name     TEXT        NOT NULL,
  runtime_service_account    TEXT        NOT NULL,
  deployer_service_account   TEXT        NOT NULL,
  provisioning_status        TEXT        NOT NULL DEFAULT 'pending'
    CHECK (provisioning_status IN ('pending', 'provisioning', 'provisioned', 'failed', 'deleting', 'deleted')),
  deployment_status          TEXT        NOT NULL DEFAULT 'idle'
    CHECK (deployment_status IN ('idle', 'queued', 'deploying', 'healthy', 'unhealthy', 'failed', 'rolled_back')),
  last_healthy_revision      TEXT        NULL,
  last_deployment_error_code TEXT        NULL,
  last_deployment_error_safe_message TEXT NULL,
  metadata                   JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, project_id, app_slug, environment, service_slot)
);

CREATE INDEX IF NOT EXISTS idx_gcp_deployment_targets_project_environment
  ON runtime_deployments.deployment_targets (project_id, environment, service_slot);

CREATE INDEX IF NOT EXISTS idx_gcp_deployment_targets_workspace_status
  ON runtime_deployments.deployment_targets (workspace_id, provisioning_status, deployment_status);

CREATE INDEX IF NOT EXISTS idx_gcp_deployment_targets_gcp_project
  ON runtime_deployments.deployment_targets (gcp_project_id, region);

CREATE TABLE IF NOT EXISTS runtime_deployments.deployment_attempts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_target_id  UUID        NOT NULL REFERENCES runtime_deployments.deployment_targets(id) ON DELETE CASCADE,
  correlation_id        TEXT        NOT NULL,
  repository_full_name  TEXT        NOT NULL,
  ref                   TEXT        NOT NULL,
  commit_sha            TEXT        NULL,
  workflow_run_id       TEXT        NULL,
  image_digest          TEXT        NULL,
  cloud_run_revision    TEXT        NULL,
  status                TEXT        NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  health_probe_url      TEXT        NULL,
  logs_url              TEXT        NULL,
  safe_error_code       TEXT        NULL,
  safe_error_message    TEXT        NULL,
  started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at           TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gcp_deployment_attempts_target_started
  ON runtime_deployments.deployment_attempts (deployment_target_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_gcp_deployment_attempts_correlation
  ON runtime_deployments.deployment_attempts (correlation_id);

CREATE TABLE IF NOT EXISTS runtime_domains.domain_records (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_target_id  UUID        NOT NULL REFERENCES runtime_deployments.deployment_targets(id) ON DELETE CASCADE,
  domain                TEXT        NOT NULL,
  domain_base           TEXT        NOT NULL,
  domain_kind           TEXT        NOT NULL CHECK (domain_kind IN ('generated', 'preview', 'custom', 'fallback')),
  routing_mode          TEXT        NOT NULL CHECK (routing_mode IN ('load_balancer', 'cloud_run_domain_mapping', 'dns_only', 'manual')),
  is_primary            BOOLEAN     NOT NULL DEFAULT false,
  is_fallback           BOOLEAN     NOT NULL DEFAULT false,
  is_deprecated         BOOLEAN     NOT NULL DEFAULT false,
  replacement_domain_id UUID        NULL REFERENCES runtime_domains.domain_records(id) ON DELETE SET NULL,
  certificate_status    TEXT        NOT NULL DEFAULT 'pending'
    CHECK (certificate_status IN ('pending', 'provisioning', 'active', 'failed', 'not_required')),
  dns_instructions      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at      TIMESTAMPTZ NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (domain)
);

CREATE INDEX IF NOT EXISTS idx_gcp_domain_records_target
  ON runtime_domains.domain_records (deployment_target_id, is_primary, is_deprecated);

CREATE INDEX IF NOT EXISTS idx_gcp_domain_records_certificate
  ON runtime_domains.domain_records (certificate_status, last_verified_at);

CREATE TABLE IF NOT EXISTS runtime_secrets.secret_references (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_target_id  UUID        NOT NULL REFERENCES runtime_deployments.deployment_targets(id) ON DELETE CASCADE,
  secret_name           TEXT        NOT NULL,
  secret_version_ref    TEXT        NULL,
  scope                 TEXT        NOT NULL CHECK (scope IN ('project', 'deployment_target', 'app', 'preview')),
  key_name              TEXT        NOT NULL,
  redaction_state       TEXT        NOT NULL DEFAULT 'metadata_only' CHECK (redaction_state IN ('metadata_only', 'redacted')),
  rotation_status       TEXT        NOT NULL DEFAULT 'active' CHECK (rotation_status IN ('active', 'rotation_due', 'rotating', 'disabled')),
  created_by            UUID        NULL REFERENCES identity.app_users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (deployment_target_id, scope, key_name)
);

CREATE INDEX IF NOT EXISTS idx_gcp_secret_references_target
  ON runtime_secrets.secret_references (deployment_target_id, scope);

CREATE INDEX IF NOT EXISTS idx_gcp_secret_references_rotation
  ON runtime_secrets.secret_references (rotation_status, updated_at);

CREATE TABLE IF NOT EXISTS gcp_operations.provisioning_jobs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type              TEXT        NOT NULL CHECK (job_type IN ('provision_target', 'deploy_revision', 'cleanup_preview', 'reconcile_target', 'delete_target')),
  idempotency_key       TEXT        NOT NULL,
  workspace_id          UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  project_id            UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  deployment_target_id  UUID        NULL REFERENCES runtime_deployments.deployment_targets(id) ON DELETE SET NULL,
  status                TEXT        NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'canceled')),
  attempt_count         INTEGER     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts          INTEGER     NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  locked_at             TIMESTAMPTZ NULL,
  locked_by             TEXT        NULL,
  next_retry_at         TIMESTAMPTZ NULL,
  dead_letter_reason    TEXT        NULL,
  safe_error_code       TEXT        NULL,
  safe_error_message    TEXT        NULL,
  payload               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_gcp_provisioning_jobs_ready
  ON gcp_operations.provisioning_jobs (status, next_retry_at, created_at);

CREATE INDEX IF NOT EXISTS idx_gcp_provisioning_jobs_target
  ON gcp_operations.provisioning_jobs (deployment_target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_lifecycle.runtime_cost_summaries (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  project_id           UUID        NOT NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  deployment_target_id UUID        NULL REFERENCES runtime_deployments.deployment_targets(id) ON DELETE SET NULL,
  cost_period_start    DATE        NOT NULL,
  cost_period_end      DATE        NOT NULL,
  currency             TEXT        NOT NULL DEFAULT 'USD',
  estimated_cost_units NUMERIC(18, 6) NOT NULL DEFAULT 0,
  source               TEXT        NOT NULL CHECK (source IN ('gcp_billing_export', 'manual_adjustment', 'estimated')),
  labels               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (cost_period_end >= cost_period_start)
);

CREATE INDEX IF NOT EXISTS idx_gcp_runtime_cost_summaries_project_period
  ON billing_lifecycle.runtime_cost_summaries (project_id, cost_period_start, cost_period_end);

DROP TRIGGER IF EXISTS trg_gcp_deployment_targets_updated_at ON runtime_deployments.deployment_targets;

CREATE TRIGGER trg_gcp_deployment_targets_updated_at
  BEFORE UPDATE ON runtime_deployments.deployment_targets
  FOR EACH ROW EXECUTE FUNCTION gcp_operations.set_gcp_runtime_updated_at();

DROP TRIGGER IF EXISTS trg_gcp_domain_records_updated_at ON runtime_domains.domain_records;

CREATE TRIGGER trg_gcp_domain_records_updated_at
  BEFORE UPDATE ON runtime_domains.domain_records
  FOR EACH ROW EXECUTE FUNCTION gcp_operations.set_gcp_runtime_updated_at();

DROP TRIGGER IF EXISTS trg_gcp_secret_references_updated_at ON runtime_secrets.secret_references;

CREATE TRIGGER trg_gcp_secret_references_updated_at
  BEFORE UPDATE ON runtime_secrets.secret_references
  FOR EACH ROW EXECUTE FUNCTION gcp_operations.set_gcp_runtime_updated_at();

DROP TRIGGER IF EXISTS trg_gcp_provisioning_jobs_updated_at ON gcp_operations.provisioning_jobs;

CREATE TRIGGER trg_gcp_provisioning_jobs_updated_at
  BEFORE UPDATE ON gcp_operations.provisioning_jobs
  FOR EACH ROW EXECUTE FUNCTION gcp_operations.set_gcp_runtime_updated_at();

DROP TRIGGER IF EXISTS trg_gcp_runtime_cost_summaries_updated_at ON billing_lifecycle.runtime_cost_summaries;

CREATE TRIGGER trg_gcp_runtime_cost_summaries_updated_at
  BEFORE UPDATE ON billing_lifecycle.runtime_cost_summaries
  FOR EACH ROW EXECUTE FUNCTION gcp_operations.set_gcp_runtime_updated_at();

ALTER TABLE runtime_deployments.deployment_targets ENABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_deployments.deployment_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_domains.domain_records ENABLE ROW LEVEL SECURITY;

ALTER TABLE runtime_secrets.secret_references ENABLE ROW LEVEL SECURITY;

ALTER TABLE gcp_operations.provisioning_jobs ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_lifecycle.runtime_cost_summaries ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON runtime_deployments.deployment_targets FROM anon, authenticated;

REVOKE ALL ON runtime_deployments.deployment_attempts FROM anon, authenticated;

REVOKE ALL ON runtime_domains.domain_records FROM anon, authenticated;

REVOKE ALL ON runtime_secrets.secret_references FROM anon, authenticated;

REVOKE ALL ON gcp_operations.provisioning_jobs FROM anon, authenticated;

REVOKE ALL ON billing_lifecycle.runtime_cost_summaries FROM anon, authenticated;

COMMENT ON SCHEMA runtime_deployments IS 'GCP runtime deployment metadata. Expand-contract replacement path for legacy Vercel/Render target rows.';

COMMENT ON SCHEMA runtime_domains IS 'GCP runtime domain metadata for generated, preview, fallback, and custom domains.';

COMMENT ON SCHEMA runtime_secrets IS 'Secret Manager metadata only. Raw secret payloads are forbidden here.';

COMMENT ON SCHEMA billing_lifecycle IS 'Runtime cost and lifecycle summaries derived from labels/billing export.';

COMMENT ON SCHEMA gcp_operations IS 'Idempotent GCP provisioning, deployment, cleanup, reconciliation, and migration jobs.';

COMMENT ON TABLE runtime_secrets.secret_references
  IS 'Metadata-only Secret Manager references. This table must never contain raw secret values, database URLs, OAuth client secrets, or provider tokens.';

COMMIT;
