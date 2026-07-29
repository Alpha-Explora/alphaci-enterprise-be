-- Migration: 20260614_ci_run_reports
-- Description: Creates workflow.ci_run_reports table to store per-stage CI pipeline
--              run results keyed by (repo_full_name, run_id, stage).
-- Notes:
--   - run_id is bigint (GitHub Actions run IDs exceed int32 range)
--   - user_id FK is ON DELETE CASCADE — report rows are removed with the user
--   - UNIQUE (repo_full_name, run_id, stage) supports safe upsert from the pipeline
--   - updated_at is maintained automatically via trg_ci_run_reports_updated_at trigger
-- Prereq: workflow schema and identity.app_users must already exist (see earlier migrations)

CREATE TABLE IF NOT EXISTS workflow.ci_run_reports (
  id                uuid          NOT NULL DEFAULT gen_random_uuid(),
  user_id           uuid          NOT NULL,
  repo_full_name    text          NOT NULL,
  branch            text          NOT NULL,
  commit_sha        text          NOT NULL,
  run_id            bigint        NOT NULL,
  stage             text          NOT NULL CHECK (stage IN ('access','quality','package')),
  status            text          NOT NULL CHECK (status IN ('success','failure','running','cancelled')),
  results           jsonb         NOT NULL DEFAULT '{}',
  friendly_messages jsonb         NOT NULL DEFAULT '[]',
  created_at        timestamptz   NOT NULL DEFAULT now(),
  updated_at        timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ci_run_reports_pkey PRIMARY KEY (id),
  CONSTRAINT ci_run_reports_user_fk FOREIGN KEY (user_id)
    REFERENCES identity.app_users(id) ON DELETE CASCADE,
  CONSTRAINT ci_run_reports_unique_stage UNIQUE (repo_full_name, run_id, stage)
);
CREATE INDEX IF NOT EXISTS idx_ci_run_reports_user_repo ON workflow.ci_run_reports (user_id, repo_full_name, run_id);
CREATE INDEX IF NOT EXISTS idx_ci_run_reports_repo_run ON workflow.ci_run_reports (repo_full_name, run_id);
CREATE OR REPLACE FUNCTION workflow.set_ci_run_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_ci_run_reports_updated_at ON workflow.ci_run_reports;
CREATE TRIGGER trg_ci_run_reports_updated_at
  BEFORE UPDATE ON workflow.ci_run_reports
  FOR EACH ROW EXECUTE FUNCTION workflow.set_ci_run_updated_at();
