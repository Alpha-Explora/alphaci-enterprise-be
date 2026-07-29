-- Migration: domain_schema_bootstrap
-- Purpose: Bootstrap the domain schemas required by the namespace migrations.
-- The older public tables are retained until 20260609 backfills them into these
-- schemas and removes the legacy public copies.

BEGIN;

CREATE SCHEMA IF NOT EXISTS identity;

CREATE SCHEMA IF NOT EXISTS projects;

CREATE SCHEMA IF NOT EXISTS billing;

CREATE SCHEMA IF NOT EXISTS workflow;

CREATE SCHEMA IF NOT EXISTS github_app;

CREATE SCHEMA IF NOT EXISTS platform;

CREATE TABLE IF NOT EXISTS identity.app_users (
  id              UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  github_user_id  TEXT        UNIQUE,
  google_user_id  TEXT        UNIQUE,
  login           TEXT        NOT NULL,
  display_name    TEXT,
  email           TEXT,
  avatar_url      TEXT,
  provider        TEXT        NOT NULL DEFAULT 'github',
  is_dummy        BOOLEAN     NOT NULL DEFAULT false,
  metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_app_users_login
  ON identity.app_users (login);

CREATE TABLE IF NOT EXISTS projects.provisioned_projects (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  repo_full_name        TEXT        NOT NULL,
  template_id           TEXT        NOT NULL,
  service_name          TEXT        NOT NULL,
  workflow_path         TEXT        NOT NULL,
  workflow_sha256       TEXT,
  workflow_content_sha  TEXT,
  github_commit_sha     TEXT,
  github_commit_url     TEXT,
  status                TEXT        NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'provisioned', 'failed', 'orphaned')),
  failure_reason        TEXT,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  provisioned_at        TIMESTAMPTZ,
  failed_at             TIMESTAMPTZ,
  owner_login           TEXT,
  repo_name             TEXT,
  github_repository_url TEXT,
  visibility            TEXT,
  repo_shape            TEXT,
  project_type_id       TEXT,
  workflow_recipe_id    TEXT,
  workflow_template_id  TEXT,
  project_options       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_provisioned_projects_user_id
  ON projects.provisioned_projects (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing.subscription_plans (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code          TEXT        NOT NULL UNIQUE,
  name          TEXT        NOT NULL,
  amount_php    NUMERIC     NOT NULL DEFAULT 0,
  interval_unit TEXT        NOT NULL DEFAULT 'month'
    CHECK (interval_unit IN ('month', 'year')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing.user_subscriptions (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id               UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  plan                  TEXT        NOT NULL,
  plan_code             TEXT        NOT NULL,
  status                TEXT        NOT NULL DEFAULT 'inactive'
    CHECK (status IN ('inactive', 'active', 'canceled')),
  provider              TEXT        NOT NULL DEFAULT 'supabase'
    CHECK (provider IN ('supabase', 'manual', 'mock', 'paymongo')),
  amount_php            NUMERIC     NOT NULL DEFAULT 0,
  interval_unit         TEXT        NOT NULL DEFAULT 'month'
    CHECK (interval_unit IN ('month', 'year')),
  current_period_start  TIMESTAMPTZ,
  current_period_end    TIMESTAMPTZ,
  cancel_at_period_end  BOOLEAN     NOT NULL DEFAULT false,
  canceled_at           TIMESTAMPTZ,
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS billing.subscription_events (
  id         UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID        REFERENCES identity.app_users(id) ON DELETE SET NULL,
  event_type TEXT,
  payload    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS workflow.workflow_generations (
  id                     UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id                UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  template_id            TEXT        NOT NULL,
  template_name          TEXT        NOT NULL,
  stack                  TEXT        NOT NULL,
  service_name           TEXT        NOT NULL,
  output_file_name       TEXT        NOT NULL,
  source_workflow_file   TEXT        NOT NULL DEFAULT '',
  source_properties_file TEXT        NOT NULL DEFAULT '',
  line_count             INTEGER     NOT NULL DEFAULT 0,
  yaml                   TEXT        NOT NULL DEFAULT '',
  sha256                 TEXT        NOT NULL DEFAULT '',
  metadata               JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_generations_user_id
  ON workflow.workflow_generations (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS github_app.github_installation_accounts (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  installation_id      BIGINT      NOT NULL,
  account_login        TEXT,
  account_id           BIGINT,
  repository_selection TEXT        NOT NULL DEFAULT 'selected'
    CHECK (repository_selection IN ('all', 'selected')),
  permissions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  events               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  installed_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, installation_id)
);

CREATE TABLE IF NOT EXISTS github_app.github_installations (
  id                   UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id              UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  installation_id      BIGINT      NOT NULL,
  repo_full_name       TEXT        NOT NULL,
  account_login        TEXT,
  account_id           BIGINT,
  repository_selection TEXT        NOT NULL DEFAULT 'selected'
    CHECK (repository_selection IN ('all', 'selected')),
  permissions          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  events               JSONB       NOT NULL DEFAULT '[]'::jsonb,
  installed_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, installation_id, repo_full_name)
);

CREATE TABLE IF NOT EXISTS platform.outbox_events (
  id             UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  topic          TEXT        NOT NULL,
  aggregate_type TEXT        NOT NULL,
  aggregate_id   TEXT        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT        NOT NULL DEFAULT 'pending',
  attempts       INTEGER     NOT NULL DEFAULT 0,
  available_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
