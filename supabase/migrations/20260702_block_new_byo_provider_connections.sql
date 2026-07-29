-- Block new Vercel/Render BYO provider connections while keeping existing rows readable.
-- Env var storage remains supported; this trigger only blocks provider_connections inserts.

BEGIN;

CREATE OR REPLACE FUNCTION env_provisioning.reject_new_legacy_provider_connections()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'New Vercel and Render provider connections are disabled for the managed GCP migration'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS reject_new_legacy_provider_connections ON env_provisioning.provider_connections;

CREATE TRIGGER reject_new_legacy_provider_connections
BEFORE INSERT ON env_provisioning.provider_connections
FOR EACH ROW
EXECUTE FUNCTION env_provisioning.reject_new_legacy_provider_connections();

COMMIT;
