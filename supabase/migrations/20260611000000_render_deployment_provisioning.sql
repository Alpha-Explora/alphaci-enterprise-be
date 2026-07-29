BEGIN;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD COLUMN IF NOT EXISTS render_service_type TEXT,
  ADD COLUMN IF NOT EXISTS render_instance_type TEXT,
  ADD COLUMN IF NOT EXISTS render_region TEXT,
  ADD COLUMN IF NOT EXISTS render_environment_name TEXT,
  ADD COLUMN IF NOT EXISTS docker_context TEXT,
  ADD COLUMN IF NOT EXISTS dockerfile_path TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT;

UPDATE env_provisioning.project_deployment_targets
SET deployment_strategy = 'render_git_connected'
WHERE provider = 'render'
  AND deployment_strategy = 'provider_native';

UPDATE env_provisioning.project_deployment_targets
SET render_service_type = COALESCE(render_service_type, 'web_service'),
    render_environment_name = COALESCE(
      render_environment_name,
      CASE
        WHEN branch_name = 'main' THEN 'production'
        WHEN branch_name IN ('test', 'uat', 'production') THEN branch_name
        ELSE 'test'
      END
    )
WHERE provider = 'render';

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_strategy_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_strategy_check
  CHECK (
    deployment_strategy IN (
      'provider_native',
      'vercel_git_connected',
      'vercel_ci_pushed',
      'render_git_connected',
      'render_image_pushed',
      'render_existing_service'
    )
  );

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_render_service_type_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_render_service_type_check
  CHECK (
    render_service_type IS NULL OR render_service_type IN (
      'web_service',
      'private_service',
      'background_worker',
      'cron_job'
    )
  );

ALTER TABLE env_provisioning.project_deployment_targets
  DROP CONSTRAINT IF EXISTS project_deployment_targets_render_environment_check;

ALTER TABLE env_provisioning.project_deployment_targets
  ADD CONSTRAINT project_deployment_targets_render_environment_check
  CHECK (
    render_environment_name IS NULL OR render_environment_name IN (
      'test',
      'uat',
      'production'
    )
  );

CREATE INDEX IF NOT EXISTS idx_project_deployment_targets_render_service_type
  ON env_provisioning.project_deployment_targets (render_service_type)
  WHERE provider = 'render';

CREATE INDEX IF NOT EXISTS idx_project_deployment_targets_render_environment
  ON env_provisioning.project_deployment_targets (render_environment_name)
  WHERE provider = 'render';

COMMIT;
