import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';

import { EnvTokenEncryptionService } from './encryption.service';
import { DeploymentTargetsRepository } from './deployment-targets.repository';
import { EnvVarsRepository } from './env-vars.repository';
import { EnvVarsService } from './env-vars.service';
import { ProviderClientRegistry } from './provider-clients/provider-client.registry';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { AuditEventsService } from '../audit/audit-events.service';
import { NotificationEventsService } from '../notifications/index.js';
import { UsageQuotaService } from '../usage/usage-quota.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

describe('EnvVarsService', () => {
  async function createService(
    overrides: {
      envVarsRepository?: Partial<Record<string, jest.Mock>>;
      deploymentTarget?: Record<string, unknown> | null;
      providerClient?: Partial<Record<string, jest.Mock>>;
      usageQuotaService?: Partial<Record<string, jest.Mock>>;
      workspaceAccessService?: Partial<Record<string, jest.Mock>>;
      auditEventsService?: Partial<Record<string, jest.Mock>>;
      notificationEventsService?: Partial<Record<string, jest.Mock>>;
    } = {},
  ) {
    const envVarsRepository = {
      listEnvMetadata: jest.fn(),
      listEnvMetadataForUser: jest.fn(),
      countExistingActiveKeys: jest.fn().mockResolvedValue(0),
      findEnvMetadataForUser: jest.fn(),
      markEnvMetadataRemoved: jest.fn(),
      upsertEnvMetadataBatch: jest.fn(),
      ...overrides.envVarsRepository,
    };
    const deploymentTargetsRepository = {
      findDeploymentTargetForUser: jest.fn().mockResolvedValue(
        overrides.deploymentTarget === null
          ? null
          : {
              id: 'target-1',
              projectId: 'project-1',
              ownershipMode: 'flowci_managed',
              provider: 'render',
              providerConnectionId: null,
              providerProjectId: 'srv-1',
              ...overrides.deploymentTarget,
            },
      ),
    };
    const providerClient = {
      upsertEnvironmentVariables: jest.fn().mockResolvedValue({
        provisioned: [{ key: 'DATABASE_URL', status: 'provisioned' }],
        failed: [],
      }),
      deleteEnvironmentVariable: jest.fn().mockResolvedValue({
        key: 'DATABASE_URL',
        status: 'removed',
      }),
      ...overrides.providerClient,
    };
    const module = await Test.createTestingModule({
      providers: [
        EnvVarsService,
        { provide: EnvVarsRepository, useValue: envVarsRepository },
        {
          provide: DeploymentTargetsRepository,
          useValue: deploymentTargetsRepository,
        },
        {
          provide: ProviderConnectionsRepository,
          useValue: { findActiveProviderConnection: jest.fn() },
        },
        {
          provide: ProviderClientRegistry,
          useValue: { getClient: jest.fn().mockReturnValue(providerClient) },
        },
        {
          provide: EnvTokenEncryptionService,
          useValue: { decrypt: jest.fn() },
        },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn().mockReturnValue({
              envProvisioning: {
                flowciManaged: {
                  renderToken: 'rnd',
                  vercelToken: 'vercel-token',
                },
              },
            }),
          },
        },
        {
          provide: UsageQuotaService,
          useValue: {
            assertWithinLimit: jest.fn(),
            ...overrides.usageQuotaService,
          },
        },
        {
          provide: WorkspaceAccessService,
          useValue: {
            assertProjectRole: jest.fn().mockResolvedValue({
              workspaceId: 'workspace-1',
              userId: 'user-1',
              role: 'member',
            }),
            ...overrides.workspaceAccessService,
          },
        },
        {
          provide: AuditEventsService,
          useValue: {
            recordProjectEvent: jest.fn(),
            ...overrides.auditEventsService,
          },
        },
        {
          provide: NotificationEventsService,
          useValue: {
            record: jest.fn(),
            ...overrides.notificationEventsService,
          },
        },
      ],
    }).compile();

    return {
      auditEventsService: module.get(AuditEventsService),
      deploymentTargetsRepository,
      envVarsRepository,
      notificationEventsService: module.get(NotificationEventsService),
      providerClient,
      usageQuotaService: module.get(UsageQuotaService),
      workspaceAccessService: module.get(WorkspaceAccessService),
      service: module.get(EnvVarsService),
    };
  }

  it('lists env metadata through the user-scoped repository method', async () => {
    const { envVarsRepository, service } = await createService({
      envVarsRepository: {
        listEnvMetadataForUser: jest.fn().mockResolvedValue([
          {
            id: 'meta-1',
            projectId: 'project-1',
            deploymentTargetId: 'target-1',
            environment: 'test',
            key: 'DATABASE_URL',
            provider: 'render',
            valueStored: false,
            lastProvisionedAt: '2026-06-12T00:00:00.000Z',
            lastProvisionedBy: 'user-1',
            status: 'provisioned',
            errorSummary: null,
            removedAt: null,
          },
        ]),
      },
    });

    await expect(
      service.listEnvMetadata('project-1', 'user-1'),
    ).resolves.toHaveLength(1);

    expect(envVarsRepository.listEnvMetadataForUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(envVarsRepository.listEnvMetadata).not.toHaveBeenCalled();
  });

  it('stores metadata only after provider env provisioning', async () => {
    const {
      auditEventsService,
      envVarsRepository,
      notificationEventsService,
      service,
      workspaceAccessService,
    } = await createService();

    await service.provisionEnvVars('project-1', 'user-1', {
      deploymentTargetId: 'target-1',
      environment: 'test',
      vars: [{ key: 'DATABASE_URL', value: 'postgres://secret' }],
    });

    expect(envVarsRepository.upsertEnvMetadataBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [
          expect.objectContaining({
            key: 'DATABASE_URL',
            status: 'provisioned',
          }),
        ],
      }),
    );
    expect(
      JSON.stringify(envVarsRepository.upsertEnvMetadataBatch.mock.calls),
    ).not.toContain('postgres://secret');
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'env_vars_provisioned',
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'project-1',
        eventCode: 'env_vars_provisioned',
      }),
    );
  });

  it('charges env key quota only for new keys', async () => {
    const { envVarsRepository, service, usageQuotaService } =
      await createService({
        envVarsRepository: {
          countExistingActiveKeys: jest.fn().mockResolvedValue(1),
        },
      });

    await service.provisionEnvVars('project-1', 'user-1', {
      deploymentTargetId: 'target-1',
      environment: 'test',
      vars: [
        { key: 'DATABASE_URL', value: 'postgres://secret' },
        { key: 'API_URL', value: 'https://api.example.test' },
      ],
    });

    expect(envVarsRepository.countExistingActiveKeys).toHaveBeenCalledWith({
      deploymentTargetId: 'target-1',
      environment: 'test',
      keys: ['DATABASE_URL', 'API_URL'],
    });
    expect(usageQuotaService.assertWithinLimit).toHaveBeenCalledWith(
      'user-1',
      'env_keys',
      1,
    );
  });

  it('parses .env text without returning secret values', async () => {
    const { service } = await createService();

    await expect(
      service.validateEnvText('project-1', 'user-1', {
        deploymentTargetId: 'target-1',
        environment: 'test',
        text: 'DATABASE_URL=postgres://secret\nAPI_KEY="super-secret"\n# ignored\nEMPTY=',
      }),
    ).resolves.toEqual({
      keyCount: 3,
      keys: ['DATABASE_URL', 'API_KEY', 'EMPTY'],
      duplicates: [],
      invalidKeys: [],
      warnings: [],
    });
  });

  it('detects duplicate and invalid keys during .env validation', async () => {
    const { service } = await createService();

    await expect(
      service.validateEnvText('project-1', 'user-1', {
        deploymentTargetId: 'target-1',
        environment: 'test',
        text: 'DATABASE_URL=one\nDATABASE_URL=two\nbad-key=value',
      }),
    ).resolves.toMatchObject({
      keyCount: 3,
      keys: ['DATABASE_URL'],
      duplicates: ['DATABASE_URL'],
      invalidKeys: ['bad-key'],
    });
  });

  it('deletes Vercel env metadata and provider key', async () => {
    const {
      auditEventsService,
      envVarsRepository,
      providerClient,
      service,
      workspaceAccessService,
    } = await createService({
      deploymentTarget: {
        provider: 'vercel',
        providerProjectId: 'prj_1',
      },
      envVarsRepository: {
        findEnvMetadataForUser: jest.fn().mockResolvedValue({
          id: 'meta-1',
          projectId: 'project-1',
          deploymentTargetId: 'target-1',
          environment: 'production',
          key: 'DATABASE_URL',
          provider: 'vercel',
          status: 'provisioned',
        }),
        markEnvMetadataRemoved: jest.fn().mockResolvedValue({
          id: 'meta-1',
          key: 'DATABASE_URL',
          status: 'removed',
        }),
      },
    });

    await expect(
      service.deleteEnvMetadata('project-1', 'meta-1', 'user-1'),
    ).resolves.toMatchObject({
      removed: true,
      key: 'DATABASE_URL',
    });

    expect(providerClient.deleteEnvironmentVariable).toHaveBeenCalledWith({
      token: 'vercel-token',
      targetId: 'prj_1',
      environment: 'production',
      key: 'DATABASE_URL',
    });
    expect(envVarsRepository.markEnvMetadataRemoved).toHaveBeenCalledWith(
      'meta-1',
      'user-1',
      null,
    );
    expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      ['admin', 'delegated_lead', 'member'],
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'env_var_removed',
      }),
    );
  });

  it('deletes Render env metadata and provider key where supported', async () => {
    const { envVarsRepository, providerClient, service } = await createService({
      envVarsRepository: {
        findEnvMetadataForUser: jest.fn().mockResolvedValue({
          id: 'meta-1',
          projectId: 'project-1',
          deploymentTargetId: 'target-1',
          environment: 'test',
          key: 'API_KEY',
          provider: 'render',
          status: 'provisioned',
        }),
        markEnvMetadataRemoved: jest.fn().mockResolvedValue({
          id: 'meta-1',
          key: 'API_KEY',
          status: 'removed',
        }),
      },
    });

    await expect(
      service.deleteEnvMetadata('project-1', 'meta-1', 'user-1'),
    ).resolves.toMatchObject({
      removed: true,
      key: 'API_KEY',
    });

    expect(providerClient.deleteEnvironmentVariable).toHaveBeenCalledWith({
      token: 'rnd',
      targetId: 'srv-1',
      environment: 'test',
      key: 'API_KEY',
    });
    expect(envVarsRepository.markEnvMetadataRemoved).toHaveBeenCalledWith(
      'meta-1',
      'user-1',
      null,
    );
  });
});
