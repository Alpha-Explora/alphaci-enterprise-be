-- Billing contact and payment-method display details per user.
-- PayMongo keeps card tokens; AlphaCI only stores invoice address + display fields.

BEGIN;

CREATE TABLE IF NOT EXISTS billing.billing_profiles (
  user_id                UUID        NOT NULL PRIMARY KEY
    REFERENCES identity.app_users(id) ON DELETE CASCADE,
  billing_name           TEXT        NOT NULL DEFAULT '',
  billing_email          TEXT        NOT NULL DEFAULT '',
  address_line1          TEXT        NOT NULL DEFAULT '',
  address_line2          TEXT        NOT NULL DEFAULT '',
  city                   TEXT        NOT NULL DEFAULT '',
  state                  TEXT        NOT NULL DEFAULT '',
  postal_code            TEXT        NOT NULL DEFAULT '',
  country                TEXT        NOT NULL DEFAULT '',
  payment_method_type    TEXT        NOT NULL DEFAULT ''
    CHECK (payment_method_type IN ('', 'card', 'gcash', 'paymaya', 'qrph', 'manual')),
  payment_method_brand   TEXT        NOT NULL DEFAULT '',
  payment_method_last4   TEXT        NOT NULL DEFAULT '',
  payment_method_exp_month INTEGER,
  payment_method_exp_year  INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE billing.billing_profiles IS
  'Invoice contact + payment method display fields. Card PANs never stored.';

ALTER TABLE billing.billing_profiles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON billing.billing_profiles FROM anon, authenticated;

COMMIT;
