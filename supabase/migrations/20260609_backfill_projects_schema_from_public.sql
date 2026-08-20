-- Migration: migrate_legacy_public_schema
-- Copies legacy public-schema data into separated service schemas, then drops
-- the legacy public tables. The whole migration is transactional.

BEGIN;

ALTER TABLE projects.provisioned_projects
  DROP CONSTRAINT IF EXISTS provisioned_projects_status_check;

ALTER TABLE projects.provisioned_projects
  ADD CONSTRAINT provisioned_projects_status_check
  CHECK (status IN ('provisioning', 'provisioned', 'failed', 'orphaned'));

ALTER TABLE billing.user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_provider_check;

ALTER TABLE billing.user_subscriptions
  ADD CONSTRAINT user_subscriptions_provider_check
  CHECK (provider IN ('supabase', 'manual', 'mock', 'paymongo'));

CREATE TABLE IF NOT EXISTS identity.oauth_states (
  state       TEXT        NOT NULL PRIMARY KEY,
  return_to   TEXT        NOT NULL DEFAULT '/',
  provider    TEXT        NOT NULL DEFAULT 'github',
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes'),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identity_oauth_states_expires_at
  ON identity.oauth_states (expires_at);

CREATE OR REPLACE FUNCTION identity.clean_expired_oauth_states()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM identity.oauth_states WHERE expires_at <= NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

INSERT INTO identity.app_users (
  id,
  github_user_id,
  google_user_id,
  login,
  display_name,
  email,
  avatar_url,
  provider,
  is_dummy,
  metadata,
  last_login_at,
  created_at,
  updated_at
)
SELECT
  u.id,
  u.github_user_id,
  NULL::TEXT,  -- public.app_users predates Google federation
  u.login,
  u.display_name,
  u.email,
  u.avatar_url,
  COALESCE(NULLIF(u.provider, ''), 'github'),
  u.is_dummy,
  jsonb_build_object('source', 'legacy_public_app_users_backfill'),
  u.last_login_at,
  u.created_at,
  u.updated_at
FROM public.app_users u
WHERE NOT EXISTS (
  SELECT 1
  FROM identity.app_users iu
  WHERE lower(iu.login) = lower(u.login)
);

UPDATE identity.app_users iu
SET
  github_user_id = COALESCE(iu.github_user_id, pu.github_user_id),
  display_name = COALESCE(iu.display_name, pu.display_name),
  email = COALESCE(iu.email, pu.email),
  avatar_url = COALESCE(iu.avatar_url, pu.avatar_url),
  updated_at = GREATEST(iu.updated_at, pu.updated_at)
FROM public.app_users pu
WHERE lower(iu.login) = lower(pu.login);

INSERT INTO identity.oauth_states (
  state,
  return_to,
  provider,
  expires_at,
  created_at
)
SELECT
  state,
  return_to,
  provider,
  expires_at,
  NOW()
FROM public.oauth_states
ON CONFLICT (state) DO UPDATE SET
  return_to = EXCLUDED.return_to,
  provider = EXCLUDED.provider,
  expires_at = EXCLUDED.expires_at,
  created_at = EXCLUDED.created_at;

INSERT INTO billing.subscription_plans (
  code,
  name,
  amount_php,
  interval_unit,
  is_active,
  metadata,
  created_at,
  updated_at
)
SELECT
  p.code,
  p.name,
  GREATEST(0, round(p.amount_php)::integer),
  CASE WHEN p.interval_unit IN ('month', 'year') THEN p.interval_unit ELSE 'month' END,
  true,
  jsonb_build_object(
    'source', 'legacy_public_subscription_plans_backfill',
    'legacyPlanId', p.id
  ),
  p.created_at,
  p.updated_at
FROM public.subscription_plans p
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount_php = EXCLUDED.amount_php,
  interval_unit = EXCLUDED.interval_unit,
  is_active = true,
  metadata = billing.subscription_plans.metadata || EXCLUDED.metadata,
  updated_at = GREATEST(billing.subscription_plans.updated_at, EXCLUDED.updated_at);

INSERT INTO billing.user_subscriptions (
  id,
  user_id,
  plan,
  plan_code,
  status,
  provider,
  amount_php,
  interval_unit,
  current_period_start,
  current_period_end,
  cancel_at_period_end,
  canceled_at,
  metadata,
  created_at,
  updated_at
)
SELECT
  s.id,
  iu.id,
  CASE WHEN s.plan IN ('free', 'pro', 'enterprise') THEN s.plan ELSE 'free' END,
  CASE
    WHEN s.plan_code IN (SELECT code FROM billing.subscription_plans) THEN s.plan_code
    WHEN s.plan = 'pro' THEN 'pro_monthly'
    ELSE 'free'
  END,
  CASE
    WHEN s.status NOT IN ('inactive', 'active', 'canceled') THEN 'inactive'
    WHEN s.status <> 'active' THEN s.status
    WHEN row_number() OVER (
      PARTITION BY iu.id, s.status
      ORDER BY s.created_at DESC, s.id DESC
    ) > 1 THEN 'canceled'
    WHEN EXISTS (
      SELECT 1
      FROM billing.user_subscriptions existing
      WHERE existing.user_id = iu.id
        AND existing.status = 'active'
        AND existing.id <> s.id
    ) THEN 'canceled'
    ELSE 'active'
  END,
  CASE WHEN s.provider IN ('supabase', 'manual', 'mock', 'paymongo') THEN s.provider ELSE 'manual' END,
  GREATEST(0, round(s.amount_php)::integer),
  CASE WHEN s.interval_unit IN ('month', 'year') THEN s.interval_unit ELSE 'month' END,
  s.current_period_start,
  s.current_period_end,
  s.cancel_at_period_end,
  s.canceled_at,
  COALESCE(s.metadata, '{}'::jsonb) || jsonb_build_object(
    'source', 'legacy_public_user_subscriptions_backfill',
    'legacyUserId', s.user_id
  ),
  s.created_at,
  s.updated_at
FROM public.user_subscriptions s
JOIN public.app_users pu ON pu.id::text = s.user_id::text
JOIN identity.app_users iu ON lower(iu.login) = lower(pu.login)
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  plan = EXCLUDED.plan,
  plan_code = EXCLUDED.plan_code,
  status = EXCLUDED.status,
  provider = EXCLUDED.provider,
  amount_php = EXCLUDED.amount_php,
  interval_unit = EXCLUDED.interval_unit,
  current_period_start = EXCLUDED.current_period_start,
  current_period_end = EXCLUDED.current_period_end,
  cancel_at_period_end = EXCLUDED.cancel_at_period_end,
  canceled_at = EXCLUDED.canceled_at,
  metadata = billing.user_subscriptions.metadata || EXCLUDED.metadata,
  updated_at = GREATEST(billing.user_subscriptions.updated_at, EXCLUDED.updated_at);

INSERT INTO workflow.workflow_generations (
  id,
  user_id,
  template_id,
  template_name,
  stack,
  service_name,
  output_file_name,
  source_workflow_file,
  source_properties_file,
  line_count,
  yaml,
  sha256,
  metadata,
  created_at,
  updated_at
)
SELECT
  w.id,
  iu.id,
  w.template_id,
  w.template_name,
  w.stack,
  w.service_name,
  w.output_file_name,
  w.source_workflow_file,
  w.source_properties_file,
  GREATEST(0, w.line_count),
  w.yaml,
  CASE
    WHEN w.sha256 ~ '^[a-f0-9]{64}$' THEN w.sha256::char(64)
    ELSE (
      md5(concat_ws(':', w.id::text, w.template_id, w.service_name, '1')) ||
      md5(concat_ws(':', w.id::text, w.template_id, w.service_name, '2'))
    )::char(64)
  END,
  COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
    'source', 'legacy_public_workflow_generations_backfill',
    'legacyUserId', w.user_id
  ),
  w.created_at,
  w.created_at
