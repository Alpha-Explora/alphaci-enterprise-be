import { registerAs } from '@nestjs/config';

import type { SubscriptionPlan } from '../common/interfaces/session-user.interface';

/** See AppConfig['github']['teamRoleSync']. */
export type GithubTeamRoleSyncMode = 'off' | 'seed' | 'enforce';

/**
 * Any unrecognized value resolves to 'off' — an environment must name the mode
 * exactly to turn GitHub team reads on, matching how HIERARCHY_GITHUB_SYNC_MODE
 * defaults to the inert option.
 */
function resolveTeamRoleSync(raw: string | undefined): GithubTeamRoleSyncMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'seed' || normalized === 'enforce') {
    return normalized;
  }
  return 'off';
}

export interface AppConfig {
  frontendUrl: string;
  github: {
    clientId: string;
    clientSecret: string;
    callbackUrl: string;
    scope: string;
    appId: string;
    appSlug: string;
    appPrivateKey: string;
    appWebhookSecret: string;
    /**
     * Login of the internal company GitHub org. When set, members of this org
     * are stamped is_internal=true on sign-in (and bypass the subscription
     * gate); non-members are hard-blocked on the internal deployment. Leave
     * empty on the external (sold) deployment to disable internal gating.
     */
    internalOrg: string;
    /**
     * ALL repositories created by the product are forced into this GitHub
     * organization instead of the signed-in user's personal account. Requires
     * the GitHub App to be installed on this org with access to all
     * repositories.
     *
     * Empty when GITHUB_ENFORCED_ORG is unset, and deliberately so: there is no
     * default org. A hardcoded fallback would mean a missing or failed config
     * silently routes creation into whichever org the fallback names, which is
     * indistinguishable from success at the call site. Empty instead trips the
     * "no destination org is configured" guard in createRepo(), which names the
     * variable to set. Empty never re-enables personal-account creation — the
     * personal POST /user/repos path does not exist.
     */
    enforcedOrg: string;
    /**
     * How GitHub org team membership feeds identity.app_users.app_role.
     *
     *   'off'     — never read teams (default). Legacy behaviour: app_role is
     *               seeded from org OWNERSHIP on first login only.
     *   'seed'    — team membership seeds app_role on first login only; the
     *               Admin Console owns it from then on.
     *   'enforce' — app_role is re-derived from team membership on every
     *               login (and by the membership webhook), EXCEPT for users
     *               pinned to app_role_source = 'manual'.
     *
     * Mirrors the HIERARCHY_GITHUB_SYNC_MODE safety pattern: an environment
     * must opt in explicitly, and any unrecognized value falls back to 'off'.
     */
    teamRoleSync: GithubTeamRoleSyncMode;
    /** Org team whose members become global 'lead' (may create projects). */
    leadTeamSlug: string;
    /** Org team whose members become global 'member' (assigned work only). */
    developerTeamSlug: string;
    /**
     * How often (ms) the reconciliation sweep re-reads both team rosters and
     * corrects any app_role that drifted — the safety net for webhook
     * deliveries that were missed or arrived while the service was down.
     * 0 disables the sweep. Only runs under teamRoleSync='enforce'.
     */
    teamRoleReconcileIntervalMs: number;
  };
  templates: {
    repoPath: string;
    workflowDir: string;
  };
  subscription: {
    /**
     * When false, every authenticated user is treated as fully entitled and no
     * subscription row is required — the model for contract-billed enterprise
     * deployments. Honoured by SubscriptionService.getForUser and by CI run
     * validation in CiService.
     */
    gateEnabled: boolean;
    mockEnabled: boolean;
    defaultPlan: SubscriptionPlan;
    seededPlans: Record<string, SubscriptionPlan>;
    proMonthlyPricePhp: number;
  };
  envProvisioning: {
    enabled: boolean;
    /**
     * Deployment ownership mode offered by this deployment. BYO ('byo') is
     * archived: every deployment centralizes on the platform's own
     * Render/Vercel/SonarCloud credentials via flowciManaged.*, so the only
     * mode ever offered is 'flowci_managed'. The union type is kept because
     * stored targets and older clients may still carry 'byo' values.
     */
    ownershipMode: 'byo' | 'flowci_managed';
    encryptionKey: string;
    flowciManaged: {
      renderToken: string;
      renderOwnerId: string | null;
      renderDefaultRegion?: string;
      renderDefaultInstanceType?: string;
      renderAllowedInstanceTypes?: string[];
      renderAllowPaidManaged?: boolean;
      renderManagedMaxServicesPerUser?: number;
      // Platform-wide caps on managed targets across ALL users. Because managed
      // mode shares a single Render/Vercel account, per-user quotas alone cannot
      // protect the shared account from aggregate exhaustion. 0 = unlimited.
      renderManagedFleetMax?: number;
      vercelManagedFleetMax?: number;
      renderBootstrapImage?: string;
      renderRegistryCredentialId?: string | null;
      renderRegistryUsername?: string | null;
      renderRegistryToken?: string | null;
      vercelToken: string;
      vercelTeamId: string | null;
      vercelTeamSlug: string | null;
      // Centralized SonarCloud credentials installed into every created repo
      // so the quality-scan job works out of the box.
      sonarToken: string;
      sonarOrganization: string;
    };
  };
  projectSyncSnapshots: {
    enabled: boolean;
    liveGithubEnabled: boolean;
    liveProvidersEnabled: boolean;
  };
  workflowSettingsPreview: {
    enabled: boolean;
  };
  workflowUpdatePr: {
    enabled: boolean;
  };
  projectTargetManagement: {
    enabled: boolean;
  };
  ciRunTracking: {
    enabled: boolean;
    liveGithubEnabled: boolean;
  };
  deploymentHistory: {
    enabled: boolean;
    liveProvidersEnabled: boolean;
  };
  driftDetection: {
    enabled: boolean;
  };
  driftRepair: {
    enabled: boolean;
    liveRepairEnabled: boolean;
  };
  driftLiveChecks: {
    enabled: boolean;
  };
  usageQuotas: {
    enabled: boolean;
  };
  workspaces: {
    enabled: boolean;
  };
  auditEvents: {
    enabled: boolean;
  };
  notifications: {
    enabled: boolean;
  };
  supabase: {
    dbUrl: string | undefined;
    dbCaCert?: string;
  };
  session: {
    secret: string;
    name: string;
    maxAgeMs: number;
    secure: boolean;
    storeDriver: 'postgres' | 'memory';
    // Optional cookie Domain attribute. Leave UNSET for the current split-domain
    // setup (host-only cookie, today's behavior). When FE + BE move under one
    // parent domain (e.g. app.example.com + api.example.com), set this to
    // ".example.com" so the session cookie is shared first-party across the
    // subdomains — this is what makes login work on Safari/iOS (no third-party
    // cookie). See docs/AUTH_CUSTOM_DOMAIN_CUTOVER.md.
    cookieDomain?: string;
  };
  archivedAccountRetentionDays: number;
  hierarchy: {
    enabled: boolean;
    /**
     * 'stub' (default everywhere) runs the full assignment state machine and
     * outbox lifecycle against a no-op GitHub client that always reports
     * success. 'live' switches GithubSyncService's injected
     * GithubTeamAccessProvider to real GitHub Team API calls. See
     * docs/HIERARCHY_IMPLEMENTATION_PLAN.md §1.7 — no environment should be
     * flipped to 'live' without an explicit operator decision.
     */
    githubSyncMode: 'stub' | 'live';
    encryptionKeyEnvVar: string;
    maxSyncRetries: number;
    syncPollIntervalMs: number;
  };
}

