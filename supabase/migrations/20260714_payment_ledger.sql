-- Payment ledger: merchant reference ≠ PayMongo reference.
-- Stores payment attempts, webhook idempotency, refunds, and recurring/dunning fields.

BEGIN;

-- ─── past_due for dunning / failed renewals ─────────────────────────────────

ALTER TABLE billing.user_subscriptions
  DROP CONSTRAINT IF EXISTS user_subscriptions_status_check;

ALTER TABLE billing.user_subscriptions
  ADD CONSTRAINT user_subscriptions_status_check
  CHECK (status IN ('inactive', 'active', 'canceled', 'past_due'));

ALTER TABLE billing.workspace_subscriptions
  DROP CONSTRAINT IF EXISTS workspace_subscriptions_status_check;

ALTER TABLE billing.workspace_subscriptions
  ADD CONSTRAINT workspace_subscriptions_status_check
  CHECK (status IN ('inactive', 'active', 'canceled', 'past_due'));

-- Optional PayMongo Customer id for future saved-method / recurring charges.
ALTER TABLE billing.billing_profiles
  ADD COLUMN IF NOT EXISTS paymongo_customer_id TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN billing.billing_profiles.paymongo_customer_id IS
  'PayMongo Customer resource id (cus_…). Empty until recurring/saved methods are enabled.';

-- ─── payment_attempts ───────────────────────────────────────────────────────
-- One row per charge attempt. our_reference is AlphaCI-owned and must never equal
-- PayMongo pi_/cs_/pay_ ids.

CREATE TABLE IF NOT EXISTS billing.payment_attempts (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  our_reference               TEXT        NOT NULL,
  user_id                     UUID        NOT NULL
    REFERENCES identity.app_users(id) ON DELETE CASCADE,
  workspace_id                UUID
    REFERENCES orgs.workspaces(id) ON DELETE SET NULL,
  purpose                     TEXT        NOT NULL DEFAULT 'subscribe'
    CHECK (purpose IN (
      'subscribe',
      'new-organization',
      'renewal',
      'update-payment'
    )),
  plan_code                   TEXT        NOT NULL DEFAULT 'pro_monthly',
  amount_php                  NUMERIC     NOT NULL DEFAULT 0,
  currency                    TEXT        NOT NULL DEFAULT 'PHP',
  status                      TEXT        NOT NULL DEFAULT 'created'
    CHECK (status IN (
      'created',
      'processing',
      'succeeded',
      'failed',
      'canceled',
      'refunded',
      'partially_refunded'
    )),
  provider                    TEXT        NOT NULL DEFAULT 'paymongo'
    CHECK (provider IN ('paymongo', 'manual', 'mock')),
  -- PayMongo-owned ids (distinct from our_reference)
  paymongo_payment_intent_id  TEXT,
  paymongo_checkout_id        TEXT,
  paymongo_payment_id         TEXT,
  -- Links after successful fulfill
  user_subscription_id        UUID,
  workspace_subscription_id   UUID,
  organization_name           TEXT        NOT NULL DEFAULT '',
  failure_code                TEXT        NOT NULL DEFAULT '',
  failure_message             TEXT        NOT NULL DEFAULT '',
  receipt_number              TEXT        NOT NULL DEFAULT '',
  paid_at                     TIMESTAMPTZ,
  refunded_amount_php         NUMERIC     NOT NULL DEFAULT 0,
  metadata                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_attempts_our_reference_unique UNIQUE (our_reference),
  CONSTRAINT payment_attempts_pi_unique
    UNIQUE (paymongo_payment_intent_id),
  CONSTRAINT payment_attempts_cs_unique
    UNIQUE (paymongo_checkout_id),
  CONSTRAINT payment_attempts_pay_unique
    UNIQUE (paymongo_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_user_created
  ON billing.payment_attempts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_attempts_workspace_created
  ON billing.payment_attempts (workspace_id, created_at DESC)
  WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_attempts_status
  ON billing.payment_attempts (status, created_at DESC);

COMMENT ON TABLE billing.payment_attempts IS
  'Charge attempts. our_reference is merchant-owned; paymongo_* are provider-owned.';

COMMENT ON COLUMN billing.payment_attempts.our_reference IS
  'AlphaCI merchant reference (e.g. ACI-20260714-A1B2C3D4). Never a PayMongo id.';

COMMENT ON COLUMN billing.payment_attempts.paymongo_payment_intent_id IS
  'PayMongo PaymentIntent id (pi_…). Distinct from our_reference.';

COMMENT ON COLUMN billing.payment_attempts.paymongo_checkout_id IS
  'PayMongo Checkout Session id (cs_…). Distinct from our_reference.';

COMMENT ON COLUMN billing.payment_attempts.paymongo_payment_id IS
  'PayMongo Payment id (pay_…). Set after settlement.';

-- ─── payment_webhook_events (idempotency) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS billing.payment_webhook_events (
  id                          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  provider                    TEXT        NOT NULL DEFAULT 'paymongo',
  event_id                    TEXT        NOT NULL,
  event_type                  TEXT        NOT NULL DEFAULT '',
  our_reference               TEXT        NOT NULL DEFAULT '',
  paymongo_payment_intent_id  TEXT        NOT NULL DEFAULT '',
  paymongo_checkout_id        TEXT        NOT NULL DEFAULT '',
  paymongo_payment_id         TEXT        NOT NULL DEFAULT '',
  processing_status           TEXT        NOT NULL DEFAULT 'received'
    CHECK (processing_status IN ('received', 'processed', 'ignored', 'failed')),
  payload                     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_message               TEXT        NOT NULL DEFAULT '',
  processed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_webhook_events_provider_event_unique
    UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_created
  ON billing.payment_webhook_events (created_at DESC);

COMMENT ON TABLE billing.payment_webhook_events IS
  'Idempotent log of PayMongo (and future provider) webhooks.';

-- ─── payment_refunds ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS billing.payment_refunds (
  id                    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  payment_attempt_id    UUID        NOT NULL
    REFERENCES billing.payment_attempts(id) ON DELETE CASCADE,
  our_refund_reference  TEXT        NOT NULL,
  paymongo_refund_id    TEXT,
  amount_php            NUMERIC     NOT NULL DEFAULT 0,
  status                TEXT        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed', 'canceled')),
  reason                TEXT        NOT NULL DEFAULT '',
  failure_message       TEXT        NOT NULL DEFAULT '',
  metadata              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT payment_refunds_our_ref_unique UNIQUE (our_refund_reference),
  CONSTRAINT payment_refunds_paymongo_ref_unique UNIQUE (paymongo_refund_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_refunds_attempt
  ON billing.payment_refunds (payment_attempt_id, created_at DESC);

COMMENT ON TABLE billing.payment_refunds IS
  'Refunds against payment_attempts. our_refund_reference ≠ paymongo_refund_id.';

-- ─── RLS ────────────────────────────────────────────────────────────────────

ALTER TABLE billing.payment_attempts ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing.payment_webhook_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing.payment_refunds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON billing.payment_attempts FROM anon, authenticated;

REVOKE ALL ON billing.payment_webhook_events FROM anon, authenticated;

REVOKE ALL ON billing.payment_refunds FROM anon, authenticated;

COMMIT;