FROM public.workflow_generations w
JOIN public.app_users pu ON pu.id::text = w.user_id::text
JOIN identity.app_users iu ON lower(iu.login) = lower(pu.login)
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  template_id = EXCLUDED.template_id,
  template_name = EXCLUDED.template_name,
  stack = EXCLUDED.stack,
  service_name = EXCLUDED.service_name,
  output_file_name = EXCLUDED.output_file_name,
  source_workflow_file = EXCLUDED.source_workflow_file,
  source_properties_file = EXCLUDED.source_properties_file,
  line_count = EXCLUDED.line_count,
  yaml = EXCLUDED.yaml,
  sha256 = EXCLUDED.sha256,
  metadata = workflow.workflow_generations.metadata || EXCLUDED.metadata,
  updated_at = GREATEST(workflow.workflow_generations.updated_at, EXCLUDED.updated_at);

INSERT INTO projects.provisioned_projects (
  id,
  user_id,
  repo_full_name,
  template_id,
  service_name,
  workflow_path,
  workflow_sha256,
  workflow_content_sha,
  github_commit_sha,
  github_commit_url,
  status,
  failure_reason,
  metadata,
  provisioned_at,
  failed_at,
  owner_login,
  repo_name,
  github_repository_url,
  visibility,
  repo_shape,
  project_type_id,
  workflow_recipe_id,
  workflow_template_id,
  project_options,
  created_at,
  updated_at
)
SELECT
  p.id,
  iu.id,
  p.repo_full_name,
  p.template_id,
  p.service_name,
  p.workflow_path,
  (
    md5(concat_ws(':', p.id::text, p.repo_full_name, p.workflow_path, p.github_commit_sha, '1')) ||
    md5(concat_ws(':', p.id::text, p.repo_full_name, p.workflow_path, p.github_commit_sha, '2'))
  )::char(64),
  p.github_commit_sha,
  p.github_commit_sha,
  p.github_commit_url,
  CASE
    WHEN p.status IN ('provisioning', 'provisioned', 'failed', 'orphaned') THEN p.status
    ELSE 'provisioned'
  END,
  p.failure_reason,
  jsonb_build_object(
    'source', 'legacy_public_provisioned_projects_backfill',
    'legacyUserId', p.user_id,
    'repoUrl', p.repo_url
  ),
  CASE WHEN p.status = 'provisioned' THEN p.created_at ELSE NULL END,
  CASE WHEN p.status = 'failed' THEN p.updated_at ELSE NULL END,
  NULLIF(split_part(p.repo_full_name, '/', 1), ''),
  NULLIF(split_part(p.repo_full_name, '/', 2), ''),
  p.repo_url,
  CASE WHEN p.visibility IN ('private', 'public') THEN p.visibility ELSE NULL END,
  p.repo_shape,
  p.project_type_id,
  p.workflow_recipe_id,
  p.template_id,
  COALESCE(p.project_options, '{}'::jsonb),
  p.created_at,
  p.updated_at
