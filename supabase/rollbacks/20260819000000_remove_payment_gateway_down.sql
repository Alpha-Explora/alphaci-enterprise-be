-- Rollback: remove_payment_gateway
--
-- Restores the payment-gateway schema dropped by
-- supabase/migrations/20260819000000_remove_payment_gateway.sql.
--
-- HOW TO ROLL BACK
--
-- The two migrations that created this schema are still in the repository and
-- are both idempotent (CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS),
-- so re-applying them restores the objects exactly:
--
--   npm run db:apply -- 20260714_payment_ledger.sql
--   npm run db:apply -- 20260716000000_payment_method_vault.sql
--
-- That is deliberately the documented path rather than a copy of the DDL here.
-- payment_attempts alone is ~60 lines of columns, constraints and CHECKs; a
-- second copy in this file would drift from the source the first time either
-- is touched, and a rollback that silently restores a *different* shape than
-- the original is worse than no rollback at all.
--
-- WHAT CANNOT BE RESTORED
--
-- Rows. DROP TABLE destroyed every payment attempt, refund and webhook event,
-- and the vaulted-card columns took their values with them. Re-applying the
-- migrations gives you the empty structure back, nothing more. If this
-- database ever held real settlement history, restore from a backup instead
-- of using this path.
--
-- Applying this file does not perform the rollback — it stops with the
-- instruction, so that a no-op is never mistaken for a completed restore.

DO $$
BEGIN
  RAISE EXCEPTION
    'Rollback is performed by re-applying the source migrations, not by this file. Run: npm run db:apply -- 20260714_payment_ledger.sql  then  npm run db:apply -- 20260716000000_payment_method_vault.sql';
END
$$;
