-- Database-backed public subscription catalog.
-- Existing subscription rows keep their historical amount and legacy plan code.

BEGIN;

CREATE SCHEMA IF NOT EXISTS billing;

CREATE TABLE IF NOT EXISTS billing.subscription_plans (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  amount_php NUMERIC NOT NULL DEFAULT 0,
  interval_unit TEXT NOT NULL DEFAULT 'month'
    CHECK (interval_unit IN ('month', 'year')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE billing.subscription_plans
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE billing.subscription_plans
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE billing.subscription_plans
  ADD COLUMN IF NOT EXISTS public_code TEXT;

ALTER TABLE billing.subscription_plans
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE billing.subscription_plans
  ADD COLUMN IF NOT EXISTS public_config JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_plans_public_code
  ON billing.subscription_plans (public_code)
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
VALUES (
  'pro_monthly',
  'Solo Basic',
  399,
  'month',
  true,
  jsonb_build_object('publicPlanId', 'solo_basic'),
  'solo_basic',
  10,
  jsonb_build_object(
    'status', 'available',
    'description', 'Automated testing and security for your repos.',
    'priceLabel', 'PHP 399',
    'periodLabel', '/ month',
    'priceCompact', '₱399.00',
    'featured', true,
    'apiCode', 'pro',
    'billingCode', 'pro_monthly',
    'tagline', 'Automated testing and security for your repos.',
    'useCase', 'Side projects, freelance builds, startup MVPs',
    'whyThisPlan', 'Ship tested, error-free code today. Plus and Pro land soon.',
    'features', jsonb_build_array(
      jsonb_build_object('label', 'Frontend + backend repos', 'included', true),
      jsonb_build_object('label', 'Automated testing and lint', 'included', true),
      jsonb_build_object('label', 'Security and license audit', 'included', true),
      jsonb_build_object('label', 'DEV to UAT to MAIN flow', 'included', true),
      jsonb_build_object('label', 'Runs locally per user', 'included', true),
      jsonb_build_object('label', 'Advanced code quality', 'included', false),
      jsonb_build_object('label', 'Managed cloud hosting', 'included', false)
    ),
    'comparisonValues', jsonb_build_array(
      'PHP 399 / month',
      'Included',
      'Included',
      'Included',
      'Included',
      'Standard'
    )
  )
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount_php = EXCLUDED.amount_php,
  interval_unit = EXCLUDED.interval_unit,
  is_active = EXCLUDED.is_active,
  metadata = billing.subscription_plans.metadata || EXCLUDED.metadata,
  public_code = EXCLUDED.public_code,
  sort_order = EXCLUDED.sort_order,
  public_config = EXCLUDED.public_config,
  updated_at = NOW();

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
(
  'solo_plus_monthly',
  'Solo Plus',
  0,
  'month',
  false,
  jsonb_build_object('publicPlanId', 'solo_plus'),
  'solo_plus',
  20,
  jsonb_build_object(
    'status', 'coming_soon',
    'description', 'Adds deeper code quality controls.',
    'priceLabel', 'Coming soon',
    'periodLabel', '',
    'priceCompact', 'Coming soon',
    'featured', false,
    'apiCode', NULL,
    'billingCode', NULL,
    'tagline', 'Adds deeper code quality controls.',
    'useCase', 'Client work that needs quality gates',
    'features', jsonb_build_array(
      jsonb_build_object('label', 'Frontend + backend repos', 'included', true),
      jsonb_build_object('label', 'Automated testing and lint', 'included', true),
      jsonb_build_object('label', 'Security and license audit', 'included', true),
      jsonb_build_object('label', 'DEV to UAT to MAIN flow', 'included', true),
      jsonb_build_object('label', 'Runs locally per user', 'included', true),
      jsonb_build_object('label', 'Advanced code quality', 'included', true),
      jsonb_build_object('label', 'Managed cloud hosting', 'included', false)
    ),
    'comparisonValues', jsonb_build_array(
      'Coming soon',
      'Included',
      'Included',
      'Included',
      'Included',
      'Priority (planned)'
    )
  )
),
(
  'solo_pro_monthly',
  'Solo Pro',
  0,
  'month',
  false,
  jsonb_build_object('publicPlanId', 'solo_pro'),
  'solo_pro',
  30,
  jsonb_build_object(
    'status', 'coming_soon',
    'description', 'The full lane, plus managed cloud hosting.',
    'priceLabel', 'Coming soon',
    'periodLabel', '',
    'priceCompact', 'Coming soon',
    'featured', false,
    'apiCode', NULL,
    'billingCode', NULL,
    'tagline', 'The full lane, plus managed cloud hosting.',
    'useCase', 'Products ready to go live',
    'features', jsonb_build_array(
      jsonb_build_object('label', 'Frontend + backend repos', 'included', true),
      jsonb_build_object('label', 'Automated testing and lint', 'included', true),
      jsonb_build_object('label', 'Security and license audit', 'included', true),
      jsonb_build_object('label', 'DEV to UAT to MAIN flow', 'included', true),
      jsonb_build_object('label', 'Runs locally per user', 'included', true),
      jsonb_build_object('label', 'Advanced code quality', 'included', true),
      jsonb_build_object('label', 'Managed cloud hosting', 'included', true)
    ),
    'comparisonValues', jsonb_build_array(
      'Coming soon',
      'Included',
      'Included',
      'Included',
      'Included',
      'Priority (planned)'
    )
  )
)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  amount_php = EXCLUDED.amount_php,
  interval_unit = EXCLUDED.interval_unit,
  is_active = EXCLUDED.is_active,
  metadata = billing.subscription_plans.metadata || EXCLUDED.metadata,
  public_code = EXCLUDED.public_code,
  sort_order = EXCLUDED.sort_order,
  public_config = EXCLUDED.public_config,
  updated_at = NOW();

UPDATE billing.subscription_plans
SET is_active = false,
    updated_at = NOW()
WHERE public_code IN ('solo_plus', 'solo_pro');

COMMIT;
