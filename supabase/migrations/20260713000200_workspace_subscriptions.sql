-- Per-organization (workspace) subscriptions.
-- Account-level billing.user_subscriptions remains for the primary personal plan.
-- Each team organization created after paid checkout gets its own workspace subscription.

BEGIN;

CREATE TABLE IF NOT EXISTS billing.workspace_subscriptions (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  workspace_id          UUID        NOT NULL REFERENCES orgs.workspaces(id) ON DELETE CASCADE,
  payer_user_id         UUID        NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  plan                  TEXT        NOT NULL DEFAULT 'pro',
  plan_code             TEXT        NOT NULL DEFAULT 'pro_monthly',
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

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_workspace_created
  ON billing.workspace_subscriptions (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_payer
  ON billing.workspace_subscriptions (payer_user_id, created_at DESC);

COMMENT ON TABLE billing.workspace_subscriptions IS
  'Append-style subscription history per organization/workspace. Latest row is current.';

-- Backfill: active personal workspaces inherit the owner's latest active account subscription.
INSERT INTO billing.workspace_subscriptions (
  workspace_id,
  payer_user_id,
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
  w.id,
  w.owner_user_id,
  COALESCE(s.plan, 'pro'),
  COALESCE(s.plan_code, 'pro_monthly'),
  COALESCE(s.status, 'inactive'),
  COALESCE(s.provider, 'supabase'),
  COALESCE(s.amount_php, 399),
  COALESCE(s.interval_unit, 'month'),
  s.current_period_start,
  s.current_period_end,
  COALESCE(s.cancel_at_period_end, false),
  s.canceled_at,
  jsonb_build_object('source', 'backfill_from_user_subscriptions'),
  COALESCE(s.created_at, w.created_at),
  COALESCE(s.updated_at, NOW())
FROM orgs.workspaces w
JOIN identity.app_users u
  ON u.id = w.owner_user_id
LEFT JOIN LATERAL (
  SELECT *
  FROM billing.user_subscriptions us
  WHERE us.user_id = w.owner_user_id
  ORDER BY us.created_at DESC
  LIMIT 1
) s ON true
WHERE w.kind = 'personal'
  AND NOT EXISTS (
    SELECT 1
    FROM billing.workspace_subscriptions ws
    WHERE ws.workspace_id = w.id
  );

ALTER TABLE billing.workspace_subscriptions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON billing.workspace_subscriptions FROM anon, authenticated;

COMMIT;
