-- ─── github_app.*.suspended_at ───────────────────────────────────────────────
-- Marks a GitHub App installation (or installation account) as suspended.
-- GitHub suspends an installation without uninstalling it; a suspended install
-- must be hidden from the product but its row kept, so revocation is reversible
-- and the audit trail survives.
--
-- BACKFILL MIGRATION. These columns already existed on the original Supabase
-- project but no migration in this directory created them — they were applied
-- by hand via the SQL editor, so a project rebuilt from this directory came up
-- without them. GithubInstallationsRepository filters on `suspended_at IS NULL`
-- in three queries and writes it in setSuspended(), so the omission is a
-- runtime failure (42703 undefined_column), not a cosmetic drift.
--
-- ADDITIVE ONLY. Nullable with no default, so this is a metadata-only change on
-- PostgreSQL 11+ — no table rewrite and no lock on existing rows. NULL means
-- "not suspended", which is what the existing queries already assume.

ALTER TABLE github_app.github_installations
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

ALTER TABLE github_app.github_installation_accounts
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;

COMMENT ON COLUMN github_app.github_installations.suspended_at IS
  'When the GitHub App installation for this repository was suspended. NULL means active; rows are retained rather than deleted so suspension is reversible.';

COMMENT ON COLUMN github_app.github_installation_accounts.suspended_at IS
  'When this GitHub App installation account was suspended. NULL means active. Queries filter on suspended_at IS NULL to hide suspended installs from the product.';
