-- Migration: 20260617_provisioned_projects_example_flag
-- Purpose: Allow a system-seeded "demo/example" project to be provisioned for
-- every new FlowCI user automatically, distinct from a real repo the user owns.
--
-- Column semantics:
--   is_example = false (default) -> a real provisioned project tied to a GitHub repo
--                                    the user actually owns/installed the app on.
--   is_example = true            -> a synthetic, read-only row seeded by the backend
--                                    onboarding/seeding service so new users have
--                                    something to look at before they provision their
--                                    first real project. Not backed by a real GitHub
--                                    repository or webhook traffic.
--
-- Per-user, not global: user_id on this table is NOT NULL REFERENCES
-- identity.app_users(id) ON DELETE CASCADE (see 20260604_provisioned_projects.sql /
-- 20260609 backfill). There is no shared/global row design possible here -- the
-- seeding service MUST insert one example row per user_id (typically right after
-- account creation), not a single template row referenced by many users. When the
-- user is deleted, CASCADE removes their example row along with everything else.
--
-- repo_full_name for example rows: we recommend a realistic-looking but clearly
-- namespaced placeholder, e.g. 'flowci-demo/flowci-demo-app', rather than:
--   (a) NULL -- repo_full_name is NOT NULL on this table and a lot of FE/BE code
--             (splitRepoFullName, owner_login/repo_name derivation, dashboard
--             links) assumes a "owner/repo" shaped string is always present.
--   (b) a real, existing public GitHub repo -- risks the demo data pointing at a
--       repo that gets renamed/deleted/made private upstream, and could be
--       confused for a real integration if someone actually owns that repo.
-- Using a namespace ('flowci-demo/...') that is not a real GitHub org keeps the
-- placeholder self-evidently fake, stable forever, and safe to link to a
-- non-functional "Demo" badge in the UI (FE's call, not DB's -- this migration
-- only adds the flag the FE/BE will branch on).
--
-- Backfill: existing rows are real user-provisioned projects, so the new column
-- defaults to false for all of them (DEFAULT false covers backfill implicitly --
-- no UPDATE needed).
--
-- Index: partial index on (user_id) WHERE is_example = false to keep "real project"
-- counts/quota checks (e.g. plan limits, dashboard counts) from having to filter
-- out demo rows on every scan. is_example is low-cardinality and will be false for
-- the overwhelming majority of rows, so a partial index stays small relative to a
-- full index on the column.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS and CREATE INDEX IF NOT EXISTS are
-- idempotent; no destructive defaults; no data is rewritten.

ALTER TABLE projects.provisioned_projects
  ADD COLUMN IF NOT EXISTS is_example BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN projects.provisioned_projects.is_example IS
  'true = system-seeded read-only demo/example project shown to new users; not a real GitHub repo. false = real user-provisioned project. One example row per user_id, never a shared/global row.';

CREATE INDEX IF NOT EXISTS idx_provisioned_projects_user_real
  ON projects.provisioned_projects (user_id)
  WHERE is_example = false;
