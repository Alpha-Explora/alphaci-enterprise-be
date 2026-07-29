-- Vaulted payment methods for automatic recurring charges.
-- PayMongo stores the real credentials; we only store provider ids + display fields.

BEGIN;

ALTER TABLE billing.billing_profiles
  ADD COLUMN IF NOT EXISTS paymongo_customer_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.billing_profiles
  ADD COLUMN IF NOT EXISTS paymongo_default_payment_method_id TEXT NOT NULL DEFAULT '';

ALTER TABLE billing.billing_profiles
  ADD COLUMN IF NOT EXISTS vault_status TEXT NOT NULL DEFAULT 'none';

ALTER TABLE billing.billing_profiles
  DROP CONSTRAINT IF EXISTS billing_profiles_vault_status_check;

ALTER TABLE billing.billing_profiles
  ADD CONSTRAINT billing_profiles_vault_status_check
  CHECK (vault_status IN (
    'none',
    'pending',
    'vaulted',
    'manual_only',
    'failed'
  ));

ALTER TABLE billing.billing_profiles
  ADD COLUMN IF NOT EXISTS vaulted_at TIMESTAMPTZ;

COMMENT ON COLUMN billing.billing_profiles.paymongo_customer_id IS
  'PayMongo Customer id (cus_…). Required for card vaulting.';

COMMENT ON COLUMN billing.billing_profiles.paymongo_default_payment_method_id IS
  'Vaulted PayMongo customer payment method id (e.g. cus_pm_… or pm_…). Used for off-session renewals.';

COMMENT ON COLUMN billing.billing_profiles.vault_status IS
  'none=never vaulted; pending=setup requested; vaulted=reusable; manual_only=method cannot auto-charge (e.g. some e-wallets); failed=vault attempt failed.';

CREATE INDEX IF NOT EXISTS idx_billing_profiles_vaulted
  ON billing.billing_profiles (vault_status)
  WHERE vault_status = 'vaulted'
    AND paymongo_default_payment_method_id <> '';

COMMIT;
