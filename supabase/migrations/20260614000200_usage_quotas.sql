CREATE SCHEMA IF NOT EXISTS usage;

CREATE TABLE IF NOT EXISTS usage.plan_limits (
  plan_code TEXT NOT NULL,
  limit_code TEXT NOT NULL,
  limit_value INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (plan_code, limit_code)
);

CREATE TABLE IF NOT EXISTS usage.project_usage_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID NULL REFERENCES projects.provisioned_projects(id) ON DELETE CASCADE,
  counter_code TEXT NOT NULL,
  counter_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_usage_counters_user_code
  ON usage.project_usage_counters(user_id, counter_code);

CREATE TABLE IF NOT EXISTS usage.usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  project_id UUID NULL REFERENCES projects.provisioned_projects(id) ON DELETE SET NULL,
  event_code TEXT NOT NULL,
  amount INTEGER NOT NULL DEFAULT 1,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
  ON usage.usage_events(user_id, created_at DESC);