FROM public.provisioned_projects p
JOIN public.app_users pu ON pu.id::text = p.user_id::text
JOIN identity.app_users iu ON lower(iu.login) = lower(pu.login)
ON CONFLICT (id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  repo_full_name = EXCLUDED.repo_full_name,
  template_id = EXCLUDED.template_id,
  service_name = EXCLUDED.service_name,
  workflow_path = EXCLUDED.workflow_path,
  workflow_sha256 = EXCLUDED.workflow_sha256,
  workflow_content_sha = EXCLUDED.workflow_content_sha,
  github_commit_sha = EXCLUDED.github_commit_sha,
  github_commit_url = EXCLUDED.github_commit_url,
  status = EXCLUDED.status,
  failure_reason = EXCLUDED.failure_reason,
  metadata = projects.provisioned_projects.metadata || EXCLUDED.metadata,
  provisioned_at = COALESCE(projects.provisioned_projects.provisioned_at, EXCLUDED.provisioned_at),
  failed_at = COALESCE(projects.provisioned_projects.failed_at, EXCLUDED.failed_at),
  owner_login = EXCLUDED.owner_login,
  repo_name = EXCLUDED.repo_name,
  github_repository_url = EXCLUDED.github_repository_url,
  visibility = EXCLUDED.visibility,
  repo_shape = EXCLUDED.repo_shape,
  project_type_id = EXCLUDED.project_type_id,
  workflow_recipe_id = EXCLUDED.workflow_recipe_id,
  workflow_template_id = EXCLUDED.workflow_template_id,
  project_options = EXCLUDED.project_options,
  updated_at = GREATEST(projects.provisioned_projects.updated_at, EXCLUDED.updated_at);

DO $backfill_ci_tokens$
BEGIN
  -- Only a legacy database has a public copy; a fresh replay does not.
  IF to_regclass('public.project_ci_tokens') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO ci.project_ci_tokens (
    id,
    project_id,
    token_hash,
    token_prefix,
    status,
    revoked_at,
    created_at,
    updated_at
  )
  SELECT
    t.id,
    t.project_id,
    t.token_hash,
    t.token_prefix,
    CASE WHEN t.status IN ('active', 'revoked') THEN t.status ELSE 'revoked' END,
    t.revoked_at,
    t.created_at,
    t.updated_at
  FROM public.project_ci_tokens t
  JOIN projects.provisioned_projects p ON p.id = t.project_id
  ON CONFLICT (project_id) DO UPDATE SET
    token_hash = EXCLUDED.token_hash,
    token_prefix = EXCLUDED.token_prefix,
    status = EXCLUDED.status,
    revoked_at = EXCLUDED.revoked_at,
    updated_at = GREATEST(ci.project_ci_tokens.updated_at, EXCLUDED.updated_at);
END
$backfill_ci_tokens$;

INSERT INTO github_app.github_installation_accounts (
  user_id,
  installation_id,
  account_login,
  account_id,
  repository_selection,
  permissions,
  events,
  installed_at,
  created_at,
  updated_at
)
SELECT
  iu.id,
  gi.installation_id,
  gi.account_login,
  gi.account_id,
  CASE WHEN gi.repository_selection IN ('all', 'selected') THEN gi.repository_selection ELSE 'selected' END,
  '{}'::jsonb,
  '[]'::jsonb,
  gi.created_at,
  gi.created_at,
  gi.updated_at
FROM public.github_installations gi
JOIN public.app_users pu ON pu.id::text = gi.user_id::text
JOIN identity.app_users iu ON lower(iu.login) = lower(pu.login)
ON CONFLICT (user_id, installation_id) DO UPDATE SET
  account_login = EXCLUDED.account_login,
  account_id = EXCLUDED.account_id,
  repository_selection = EXCLUDED.repository_selection,
  updated_at = GREATEST(github_app.github_installation_accounts.updated_at, EXCLUDED.updated_at);

INSERT INTO github_app.github_installations (
  user_id,
  installation_id,
  repo_full_name,
  account_login,
  account_id,
  repository_selection,
  permissions,
  events,
  installed_at,
  created_at,
  updated_at
)
SELECT
  iu.id,
  gi.installation_id,
  gr.repo_full_name,
  gi.account_login,
  gi.account_id,
  CASE WHEN gi.repository_selection IN ('all', 'selected') THEN gi.repository_selection ELSE 'selected' END,
  '{}'::jsonb,
  '[]'::jsonb,
  gi.created_at,
  gr.created_at,
  GREATEST(gi.updated_at, gr.created_at)
FROM public.github_installation_repos gr
JOIN public.github_installations gi ON gi.installation_id = gr.installation_id
JOIN public.app_users pu ON pu.id::text = gi.user_id::text
JOIN identity.app_users iu ON lower(iu.login) = lower(pu.login)
ON CONFLICT DO NOTHING;

INSERT INTO platform.outbox_events (
  topic,
  aggregate_type,
  aggregate_id,
  payload,
  status,
  attempts,
  available_at,
  published_at,
  created_at,
  updated_at
)
SELECT
  o.topic,
  o.aggregate_type,
  o.aggregate_id,
  COALESCE(o.payload, '{}'::jsonb) || jsonb_build_object(
    'source', 'legacy_public_outbox_events_backfill',
    'legacyPublicOutboxId', o.id
  ),
  CASE
    WHEN o.status = 'published' THEN 'published'
    WHEN o.status = 'failed' THEN 'failed'
    ELSE 'pending'
  END,
  0,
  o.created_at,
  o.processed_at,
  o.created_at,
  COALESCE(o.processed_at, o.created_at)
FROM public.outbox_events o
WHERE NOT EXISTS (
  SELECT 1
  FROM platform.outbox_events existing
  WHERE existing.payload ->> 'legacyPublicOutboxId' = o.id::text
);

DROP TABLE IF EXISTS public.project_ci_tokens;
DROP TABLE IF EXISTS public.provisioned_projects;
DROP TABLE IF EXISTS public.workflow_generations;
DROP TABLE IF EXISTS public.user_subscriptions;
DROP TABLE IF EXISTS public.subscription_plans;
DROP TABLE IF EXISTS public.github_installation_repos;
DROP TABLE IF EXISTS public.github_installations;
DROP TABLE IF EXISTS public.oauth_states;
DROP TABLE IF EXISTS public.outbox_events;
DROP TABLE IF EXISTS public.session;
DROP TABLE IF EXISTS public.app_users;

COMMIT;
