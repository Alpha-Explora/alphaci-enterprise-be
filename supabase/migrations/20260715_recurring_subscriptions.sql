-- Recurring subscription model.
-- Access is period-based; cancel schedules end of period; renewals extend the period.

BEGIN;

-- ─── user_subscriptions ─────────────────────────────────────────────────────

ALTER TABLE billing.user_subscriptions
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'recurring';

ALTER TABLE billing.user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_billing_mode_check;

ALTER TABLE billing.user_subscriptions
  ADD CONSTRAINT user_subscriptions_billing_mode_check
  CHECK (billing_mode IN ('recurring', 'one_time'));

ALTER TABLE billing.user_subscriptions
  ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE billing.user_subscriptions
  ADD COLUMN IF NOT EXISTS paymongo_subscription_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.user_subscriptions
  ADD COLUMN IF NOT EXISTS paymongo_customer_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.user_subscriptions
  ADD COLUMN IF NOT EXISTS next_billing_at TIMESTAMPTZ;

COMMENT ON COLUMN billing.user_subscriptions.billing_mode IS
  'recurring = auto-renewing monthly plan; one_time = non-recurring (legacy/edge).';

COMMENT ON COLUMN billing.user_subscriptions.auto_renew IS
  'When false (or cancel_at_period_end), no renewal is attempted after current_period_end.';

COMMENT ON COLUMN billing.user_subscriptions.next_billing_at IS
  'When the next renewal charge is expected. Usually equals current_period_end while active.';

COMMENT ON COLUMN billing.user_subscriptions.paymongo_subscription_id IS
  'PayMongo Subscription id (subs_…) when using native PayMongo recurring. Distinct from our payment our_reference.';

-- Active rows should renew at period end.
UPDATE billing.user_subscriptions
SET
  billing_mode = COALESCE(NULLIF(billing_mode, ''), 'recurring'),
  auto_renew = CASE
    WHEN cancel_at_period_end = true OR status IN ('canceled', 'inactive') THEN false
    ELSE true
  END,
  next_billing_at = COALESCE(next_billing_at, current_period_end)
WHERE true;

CREATE INDEX IF NOT EXISTS idx_user_subscriptions_renewal_due
  ON billing.user_subscriptions (status, next_billing_at)
  WHERE status IN ('active', 'past_due') AND auto_renew = true;

-- ─── workspace_subscriptions ────────────────────────────────────────────────

ALTER TABLE billing.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS billing_mode TEXT NOT NULL DEFAULT 'recurring';

ALTER TABLE billing.workspace_subscriptions
  DROP CONSTRAINT IF EXISTS workspace_subscriptions_billing_mode_check;

ALTER TABLE billing.workspace_subscriptions
  ADD CONSTRAINT workspace_subscriptions_billing_mode_check
  CHECK (billing_mode IN ('recurring', 'one_time'));

ALTER TABLE billing.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE billing.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS paymongo_subscription_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS paymongo_customer_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.workspace_subscriptions
  ADD COLUMN IF NOT EXISTS next_billing_at TIMESTAMPTZ;

UPDATE billing.workspace_subscriptions
SET
  billing_mode = COALESCE(NULLIF(billing_mode, ''), 'recurring'),
  auto_renew = CASE
    WHEN cancel_at_period_end = true OR status IN ('canceled', 'inactive') THEN false
    ELSE true
  END,
  next_billing_at = COALESCE(next_billing_at, current_period_end)
WHERE true;

CREATE INDEX IF NOT EXISTS idx_workspace_subscriptions_renewal_due
  ON billing.workspace_subscriptions (status, next_billing_at)
  WHERE status IN ('active', 'past_due') AND auto_renew = true;

COMMIT;
