-- ─── Remove the payment gateway ──────────────────────────────────────────────
--
-- This deployment is contract-billed: entitlement is agreed commercially and
-- granted administratively, so the product never collects a payment. The
-- PayMongo integration (hosted checkout, provider webhooks, card vaulting) has
-- been removed from the application, and this migration drops the schema that
-- existed only to serve it.
--
-- DROPPED — gateway plumbing, no application reader remains:
--   billing.payment_attempts        settlement attempts against the provider
--   billing.payment_refunds         provider-issued refunds
--   billing.payment_webhook_events  provider webhook delivery ledger
--   billing.billing_profiles.*      the vaulted card columns (20260716000000)
--
-- KEPT — entitlement, which contract billing still needs:
--   billing.subscription_plans      plan catalogue
--   billing.user_subscriptions      per-user entitlement; read by CI run
--                                   validation and the usage quota service
--   billing.workspace_subscriptions per-workspace entitlement
--   billing.billing_profiles        the profile row itself
--
-- Earlier migrations are deliberately left untouched. 20260714_payment_ledger
-- interleaves these tables with ALTERs to user_subscriptions and
-- workspace_subscriptions that 20260715 then builds on, so the history is not
-- separable — this rolls forward instead of rewriting it.
--
-- Idempotent: re-running is a normal recovery step.

BEGIN;

-- payment_refunds references payment_attempts, so it goes first.
DROP TABLE IF EXISTS billing.payment_refunds;
DROP TABLE IF EXISTS billing.payment_attempts;
DROP TABLE IF EXISTS billing.payment_webhook_events;

-- Card vaulting existed only to let the gateway charge off-session.
DROP INDEX IF EXISTS billing.idx_billing_profiles_vaulted;

ALTER TABLE billing.billing_profiles
  DROP CONSTRAINT IF EXISTS billing_profiles_vault_status_check;

ALTER TABLE billing.billing_profiles
  DROP COLUMN IF EXISTS paymongo_customer_id;

ALTER TABLE billing.billing_profiles
  DROP COLUMN IF EXISTS paymongo_default_payment_method_id;

ALTER TABLE billing.billing_profiles
  DROP COLUMN IF EXISTS vault_status;

ALTER TABLE billing.billing_profiles
  DROP COLUMN IF EXISTS vaulted_at;

COMMIT;
