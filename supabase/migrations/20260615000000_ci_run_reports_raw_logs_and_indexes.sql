-- Migration: 20260615_ci_run_reports_raw_logs_and_indexes
-- Description: Adds raw_logs column and a user-recency index to workflow.ci_run_reports.
-- Notes:
--   - raw_logs TEXT is nullable — populated asynchronously after a run completes;
--     existing rows that predate this migration retain NULL without backfill.
--   - idx_ci_run_reports_user_created supports the common "recent runs for a user"
--     list query (ORDER BY created_at DESC WHERE user_id = $1).  The existing
--     idx_ci_run_reports_user_repo covers (user_id, repo_full_name, run_id) but
--     does not help sort-heavy recency queries — this index fills that gap.
--   - Both statements use IF NOT EXISTS, making this migration safe to re-run.
-- Prereq: 20260614_ci_run_reports must already be applied.

ALTER TABLE workflow.ci_run_reports
  ADD COLUMN IF NOT EXISTS raw_logs TEXT;

CREATE INDEX IF NOT EXISTS idx_ci_run_reports_user_created
  ON workflow.ci_run_reports (user_id, created_at DESC);
