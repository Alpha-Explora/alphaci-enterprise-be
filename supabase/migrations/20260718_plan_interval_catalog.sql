-- Pre-launch billing reset and interval-aware plan catalog.
-- This migration intentionally clears billing/test records only. It must never
-- be applied to a database that contains live customer billing history.

BEGIN;

CREATE TEMP TABLE prelaunch_plan_config ON COMMIT DROP AS
SELECT public_code, public_config, metadata
FROM billing.subscription_plans
WHERE public_code IN ('solo_basic', 'solo_plus', 'solo_pro');

-- Dependency order: refunds depend on payment attempts.
DELETE FROM billing.payment_refunds;

DELETE FROM billing.payment_webhook_events;

DELETE FROM billing.payment_attempts;

DELETE FROM billing.workspace_subscriptions;

DELETE FROM billing.user_subscriptions;

DELETE FROM billing.billing_profiles;

DELETE FROM billing.subscription_plans;

ALTER TABLE billing.subscription_plans
  ALTER COLUMN amount_php DROP NOT NULL;

DROP INDEX IF EXISTS billing.uq_subscription_plans_public_code;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_plans_public_interval
  ON billing.subscription_plans (public_code, interval_unit)
  WHERE public_code IS NOT NULL;

INSERT INTO billing.subscription_plans (
  code,
  name,
  amount_php,
  interval_unit,
  is_active,
  metadata,
  public_code,
  sort_order,
  public_config
)
VALUES
  ('solo_basic_monthly', 'Solo Basic', 399, 'month', true,
   jsonb_build_object('publicPlanId', 'solo_basic'), 'solo_basic', 10,
   jsonb_build_object('status', 'available', 'priceLabel', 'PHP 399',
     'periodLabel', '/ month', 'priceCompact', 'PHP 399.00',
     'billingCode', 'solo_basic_monthly')),
  ('solo_basic_yearly', 'Solo Basic', 4188, 'year', true,
   jsonb_build_object('publicPlanId', 'solo_basic'), 'solo_basic', 10,
   jsonb_build_object('status', 'available', 'priceLabel', 'PHP 4,188',
     'periodLabel', '/ year', 'priceCompact', 'PHP 4,188.00',
     'billingCode', 'solo_basic_yearly')),
  ('solo_plus_monthly', 'Solo Plus', NULL, 'month', false,
   jsonb_build_object('publicPlanId', 'solo_plus'), 'solo_plus', 20,
   jsonb_build_object('status', 'coming_soon', 'priceLabel', 'Coming soon',
     'periodLabel', '', 'priceCompact', 'Coming soon',
     'billingCode', NULL)),
  ('solo_plus_yearly', 'Solo Plus', NULL, 'year', false,
   jsonb_build_object('publicPlanId', 'solo_plus'), 'solo_plus', 20,
   jsonb_build_object('status', 'coming_soon', 'priceLabel', 'Coming soon',
     'periodLabel', '', 'priceCompact', 'Coming soon',
     'billingCode', NULL)),
  ('solo_pro_monthly', 'Solo Pro', NULL, 'month', false,
   jsonb_build_object('publicPlanId', 'solo_pro'), 'solo_pro', 30,
   jsonb_build_object('status', 'coming_soon', 'priceLabel', 'Coming soon',
     'periodLabel', '', 'priceCompact', 'Coming soon',
     'billingCode', NULL)),
  ('solo_pro_yearly', 'Solo Pro', NULL, 'year', false,
   jsonb_build_object('publicPlanId', 'solo_pro'), 'solo_pro', 30,
   jsonb_build_object('status', 'coming_soon', 'priceLabel', 'Coming soon',
     'periodLabel', '', 'priceCompact', 'Coming soon',
     'billingCode', NULL));

-- Preserve descriptive copy/features from the pre-launch catalog while removing
-- legacy apiCode/billingCode values and writing the generated billing code.
UPDATE billing.subscription_plans current_plan
SET metadata = COALESCE(previous.metadata, current_plan.metadata),
    public_config = COALESCE(previous.public_config, '{}'::jsonb)
      - 'apiCode' - 'billingCode'
      || current_plan.public_config
      || jsonb_build_object(
        'billingCode', CASE WHEN current_plan.is_active THEN current_plan.code ELSE NULL END,
        'priceLabel', CASE
          WHEN current_plan.code = 'solo_basic_monthly' THEN 'PHP 399'
          WHEN current_plan.code = 'solo_basic_yearly' THEN 'PHP 4,188'
          ELSE 'Coming soon'
        END,
        'periodLabel', CASE
          WHEN current_plan.interval_unit = 'month' THEN '/ month'
          WHEN current_plan.interval_unit = 'year' AND current_plan.is_active THEN '/ year'
          ELSE ''
        END,
        'priceCompact', CASE
          WHEN current_plan.code = 'solo_basic_monthly' THEN 'PHP 399.00'
          WHEN current_plan.code = 'solo_basic_yearly' THEN 'PHP 4,188.00'
          ELSE 'Coming soon'
        END
      ),
    updated_at = NOW()
FROM prelaunch_plan_config previous
WHERE previous.public_code = current_plan.public_code;

COMMIT;