export const appConfig = registerAs('app', (): AppConfig => {
  const env = process.env;
  const isProduction = env['NODE_ENV'] === 'production';
  const rawEnforcedOrg = env['GITHUB_ENFORCED_ORG']?.trim();
  const resolvedEnforcedOrg =
    rawEnforcedOrg && rawEnforcedOrg in env
      ? env[rawEnforcedOrg]?.trim()
      : rawEnforcedOrg;

  const seededPlans: Record<string, SubscriptionPlan> = {};
  try {
    const raw = env['SUBSCRIPTION_MOCK_MAP_JSON'] ?? '{}';
    Object.assign(
      seededPlans,
      JSON.parse(raw) as Record<string, SubscriptionPlan>,
    );
  } catch {
    // malformed JSON — fall through with empty map
  }

  return {
    frontendUrl: env['FRONTEND_URL'] ?? 'http://localhost:3000',
    github: {
      clientId: env['GITHUB_CLIENT_ID'] ?? '',
      clientSecret: env['GITHUB_CLIENT_SECRET'] ?? '',
      callbackUrl:
        env['GITHUB_CALLBACK_URL'] ??
        'http://localhost:4000/api/v1/auth/github/callback',
      // read:org is required so the OAuth token can query the signed-in user's
      // org membership (GET /user/memberships/orgs/{org}) for internal gating.
      // delete_repo is required separately from `repo` for the opt-in
      // "delete GitHub repo too" project-delete path (GET /repos DELETE)
      // — GitHub classic OAuth Apps gate repo deletion behind this scope even
      // when `repo` is already granted. Sessions established before this
      // scope was added will keep 403ing on delete until the user
      // reconnects GitHub (see GithubService.deleteRepoForUser).
      scope: env['GITHUB_SCOPE'] ?? 'repo,workflow,read:org,delete_repo',
      // Accept GITHUB_APP_ID with a plain GITHUB_APP alias, and the private key
      // under either GITHUB_APP_PRIVATE_KEY or the shorter GITHUB_PRIVATE_KEY
      // used by the sibling deployment — so a key provisioned under that naming
      // convention still enables the App (hasAppCredentials) here instead of
      // silently falling through to "GitHub App installations are unavailable".
      appId: (env['GITHUB_APP_ID'] ?? env['GITHUB_APP'] ?? '').trim(),
      appSlug:
        env['GITHUB_APP_SLUG']?.trim() || (isProduction ? '' : 'my-github-app'),
      appPrivateKey: (
        env['GITHUB_APP_PRIVATE_KEY'] ??
        env['GITHUB_PRIVATE_KEY'] ??
        ''
      ).replace(/\\n/g, '\n'),
      appWebhookSecret: env['GITHUB_APP_WEBHOOK_SECRET'] ?? '',
      internalOrg: env['GITHUB_INTERNAL_ORG']?.trim() ?? '',
      // Force every created repository into this org. No default: see the
      // enforcedOrg doc comment on AppConfig for why an unset value resolves to
      // empty and fails loudly rather than picking an org.
      enforcedOrg: resolvedEnforcedOrg ?? '',
      teamRoleSync: resolveTeamRoleSync(env['GITHUB_TEAM_ROLE_SYNC']),
      leadTeamSlug: env['GITHUB_TEAM_LEAD_SLUG']?.trim() || 'team-lead',
      developerTeamSlug:
        env['GITHUB_TEAM_DEVELOPER_SLUG']?.trim() || 'developers',
      teamRoleReconcileIntervalMs: Number(
        env['GITHUB_TEAM_ROLE_RECONCILE_INTERVAL_MS'] ?? 900_000,
      ),
    },
    templates: {
      repoPath: env['TEMPLATE_REPO_PATH'] ?? '../cicd-workflow',
      workflowDir: env['TEMPLATE_WORKFLOW_DIR'] ?? 'workflow-templates',
    },
    subscription: {
      gateEnabled: env['SUBSCRIPTION_GATE_ENABLED'] !== 'false',
      mockEnabled: env['SUBSCRIPTION_MOCK_ENABLED'] === 'true',
      defaultPlan:
        (env['SUBSCRIPTION_MOCK_DEFAULT_PLAN'] as
          | SubscriptionPlan
          | undefined) ?? 'free',
      seededPlans,
      proMonthlyPricePhp: Number(env['PRO_MONTHLY_PRICE_PHP'] ?? 300),
    },
    envProvisioning: {
      enabled: env['ENV_PROVISIONING_ENABLED'] === 'true',
      // BYO is archived — the platform always centralizes deployments on its
      // own hosting credentials, so ENV_PROVISIONING_OWNERSHIP_MODE is
      // intentionally ignored.
      ownershipMode: 'flowci_managed',
      encryptionKey: env['ENV_PROVISIONING_ENCRYPTION_KEY'] ?? '',
      flowciManaged: {
        renderToken:
          env['ALPHACI_RENDER_API_KEY'] ?? env['FLOWCI_RENDER_API_KEY'] ?? '',
        renderOwnerId:
          env['ALPHACI_RENDER_OWNER_ID']?.trim() ||
          env['FLOWCI_RENDER_OWNER_ID']?.trim() ||
          null,
        renderDefaultRegion:
          env['ALPHACI_RENDER_DEFAULT_REGION']?.trim() ||
          env['FLOWCI_RENDER_DEFAULT_REGION']?.trim() ||
          'singapore',
        renderDefaultInstanceType:
          env['ALPHACI_RENDER_DEFAULT_INSTANCE_TYPE']?.trim() ||
          env['FLOWCI_RENDER_DEFAULT_INSTANCE_TYPE']?.trim() ||
          'free',
        renderAllowedInstanceTypes: (
          env['ALPHACI_RENDER_ALLOWED_INSTANCE_TYPES'] ??
          env['FLOWCI_RENDER_ALLOWED_INSTANCE_TYPES'] ??
          'free'
        )
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        renderAllowPaidManaged:
          (env['ALPHACI_RENDER_ALLOW_PAID_MANAGED'] ??
            env['FLOWCI_RENDER_ALLOW_PAID_MANAGED']) === 'true',
        renderManagedMaxServicesPerUser: Number(
          env['ALPHACI_RENDER_MANAGED_MAX_SERVICES_PER_USER'] ??
            env['FLOWCI_RENDER_MANAGED_MAX_SERVICES_PER_USER'] ??
            '2',
        ),
        renderManagedFleetMax: Number(
          env['ALPHACI_RENDER_MANAGED_FLEET_MAX'] ??
            env['FLOWCI_RENDER_MANAGED_FLEET_MAX'] ??
            '0',
        ),
        vercelManagedFleetMax: Number(
          env['ALPHACI_VERCEL_MANAGED_FLEET_MAX'] ??
            env['FLOWCI_VERCEL_MANAGED_FLEET_MAX'] ??
            '0',
        ),
        renderBootstrapImage:
          env['ALPHACI_RENDER_BOOTSTRAP_IMAGE']?.trim() ||
          env['FLOWCI_RENDER_BOOTSTRAP_IMAGE']?.trim() ||
          'docker.io/library/nginx:alpine',
        renderRegistryCredentialId:
          env['ALPHACI_RENDER_REGISTRY_CREDENTIAL_ID']?.trim() ||
          env['FLOWCI_RENDER_REGISTRY_CREDENTIAL_ID']?.trim() ||
          null,
        renderRegistryUsername:
          env['ALPHACI_RENDER_REGISTRY_USERNAME']?.trim() ||
          env['FLOWCI_RENDER_REGISTRY_USERNAME']?.trim() ||
          null,
        renderRegistryToken:
          env['ALPHACI_RENDER_REGISTRY_TOKEN']?.trim() ||
          env['FLOWCI_RENDER_REGISTRY_TOKEN']?.trim() ||
          null,
        vercelToken:
          env['ALPHACI_VERCEL_TOKEN'] ?? env['FLOWCI_VERCEL_TOKEN'] ?? '',
        vercelTeamId:
          env['ALPHACI_VERCEL_TEAM_ID'] ?? env['FLOWCI_VERCEL_TEAM_ID'] ?? null,
        vercelTeamSlug:
          env['ALPHACI_VERCEL_TEAM_SLUG'] ??
          env['FLOWCI_VERCEL_TEAM_SLUG'] ??
          null,
        sonarToken:
          env['ALPHACI_SONAR_TOKEN']?.trim() ??
          env['FLOWCI_SONAR_TOKEN']?.trim() ??
          '',
        sonarOrganization:
          env['ALPHACI_SONAR_ORGANIZATION']?.trim() ??
          env['FLOWCI_SONAR_ORGANIZATION']?.trim() ??
          '',
      },
    },
    projectSyncSnapshots: {
      enabled: env['PROJECT_SYNC_SNAPSHOTS_ENABLED'] === 'true',
      liveGithubEnabled: env['PROJECT_SYNC_LIVE_GITHUB_ENABLED'] === 'true',
      liveProvidersEnabled:
        env['PROJECT_SYNC_LIVE_PROVIDERS_ENABLED'] === 'true',
    },
    workflowSettingsPreview: {
      enabled: env['WORKFLOW_SETTINGS_PREVIEW_ENABLED'] === 'true',
    },
    workflowUpdatePr: {
      enabled: env['WORKFLOW_UPDATE_PR_ENABLED'] === 'true',
    },
    projectTargetManagement: {
      enabled: env['PROJECT_TARGET_MANAGEMENT_ENABLED'] === 'true',
    },
    ciRunTracking: {
      enabled: env['CI_RUN_TRACKING_ENABLED'] === 'true',
      liveGithubEnabled: env['CI_RUN_LIVE_GITHUB_ENABLED'] !== 'false',
    },
    deploymentHistory: {
      enabled: env['DEPLOYMENT_HISTORY_ENABLED'] === 'true',
      liveProvidersEnabled:
        env['DEPLOYMENT_HISTORY_LIVE_PROVIDERS_ENABLED'] !== 'false',
    },
    driftDetection: {
      enabled: env['DRIFT_DETECTION_ENABLED'] === 'true',
    },
    driftRepair: {
      enabled: env['DRIFT_REPAIR_ENABLED'] === 'true',
      liveRepairEnabled: env['DRIFT_LIVE_REPAIR_ENABLED'] === 'true',
    },
    driftLiveChecks: {
      enabled: env['DRIFT_LIVE_PROVIDER_CHECKS_ENABLED'] === 'true',
    },
    usageQuotas: {
      enabled: env['USAGE_QUOTAS_ENABLED'] === 'true',
    },
    workspaces: {
      enabled: env['WORKSPACES_ENABLED'] === 'true',
    },
    auditEvents: {
      enabled: env['AUDIT_EVENTS_ENABLED'] === 'true',
    },
    notifications: {
      enabled: env['NOTIFICATIONS_ENABLED'] === 'true',
    },
    supabase: {
      // Trim defensively. Every sibling secret is trimmed; this one was not,
      // so a trailing newline/space pasted into a host's env panel survived
      // into the connection string and could corrupt the parsed dbname or
      // password — surfacing as a confusing "password authentication failed"
      // in one environment but not another with a visually-identical value.
      dbUrl: env['SUPABASE_DB_URL']?.trim(),
      ...(env['SUPABASE_DB_CA_CERT']?.trim()
        ? { dbCaCert: env['SUPABASE_DB_CA_CERT'].trim() }
        : {}),
    },
    session: {
      secret: (() => {
        const raw = env['SESSION_SECRET'];
        if (!raw || raw.trim().length < 32) {
          throw new Error(
            '[config] SESSION_SECRET must be set and at least 32 characters long. ' +
              "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
          );
        }
        return raw.trim();
      })(),
      name: env['SESSION_NAME'] ?? 'cicd_workflow_sid',
      maxAgeMs: Number(env['SESSION_MAX_AGE_MS'] ?? 604_800_000),
      secure: env['SESSION_SECURE'] === 'true',
      storeDriver:
        env['SESSION_STORE_DRIVER'] === 'postgres' ? 'postgres' : 'memory',
      // Only include cookieDomain when explicitly set, so the default stays
      // host-only (current behavior) under exactOptionalPropertyTypes.
      ...(env['SESSION_COOKIE_DOMAIN']?.trim()
        ? { cookieDomain: env['SESSION_COOKIE_DOMAIN'].trim() }
        : {}),
    },
    archivedAccountRetentionDays: Number(
      env['ARCHIVED_ACCOUNT_RETENTION_DAYS'] ?? 30,
    ),
    hierarchy: {
      enabled: env['HIERARCHY_ENABLED'] !== 'false',
      // Defaults to 'stub' regardless of what an unrecognized value is set
      // to — an environment must explicitly set 'live' to enable real
      // GitHub Team API calls (plan §1.7 hard requirement: default stub
      // everywhere).
      githubSyncMode:
        env['HIERARCHY_GITHUB_SYNC_MODE'] === 'live' ? 'live' : 'stub',
      encryptionKeyEnvVar:
        env['HIERARCHY_ENCRYPTION_KEY_ENV_VAR'] ??
        'ENV_PROVISIONING_ENCRYPTION_KEY',
      maxSyncRetries: Number(env['HIERARCHY_MAX_SYNC_RETRIES'] ?? 5),
      syncPollIntervalMs: Number(
        env['HIERARCHY_SYNC_POLL_INTERVAL_MS'] ?? 5000,
      ),
    },
  };
});
