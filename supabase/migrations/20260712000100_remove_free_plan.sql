-- Remove the free subscription tier. Existing free rows are converted to
-- canceled Starter records so they no longer grant access without payment.
BEGIN;

UPDATE billing.user_subscriptions
SET
  plan = 'pro',
  plan_code = 'pro_monthly',
  status = CASE WHEN status = 'active' THEN 'canceled' ELSE status END,
  amount_php = 399,
  cancel_at_period_end = CASE WHEN status = 'active' THEN true ELSE cancel_at_period_end END,
  canceled_at = CASE WHEN status = 'active' THEN COALESCE(canceled_at, NOW()) ELSE canceled_at END,
  updated_at = NOW()
WHERE plan = 'free' OR plan_code = 'free';

DELETE FROM billing.subscription_plans
WHERE code = 'free';

COMMIT;
