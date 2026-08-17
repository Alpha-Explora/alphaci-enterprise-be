import { createHmac, generateKeyPairSync } from 'node:crypto';

import type { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config.js';
import { GithubRepoDeleteError, GithubService } from './github.service.js';
import type { GithubInstallationsRepository } from './github-installations.repository.js';

const makeRepo = (overrides = {}) => ({
  id: 1,
  name: 'my-repo',
  full_name: 'user/my-repo',
  private: false,
  description: 'A test repo',
  default_branch: 'main',
  html_url: 'https://github.com/user/my-repo',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});

const testPrivateKey = privateKey.export({
  type: 'pkcs8',
  format: 'pem',
}) as string;

const appConfig: AppConfig = {
  frontendUrl: 'http://localhost:3000',
  github: {
    clientId: 'client-id',
    clientSecret: 'client-secret',
    callbackUrl: 'http://localhost:4000/api/v1/auth/github/callback',
    scope: 'read:user user:email',
    appId: '123456',
    appSlug: 'flowci-test',
    appPrivateKey: testPrivateKey,
    appWebhookSecret: 'webhook-secret',
    internalOrg: '',
    enforcedOrg: 'Alpha-Explora',
    teamRoleSync: 'off',
    leadTeamSlug: 'team-lead',
    developerTeamSlug: 'developers',
  },
  templates: {
    repoPath: '../cicd-workflow',
    workflowDir: 'workflow-templates',
  },
  envProvisioning: {
    enabled: false,
    ownershipMode: 'flowci_managed',
    encryptionKey: '',
    flowciManaged: {
      renderToken: '',
      renderOwnerId: null,
      vercelToken: '',
      vercelTeamId: null,
      vercelTeamSlug: null,
      sonarToken: '',
      sonarOrganization: '',
    },
  },
  projectSyncSnapshots: {
    enabled: false,
    liveGithubEnabled: false,
    liveProvidersEnabled: false,
  },
  workflowSettingsPreview: {
    enabled: false,
  },
  workflowUpdatePr: {
    enabled: false,
  },
  subscription: {
    gateEnabled: true,
    mockEnabled: true,
    defaultPlan: 'free',
    seededPlans: {},
    proMonthlyPricePhp: 300,
    paymentProvider: 'none',
    successUrl: 'http://localhost:3000/subscribe?status=success',
    cancelUrl: 'http://localhost:3000/subscribe?status=cancelled',
    paymongo: {
      secretKey: '',
      webhookSecret: '',
    },
  },
  supabase: {
    dbUrl: undefined,
  },
  session: {
    secret: 'x'.repeat(32),
    name: 'sid',
    maxAgeMs: 60_000,
    secure: false,
    storeDriver: 'memory',
  },
  archivedAccountRetentionDays: 30,
  projectTargetManagement: { enabled: false },
  ciRunTracking: { enabled: false, liveGithubEnabled: false },
  deploymentHistory: { enabled: false, liveProvidersEnabled: false },
  driftDetection: { enabled: false },
  driftRepair: { enabled: false, liveRepairEnabled: false },
  driftLiveChecks: { enabled: false },
  usageQuotas: { enabled: false },
  workspaces: { enabled: false },
  auditEvents: { enabled: false },
  notifications: { enabled: false },
  hierarchy: {
    enabled: false,
    githubSyncMode: 'stub',
    encryptionKeyEnvVar: 'ENV_PROVISIONING_ENCRYPTION_KEY',
    maxSyncRetries: 5,
    syncPollIntervalMs: 5000,
  },
};

const makeConfigService = (config: AppConfig = appConfig) =>
  ({
    get: jest.fn().mockReturnValue(config),
  }) as unknown as ConfigService;

const makeInstallationsRepository = () =>
  ({
    upsert: jest.fn().mockResolvedValue({
      installationId: 12345,
      userId: 'user-1',
      accountLogin: 'tone',
      accountId: 99,
      accountType: 'Organization',
      repositorySelection: 'all',
      reposLinked: 2,
    }),
    replaceRepos: jest.fn().mockResolvedValue(undefined),
    findByUserId: jest.fn().mockResolvedValue([
      {
        installationId: 12345,
        userId: 'user-1',
        accountLogin: 'tone',
        accountId: 99,
        accountType: 'Organization',
        repositorySelection: 'all',
        reposLinked: 2,
      },
    ]),
    findByUserIdAndInstallationId: jest.fn().mockResolvedValue({
      installationId: 12345,
      userId: 'user-1',
      accountLogin: 'tone',
      accountId: 99,
      accountType: 'Organization',
      repositorySelection: 'all',
      reposLinked: 2,
    }),
    findReposByUserId: jest.fn().mockResolvedValue([]),
    beginWebhookDelivery: jest.fn().mockResolvedValue(true),
    completeWebhookDelivery: jest.fn().mockResolvedValue(undefined),
    releaseWebhookDelivery: jest.fn().mockResolvedValue(undefined),
    setSuspended: jest.fn().mockResolvedValue(undefined),
    deleteInstallation: jest.fn().mockResolvedValue(undefined),
  }) as unknown as GithubInstallationsRepository;

describe('GithubService', () => {
  let service: GithubService;
  let installationsRepository: GithubInstallationsRepository;
  let fetchMock: jest.Mock;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    installationsRepository = makeInstallationsRepository();
    service = new GithubService(makeConfigService(), installationsRepository);
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('GitHub App tokens', () => {
    it('builds the GitHub App install URL from config', () => {
      expect(service.getAppInstallUrl()).toBe(
        'https://github.com/apps/flowci-test/installations/new',
      );
    });

    it('reads the app slug from ConfigService when building the install URL', () => {
      const configService = makeConfigService({
        ...appConfig,
        github: { ...appConfig.github, appSlug: '' },
      });
      const dynamicService = new GithubService(
        configService,
        installationsRepository,
      );

      (configService.get as jest.Mock).mockReturnValue({
        ...appConfig,
        github: { ...appConfig.github, appSlug: 'alphaci-test' },
      });

      expect(dynamicService.getAppInstallUrl()).toBe(
        'https://github.com/apps/alphaci-test/installations/new',
      );
    });

    it('rejects install URL generation when the App slug is missing', () => {
      const unconfigured = new GithubService(
        makeConfigService({
          ...appConfig,
          github: { ...appConfig.github, appSlug: '' },
        }),
        installationsRepository,
      );

      expect(() => unconfigured.getAppInstallUrl()).toThrow(
        'GitHub App installation is not configured',
      );
    });

    it('throws when app credentials are missing for JWT creation', () => {
      const unconfigured = new GithubService(
        makeConfigService({
          ...appConfig,
          github: {
            ...appConfig.github,
            appId: '',
            appPrivateKey: '',
          },
        }),
        installationsRepository,
      );

      expect(() => unconfigured.createAppJwt()).toThrow(
        'GitHub App credentials are not configured',
      );
    });

    it('creates a signed app JWT with the configured app id', () => {
      const jwt = service.createAppJwt();
      const [, payloadPart] = jwt.split('.');
      expect(payloadPart).toBeDefined();

      const payload = JSON.parse(
        Buffer.from(payloadPart ?? '', 'base64url').toString('utf8'),
      ) as { iss: string; iat: number; exp: number };

      expect(payload.iss).toBe('123456');
      expect(payload.exp).toBeGreaterThan(payload.iat);
      expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    });

    it('requests an installation access token with an app JWT', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'installation-token' }),
      } as unknown as Response);

      await expect(service.createInstallationAccessToken(12345)).resolves.toBe(
        'installation-token',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/12345/access_tokens',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: expect.stringMatching(/^Bearer /),
          }),
        }),
      );
    });

    it('throws when installation token request fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        text: async () => 'bad gateway',
      } as unknown as Response);

      await expect(
        service.createInstallationAccessToken(12345),
      ).rejects.toThrow(
        'GitHub installation token request failed (502): bad gateway',
      );
    });

    it('throws when installation token response has no token', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      } as unknown as Response);

      await expect(
        service.createInstallationAccessToken(12345),
      ).rejects.toThrow(
        'GitHub installation token response did not include a token',
      );
    });
  });

  describe('linkInstallation', () => {
    it('fetches installation metadata, stores it, and syncs linked repos', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            account: { login: 'tone', id: 99, type: 'Organization' },
            repository_selection: 'all',
          }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ token: 'installation-token' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            repositories: [
              { full_name: 'tone/api' },
              { full_name: 'tone/web' },
            ],
          }),
        } as unknown as Response);

      const result = await service.linkInstallation('user-1', 12345);

      expect(installationsRepository.upsert).toHaveBeenCalledWith(
        'user-1',
        12345,
        'tone',
        99,
        'Organization',
        'all',
        2,
      );
      expect(installationsRepository.replaceRepos).toHaveBeenCalledWith(12345, [
        'tone/api',
        'tone/web',
      ]);
      expect(result).toEqual({ reposLinked: 2, repositorySelection: 'all' });
    });
  });

  describe('getInstallationAccessTokenForUser', () => {
    it('returns an installation token for the first all-repositories installation', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'installation-token' }),
      } as unknown as Response);

      await expect(
        service.getInstallationAccessTokenForUser('user-1'),
      ).resolves.toBe('installation-token');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/12345/access_tokens',
        expect.any(Object),
      );
    });

    it('returns null when no GitHub App installation is linked', async () => {
      (installationsRepository.findByUserId as jest.Mock).mockResolvedValueOnce(
        [],
      );

      await expect(
        service.getInstallationAccessTokenForUser('user-1'),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns null when the installation token exchange fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'github down',
      } as unknown as Response);

      await expect(
        service.getInstallationAccessTokenForUser('user-1'),
      ).resolves.toBeNull();
    });
  });

  describe('getInstallationAccessTokenForUserRepo', () => {
    it('uses an all-repositories installation for the requested owner', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'owner-installation-token' }),
      } as unknown as Response);

      await expect(
        service.getInstallationAccessTokenForUserRepo('user-1', 'tone/api'),
      ).resolves.toBe('owner-installation-token');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/12345/access_tokens',
        expect.any(Object),
      );
    });

    it('uses the selected-repository installation that contains the requested repo', async () => {
      (installationsRepository.findByUserId as jest.Mock).mockResolvedValueOnce(
        [
          {
            installationId: 111,
            userId: 'user-1',
            accountLogin: 'other',
            accountId: 100,
            accountType: 'Organization',
            repositorySelection: 'selected',
            reposLinked: 1,
          },
          {
            installationId: 222,
            userId: 'user-1',
            accountLogin: 'tone',
            accountId: 99,
            accountType: 'Organization',
            repositorySelection: 'selected',
            reposLinked: 1,
          },
        ],
      );
      (
        installationsRepository.findReposByUserId as jest.Mock
      ).mockResolvedValueOnce([
        { installationId: 111, repoFullName: 'other/api' },
        { installationId: 222, repoFullName: 'tone/private-api' },
      ]);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'selected-installation-token' }),
      } as unknown as Response);

      await expect(
        service.getInstallationAccessTokenForUserRepo(
          'user-1',
          'tone/private-api',
        ),
      ).resolves.toBe('selected-installation-token');

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/app/installations/222/access_tokens',
        expect.any(Object),
      );
    });

    it('returns null when no linked installation covers the requested repo', async () => {
      (
        installationsRepository.findReposByUserId as jest.Mock
      ).mockResolvedValueOnce([]);

      await expect(
        service.getInstallationAccessTokenForUserRepo('user-1', 'other/api'),
      ).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('organization provisioning', () => {
    it('uses the explicitly selected linked organization installation', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'organization-token' }),
      } as unknown as Response);

      await expect(
        service.getOrganizationProvisioningContext('user-1', 12345),
      ).resolves.toEqual({
        accessToken: 'organization-token',
        ownerLogin: 'tone',
      });
    });

    it('resolves the enforced org installation app-to-org via the App JWT', async () => {
      // 1) GET /orgs/{org}/installation — app-level lookup, no per-user linkage.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 12345,
          account: { login: 'tone' },
          target_type: 'Organization',
          repository_selection: 'all',
        }),
      } as unknown as Response);
      // 2) POST installation access token.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'organization-token' }),
      } as unknown as Response);

      await expect(
        service.getOrganizationProvisioningContextByLogin('TONE'),
      ).resolves.toEqual({
        accessToken: 'organization-token',
        ownerLogin: 'tone',
      });
    });

    it('rejects with a server-config error when App credentials are missing', async () => {
      const noCreds = new GithubService(null, installationsRepository);

      await expect(
        noCreds.getOrganizationProvisioningContextByLogin('Alpha-Explora'),
      ).rejects.toThrow('GITHUB_APP_ID');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(installationsRepository.findByUserId).not.toHaveBeenCalled();
    });

    it('rejects when the App is not installed on the enforced org (404)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => 'Not Found',
      } as unknown as Response);

      await expect(
        service.getOrganizationProvisioningContextByLogin('Alpha-Explora'),
      ).rejects.toThrow(
        'The GitHub App is not installed on the Alpha-Explora organization',
      );
    });

    it('rejects when the enforced org installation lacks all-repositories access', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 12345,
          account: { login: 'tone' },
          target_type: 'Organization',
          repository_selection: 'selected',
        }),
      } as unknown as Response);

      await expect(
        service.getOrganizationProvisioningContextByLogin('TONE'),
      ).rejects.toThrow('requires "All repositories"');
    });
  });

  describe('GitHub webhooks', () => {
    it('verifies the signature and suspends a linked installation', async () => {
      const payload = {
        action: 'suspend',
        installation: { id: 12345 },
      };
      const rawBody = Buffer.from(JSON.stringify(payload));
      const signature = `sha256=${createHmac('sha256', 'webhook-secret')
        .update(rawBody)
        .digest('hex')}`;

      await expect(
        service.handleWebhook(
          signature,
          'installation',
          'delivery-1',
          rawBody,
          payload,
        ),
      ).resolves.toEqual({ accepted: true });

      expect(installationsRepository.setSuspended).toHaveBeenCalledWith(
        12345,
        true,
      );
      expect(
        installationsRepository.completeWebhookDelivery,
      ).toHaveBeenCalledWith('delivery-1');
    });

    it('rejects an invalid webhook signature', async () => {
      await expect(
        service.handleWebhook(
          'sha256=invalid',
          'installation',
          'delivery-2',
          Buffer.from('{}'),
          {},
        ),
      ).rejects.toThrow('Invalid GitHub webhook signature');
    });

    describe('repository deleted', () => {
      const sign = (payload: unknown) => {
        const rawBody = Buffer.from(JSON.stringify(payload));
        const signature = `sha256=${createHmac('sha256', 'webhook-secret')
          .update(rawBody)
          .digest('hex')}`;
        return { rawBody, signature };
      };

      it('emits repository.deleted with the repo full_name', async () => {
        const payload = {
          action: 'deleted',
          repository: { full_name: 'Alpha-Explora/some-repo' },
          installation: { id: 12345 },
        };
        const { rawBody, signature } = sign(payload);
        const listener = jest.fn();
        service.on('repository.deleted', listener);

        await expect(
          service.handleWebhook(
            signature,
            'repository',
            'delivery-repo-1',
            rawBody,
            payload,
          ),
        ).resolves.toEqual({ accepted: true });

        expect(listener).toHaveBeenCalledWith({
          repoFullName: 'Alpha-Explora/some-repo',
        });
        expect(
          installationsRepository.deleteInstallation,
        ).not.toHaveBeenCalled();
      });

      it('ignores repository events for actions other than deleted', async () => {
        const payload = {
          action: 'renamed',
          repository: { full_name: 'Alpha-Explora/some-repo' },
        };
        const { rawBody, signature } = sign(payload);
        const listener = jest.fn();
        service.on('repository.deleted', listener);

        await service.handleWebhook(
          signature,
          'repository',
          'delivery-repo-2',
          rawBody,
          payload,
        );

        expect(listener).not.toHaveBeenCalled();
      });

      it('does not emit when the repository object is missing', async () => {
        const payload = { action: 'deleted' };
        const { rawBody, signature } = sign(payload);
        const listener = jest.fn();
        service.on('repository.deleted', listener);

        await expect(
          service.handleWebhook(
            signature,
            'repository',
            'delivery-repo-3',
            rawBody,
            payload,
          ),
        ).resolves.toEqual({ accepted: true });

        expect(listener).not.toHaveBeenCalled();
      });

      it('does not emit when full_name is missing or not a string', async () => {
        const payload = {
          action: 'deleted',
          repository: { full_name: 42 },
        };
        const { rawBody, signature } = sign(payload);
        const listener = jest.fn();
        service.on('repository.deleted', listener);

        await expect(
          service.handleWebhook(
            signature,
            'repository',
            'delivery-repo-4',
            rawBody,
            payload,
          ),
        ).resolves.toEqual({ accepted: true });

        expect(listener).not.toHaveBeenCalled();
      });
    });
  });

  describe('GitHub App installation repository reads', () => {
    it('returns linked repos from persistence', async () => {
      (
        installationsRepository.findReposByUserId as jest.Mock
      ).mockResolvedValueOnce([{ fullName: 'tone/orders-api' }]);

      await expect(service.listLinkedRepos('user-1')).resolves.toEqual([
        { fullName: 'tone/orders-api' },
      ]);
    });

    it('returns an empty repo list when persistence read fails', async () => {
      (
        installationsRepository.findReposByUserId as jest.Mock
      ).mockRejectedValueOnce(new Error('db down'));

      await expect(service.listLinkedRepos('user-1')).resolves.toEqual([]);
    });

    it('returns installation accounts from persistence', async () => {
      await expect(service.listInstallationAccounts('user-1')).resolves.toEqual(
        [expect.objectContaining({ installationId: 12345 })],
      );
    });

    it('returns an empty account list when persistence read fails', async () => {
      (installationsRepository.findByUserId as jest.Mock).mockRejectedValueOnce(
        new Error('db down'),
      );

      await expect(service.listInstallationAccounts('user-1')).resolves.toEqual(
        [],
      );
    });
  });

  describe('repoExists', () => {
    it.each([
      [200, true],
      [404, false],
    ])('maps GitHub status %s to %s', async (status, expected) => {
      fetchMock.mockResolvedValueOnce({
        status,
        text: async () => '',
      } as unknown as Response);

      await expect(
        service.repoExists('gh-token', 'tone/orders-api'),
      ).resolves.toBe(expected);
    });

    it.each([401, 403, 503])(
      'throws on status %s instead of reporting not-found — a rejected token or rate limit is not proof the repo is gone',
      async (status) => {
        fetchMock.mockResolvedValueOnce({
          status,
          text: async () => 'denied',
        } as unknown as Response);

        await expect(
          service.repoExists('gh-token', 'tone/orders-api'),
        ).rejects.toThrow(
          `GitHub repo existence check failed (${String(status)}): denied`,
        );
      },
    );
  });

  describe('deleteRepoForUser', () => {
    it('resolves on a 204 success response', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 204,
        text: async () => '',
      } as unknown as Response);

      await expect(
        service.deleteRepoForUser('gh-token', 'tone', 'orders-api'),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/tone/orders-api',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('throws a not_found GithubRepoDeleteError on 404', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 404,
        text: async () => 'Not Found',
      } as unknown as Response);

      const error = await service
        .deleteRepoForUser('gh-token', 'tone', 'orders-api')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GithubRepoDeleteError);
      expect((error as GithubRepoDeleteError).code).toBe('not_found');
    });

    it.each([403, 401])(
      'throws a missing_scope GithubRepoDeleteError on %s',
      async (status) => {
        fetchMock.mockResolvedValueOnce({
          status,
          text: async () => 'Resource not accessible by integration',
        } as unknown as Response);

        const error = await service
          .deleteRepoForUser('gh-token', 'tone', 'orders-api')
          .catch((e: unknown) => e);

        expect(error).toBeInstanceOf(GithubRepoDeleteError);
        expect((error as GithubRepoDeleteError).code).toBe('missing_scope');
        expect((error as GithubRepoDeleteError).message).toContain(
          'reconnect your GitHub account',
        );
      },
    );

    it('throws an other GithubRepoDeleteError on unexpected statuses', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 503,
        text: async () => 'unavailable',
      } as unknown as Response);

      const error = await service
        .deleteRepoForUser('gh-token', 'tone', 'orders-api')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(GithubRepoDeleteError);
      expect((error as GithubRepoDeleteError).code).toBe('other');
    });

    it('does not swallow errors the way deleteRepo() does (never resolves false)', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 403,
        text: async () => '',
      } as unknown as Response);

      // deleteRepo() would resolve to `false` here; deleteRepoForUser() must
      // reject so the caller can surface the failure reason to the user.
      await expect(
        service.deleteRepoForUser('gh-token', 'tone', 'orders-api'),
      ).rejects.toThrow(GithubRepoDeleteError);
    });
  });

  describe('listRepos', () => {
    it('returns a mapped repository by owner and name', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => makeRepo({ default_branch: 'master' }),
      } as unknown as Response);

      await expect(
        service.getRepo('gh-token', 'user', 'my-repo'),
      ).resolves.toMatchObject({
        fullName: 'user/my-repo',
        defaultBranch: 'master',
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/user/my-repo',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
          }),
        }),
      );
    });

    it('returns mapped repos on success', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRepo()],
      } as unknown as Response);

      const result = await service.listRepos('gh-token');

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('api.github.com/user/repos'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer gh-token',
          }),
        }),
      );

      expect(result).toEqual([
        {
          id: 1,
          name: 'my-repo',
          fullName: 'user/my-repo',
          private: false,
          description: 'A test repo',
          defaultBranch: 'main',
          htmlUrl: 'https://github.com/user/my-repo',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ]);
    });

    it('returns empty array when response is not ok', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: 'Unauthorized' }),
      } as unknown as Response);

      const result = await service.listRepos('bad-token');
      expect(result).toEqual([]);
    });

    it('maps null description correctly', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRepo({ description: null })],
      } as unknown as Response);

      const result = await service.listRepos('gh-token');
      expect(result[0]?.description).toBeNull();
    });

    it('maps private repos correctly', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [makeRepo({ private: true })],
      } as unknown as Response);

      const result = await service.listRepos('gh-token');
      expect(result[0]?.private).toBe(true);
    });

    it('returns empty array for empty response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      } as unknown as Response);

      const result = await service.listRepos('gh-token');
      expect(result).toEqual([]);
    });
  });

  describe('repository writes', () => {
    it('throws when getRepo receives a non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'not found',
      } as unknown as Response);

      await expect(
        service.getRepo('gh-token', 'tone', 'missing'),
      ).rejects.toThrow('GitHub repo lookup failed (404): not found');
    });

    it('creates a repository inside the enforced organization, never a personal account', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/Alpha-Explora/orders-api',
          clone_url: 'https://github.com/Alpha-Explora/orders-api.git',
          owner: { login: 'Alpha-Explora' },
          name: 'orders-api',
        }),
      } as unknown as Response);

      await expect(
        service.createRepo('gh-token', {
          repoName: 'orders-api',
          description: 'Orders API',
          private: true,
        }),
      ).resolves.toEqual({
        repoUrl: 'https://github.com/Alpha-Explora/orders-api',
        cloneUrl: 'https://github.com/Alpha-Explora/orders-api.git',
        ownerLogin: 'Alpha-Explora',
        repoName: 'orders-api',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/orgs/Alpha-Explora/repos',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            name: 'orders-api',
            description: 'Orders API',
            private: true,
            auto_init: true,
            default_branch: 'main',
          }),
        }),
      );
      // The personal /user/repos endpoint must never be reached.
      expect(fetchMock).not.toHaveBeenCalledWith(
        'https://api.github.com/user/repos',
        expect.anything(),
      );
    });

    it('uses an empty description when creating a repository without one', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/Alpha-Explora/orders-api',
          clone_url: 'https://github.com/Alpha-Explora/orders-api.git',
          owner: { login: 'Alpha-Explora' },
          name: 'orders-api',
        }),
      } as unknown as Response);

      await service.createRepo('gh-token', {
        repoName: 'orders-api',
        private: false,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/orgs/Alpha-Explora/repos'),
        expect.objectContaining({
          body: expect.stringContaining('"description":""'),
        }),
      );
    });

    it.each([
      [403, 'GitHub denied repository creation in organization Alpha-Explora'],
      [401, 'GitHub denied repository creation in organization Alpha-Explora'],
      [404, 'GitHub organization Alpha-Explora is unavailable'],
      [422, 'Repository already exists in Alpha-Explora'],
      [500, 'GitHub repo creation failed (500):'],
    ])(
      'maps org repo creation status %s to a useful exception',
      async (status, message) => {
        fetchMock.mockResolvedValueOnce({
          ok: false,
          status,
          text: async () => 'failure body',
        } as unknown as Response);

        await expect(
          service.createRepo('gh-token', {
            repoName: 'orders-api',
            private: true,
          }),
        ).rejects.toThrow(message);
      },
    );

    it('falls back to the default enforced org when config resolves empty', async () => {
      // Defense in depth: even if the `app` config namespace yields an empty
      // enforcedOrg (misconfiguration or a config/DI failure), creation must
      // still lock to the hardcoded default org rather than surfacing the
      // misleading "no destination org configured" error.
      const unconfiguredService = new GithubService(
        makeConfigService({
          ...appConfig,
          github: { ...appConfig.github, enforcedOrg: '' },
        }),
        installationsRepository,
      );
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/Alpha-Explora/orders-api',
          clone_url: 'https://github.com/Alpha-Explora/orders-api.git',
          owner: { login: 'Alpha-Explora' },
          name: 'orders-api',
        }),
      } as unknown as Response);

      await unconfiguredService.createRepo('gh-token', {
        repoName: 'orders-api',
        private: true,
      });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/orgs/Alpha-Explora/repos',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('returns the default enforced org from getEnforcedOrg even without ConfigService', () => {
      const noConfigService = new GithubService(null, installationsRepository);
      expect(noConfigService.getEnforcedOrg()).toBe('Alpha-Explora');
    });

    it('creates an organization repository with a user OAuth token when an owner is selected', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/tone/orders-api',
          clone_url: 'https://github.com/tone/orders-api.git',
          owner: { login: 'tone' },
          name: 'orders-api',
        }),
      } as unknown as Response);

      await service.createRepo(
        'oauth-user-token',
        { repoName: 'orders-api', private: true },
        'tone',
      );

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/orgs/tone/repos',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('forces creation into the enforced org when no owner is provided', async () => {
      const enforcedService = new GithubService(
        makeConfigService({
          ...appConfig,
          github: { ...appConfig.github, enforcedOrg: 'Alpha-Explora' },
        }),
        installationsRepository,
      );
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/Alpha-Explora/orders-api',
          clone_url: 'https://github.com/Alpha-Explora/orders-api.git',
          owner: { login: 'Alpha-Explora' },
          name: 'orders-api',
        }),
      } as unknown as Response);

      await expect(
        enforcedService.createRepo('gh-token', {
          repoName: 'orders-api',
          private: true,
        }),
      ).resolves.toMatchObject({ ownerLogin: 'Alpha-Explora' });

      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/orgs/Alpha-Explora/repos',
        expect.objectContaining({ method: 'POST' }),
      );
      // The personal /user/repos endpoint must never be reached.
      expect(fetchMock).not.toHaveBeenCalledWith(
        'https://api.github.com/user/repos',
        expect.anything(),
      );
    });

    it('creates a branch from an existing source branch ref', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ object: { sha: 'base-sha' } }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
        } as unknown as Response);

      await expect(
        service.createBranch('gh-token', 'tone', 'orders-api', 'test', 'main'),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/tone/orders-api/git/refs',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            ref: 'refs/heads/test',
            sha: 'base-sha',
          }),
        }),
      );
    });

    it('throws when branch creation fails after source branch lookup', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ object: { sha: 'base-sha' } }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          text: async () => 'already exists',
        } as unknown as Response);

      await expect(
        service.createBranch('gh-token', 'tone', 'orders-api', 'test', 'main'),
      ).rejects.toThrow("Branch 'test' creation failed (422): already exists");
    });
  });

  describe('file and pull request operations', () => {
    it('returns null when a GitHub file is missing', async () => {
      fetchMock.mockResolvedValueOnce({ status: 404 } as unknown as Response);

      await expect(
        service.getFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'test',
        ),
      ).resolves.toBeNull();
    });

    it('decodes base64 GitHub file content', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({
          content: Buffer.from('name: CI').toString('base64'),
          encoding: 'base64',
        }),
      } as unknown as Response);

      await expect(
        service.getFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'test',
        ),
      ).resolves.toBe('name: CI');
    });

    it('returns null when GitHub content response is not base64 content', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        ok: true,
        json: async () => ({ content: 'plain', encoding: 'utf-8' }),
      } as unknown as Response);

      await expect(
        service.getFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'test',
        ),
      ).resolves.toBeNull();
    });

    it('throws when GitHub file read fails', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 500,
        ok: false,
        text: async () => 'server error',
      } as unknown as Response);

      await expect(
        service.getFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'test',
        ),
      ).rejects.toThrow('GitHub file read failed (500): server error');
    });

    it('updates an existing GitHub file and returns commit metadata', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ sha: 'existing-sha' }),
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            commit: {
              sha: 'commit-sha',
              html_url: 'https://github.com/tone/orders-api/commit/commit-sha',
            },
          }),
        } as unknown as Response);

      await expect(
        service.putFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'name: CI',
          'test',
          'Update workflow',
        ),
      ).resolves.toEqual({
        commitSha: 'commit-sha',
        commitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/tone/orders-api/contents/ci.yml',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"sha":"existing-sha"'),
        }),
      );
    });

    it('creates a new GitHub file when no existing file is found', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            content: {
              html_url: 'https://github.com/tone/orders-api/blob/test/ci.yml',
            },
            commit: { sha: 'commit-sha' },
          }),
        } as unknown as Response);

      await expect(
        service.putFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'name: CI',
          'test',
          'Create workflow',
        ),
      ).resolves.toEqual({
        commitSha: 'commit-sha',
        commitUrl: 'https://github.com/tone/orders-api/blob/test/ci.yml',
      });
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: expect.not.stringContaining('"sha"'),
        }),
      );
    });

    it('throws when existing file lookup fails before write', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'lookup failed',
      } as unknown as Response);

      await expect(
        service.putFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'name: CI',
          'test',
          'Update workflow',
        ),
      ).rejects.toThrow('GitHub file lookup failed (500): lookup failed');
    });

    it('throws when GitHub file write fails', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
        } as unknown as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          text: async () => 'write failed',
        } as unknown as Response);

      await expect(
        service.putFileContent(
          'gh-token',
          'tone',
          'orders-api',
          'ci.yml',
          'name: CI',
          'test',
          'Update workflow',
        ),
      ).rejects.toThrow('GitHub file write failed (500): write failed');
    });

    it('creates a pull request and maps the response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          html_url: 'https://github.com/tone/orders-api/pull/42',
        }),
      } as unknown as Response);

      await expect(
        service.createPullRequest('gh-token', 'tone', 'orders-api', {
          title: 'Update workflow',
          head: 'alphaci/update',
          base: 'test',
        }),
      ).resolves.toEqual({
        number: 42,
        htmlUrl: 'https://github.com/tone/orders-api/pull/42',
      });
    });

    it('throws when pull request creation fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () => 'validation failed',
      } as unknown as Response);

      await expect(
        service.createPullRequest('gh-token', 'tone', 'orders-api', {
          title: 'Update workflow',
          head: 'alphaci/update',
          base: 'test',
        }),
      ).rejects.toThrow(
        'GitHub pull request creation failed (422): validation failed',
      );
    });

    it('throws when pull request response is incomplete', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ number: 42 }),
      } as unknown as Response);

      await expect(
        service.createPullRequest('gh-token', 'tone', 'orders-api', {
          title: 'Update workflow',
          head: 'alphaci/update',
          base: 'test',
        }),
      ).rejects.toThrow('GitHub pull request response was incomplete');
    });
  });

  describe('secrets and branch protection', () => {
    it('skips setting a secret when token is missing by default', async () => {
      await expect(
        service.setActionsSecret(
          null,
          'tone',
          'orders-api',
          'ALPHACI_TOKEN',
          'x',
        ),
      ).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws when strict secret setting has no token', async () => {
      await expect(
        service.setActionsSecret(
          undefined,
          'tone',
          'orders-api',
          'ALPHACI_TOKEN',
          'x',
          {
            throwOnFailure: true,
          },
        ),
      ).rejects.toThrow('setActionsSecret: no token available');
    });

    it('returns without throwing when public key lookup fails in non-strict mode', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'missing',
      } as unknown as Response);

      await expect(
        service.setActionsSecret(
          'gh-token',
          'tone',
          'orders-api',
          'ALPHACI_TOKEN',
          'x',
        ),
      ).resolves.toBeUndefined();
    });

    it('throws when public key lookup fails in strict mode', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'key failed',
      } as unknown as Response);

      await expect(
        service.setActionsSecretStrict(
          'gh-token',
          'tone',
          'orders-api',
          'ALPHACI_TOKEN',
          'x',
        ),
      ).rejects.toThrow('setActionsSecret: failed to fetch public key');
    });

    it('applies branch protection with the expected GitHub endpoint', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response);

      await expect(
        service.applyBranchProtection('gh-token', 'tone', 'orders-api', 'test'),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/tone/orders-api/branches/test/protection',
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('requires the env-guard status check on protected branches by default', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response);

      await service.applyBranchProtection(
        'gh-token',
        'tone',
        'orders-api',
        'test',
      );

      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        required_status_checks: { strict: boolean; contexts: string[] } | null;
      };
      expect(body.required_status_checks).toEqual({
        strict: false,
        contexts: ['env-guard'],
      });
    });

    it('omits required status checks when explicitly given none', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true } as unknown as Response);

      await service.applyBranchProtection(
        'gh-token',
        'tone',
        'orders-api',
        'test',
        [],
      );

      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      const body = JSON.parse(init.body) as {
        required_status_checks: unknown;
      };
      expect(body.required_status_checks).toBeNull();
    });

    it('does not throw when branch protection fails', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 403,
      } as unknown as Response);

      await expect(
        service.applyBranchProtection('gh-token', 'tone', 'orders-api', 'main'),
      ).resolves.toBeUndefined();
    });
  });
});
