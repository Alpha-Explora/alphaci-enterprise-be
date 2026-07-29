-- Rollback for 20260729000000_github_installations_suspended_at.sql
--
-- Dropping these columns loses which installations were suspended. Only run
-- this if the forward migration is being reverted on a project where nothing
-- has written a suspension yet.

ALTER TABLE github_app.github_installation_accounts
  DROP COLUMN IF EXISTS suspended_at;

ALTER TABLE github_app.github_installations
  DROP COLUMN IF EXISTS suspended_at;
