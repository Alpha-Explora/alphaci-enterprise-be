-- Migration: identity_federation
-- Purpose: Add linked sign-in identities and numeric email verification codes.
-- Additive and backward-compatible with existing identity.app_users github_user_id.

BEGIN;

ALTER TABLE identity.app_users
  DROP CONSTRAINT IF EXISTS app_users_provider_check;

ALTER TABLE identity.app_users
  ADD CONSTRAINT app_users_provider_check
  CHECK (provider IN ('github', 'google', 'email'));

CREATE TABLE IF NOT EXISTS identity.user_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES identity.app_users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('email', 'google', 'github')),
  provider_user_id TEXT NOT NULL,
  email TEXT NULL,
  normalized_email TEXT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  password_hash TEXT NULL,
  display_name TEXT NULL,
  avatar_url TEXT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT user_identities_provider_user_id_unique UNIQUE (provider, provider_user_id),
  CONSTRAINT user_identities_email_password_hash_check CHECK (
    (provider = 'email' AND password_hash IS NOT NULL)
    OR (provider <> 'email' AND password_hash IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_provider
  ON identity.user_identities (user_id, provider);

CREATE INDEX IF NOT EXISTS idx_user_identities_verified_email
  ON identity.user_identities (normalized_email)
  WHERE email_verified = true AND normalized_email IS NOT NULL;

CREATE TABLE IF NOT EXISTS identity.email_verification_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  normalized_email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('signup', 'login_verification', 'email_change')),
  pending_identity_id UUID NULL REFERENCES identity.user_identities(id) ON DELETE CASCADE,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 1,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verification_codes_lookup
  ON identity.email_verification_codes (normalized_email, purpose, expires_at DESC)
  WHERE consumed_at IS NULL;

INSERT INTO identity.user_identities (
  user_id,
  provider,
  provider_user_id,
  email,
  normalized_email,
  email_verified,
  display_name,
  avatar_url,
  linked_at,
  last_login_at,
  created_at,
  updated_at
)
SELECT
  id,
  'github',
  github_user_id,
  email,
  lower(email),
  email IS NOT NULL,
  display_name,
  avatar_url,
  COALESCE(created_at, NOW()),
  last_login_at,
  COALESCE(created_at, NOW()),
  NOW()
FROM identity.app_users
WHERE github_user_id IS NOT NULL
ON CONFLICT (provider, provider_user_id) DO UPDATE SET
  user_id = EXCLUDED.user_id,
  email = COALESCE(identity.user_identities.email, EXCLUDED.email),
  normalized_email = COALESCE(identity.user_identities.normalized_email, EXCLUDED.normalized_email),
  email_verified = identity.user_identities.email_verified OR EXCLUDED.email_verified,
  display_name = COALESCE(EXCLUDED.display_name, identity.user_identities.display_name),
  avatar_url = COALESCE(EXCLUDED.avatar_url, identity.user_identities.avatar_url),
  updated_at = NOW();

ALTER TABLE identity.user_identities ENABLE ROW LEVEL SECURITY;

ALTER TABLE identity.email_verification_codes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON identity.user_identities FROM anon, authenticated;

REVOKE ALL ON identity.email_verification_codes FROM anon, authenticated;

COMMIT;
