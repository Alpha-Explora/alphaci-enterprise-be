import { readFile } from 'node:fs/promises';

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

import type { CatalogService } from '../catalog/catalog.service.js';
import type { CiService } from '../ci/ci.service.js';
import { GithubRepoDeleteError } from '../github/github.service.js';
import type { GithubService } from '../github/github.service.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import type { WorkspaceAccessService } from '../workspaces/workspace-access.service.js';
import type { ProjectsRepository } from './projects.repository.js';
import { ProjectsService } from './projects.service.js';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;

const makeCatalogService = () =>
  ({
    getProjectOptions: jest.fn().mockReturnValue({
      recipes: [
        {
          id: 'backend-api-ci',
          templateByProjectType: { 'nestjs-api': 'be-nestjs' },
        },
      ],
    }),
    getTemplateById: jest.fn().mockResolvedValue({
      id: 'be-nestjs',
      name: 'Backend API',
      workflowPath: 'workflow-templates/be-nestjs.yml',
    }),
  }) as unknown as CatalogService;

const makeGithubService = () =>
  ({
    on: jest.fn(),
    getInstallationAccessTokenForUser: jest.fn().mockResolvedValue('app-token'),
    getInstallationAccessTokenForUserRepo: jest
      .fn()
      .mockResolvedValue('app-token'),
    getInstallationOwnerLogin: jest.fn().mockResolvedValue(undefined),
    getEnforcedOrg: jest.fn().mockReturnValue(''),
    getOrganizationProvisioningContext: jest.fn().mockResolvedValue({
      accessToken: 'installation-token',
      ownerLogin: 'tone',
    }),
    getOrganizationProvisioningContextByLogin: jest.fn().mockResolvedValue({
      accessToken: 'installation-token',
      ownerLogin: 'Alpha-Explora',
    }),
    createRepo: jest.fn().mockResolvedValue({
      repoUrl: 'https://github.com/tone/orders-api',
      cloneUrl: 'https://github.com/tone/orders-api.git',
      ownerLogin: 'tone',
      repoName: 'orders-api',
    }),
    createBranch: jest.fn().mockResolvedValue(undefined),
    putFileContent: jest.fn().mockResolvedValue({
      commitSha: 'commit-sha',
      commitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
    }),
    createPullRequest: jest.fn().mockResolvedValue({
      number: 42,
      htmlUrl: 'https://github.com/tone/orders-api/pull/42',
    }),
    getRepo: jest.fn().mockResolvedValue({
      fullName: 'tone/orders-api',
      htmlUrl: 'https://github.com/tone/orders-api',
      defaultBranch: 'main',
      private: false,
    }),
    applyBranchProtection: jest.fn().mockResolvedValue(undefined),
    setActionsSecret: jest.fn().mockResolvedValue(undefined),
    setActionsSecretStrict: jest.fn().mockResolvedValue(undefined),
    deleteRepo: jest.fn().mockResolvedValue(true),
    deleteRepoForUser: jest.fn().mockResolvedValue(undefined),
    // Onboarding an existing repository (2026-08-18). Defaults describe a
    // clean repo: no secrets set, no uat branch yet.
    listActionsSecretNames: jest.fn().mockResolvedValue(new Set<string>()),
    deleteActionsSecret: jest.fn().mockResolvedValue(undefined),
    branchExists: jest.fn().mockResolvedValue(false),
    requiresPullRequestToPush: jest.fn().mockResolvedValue(false),
  }) as unknown as GithubService;

const makeProjectsRepository = () =>
  ({
    create: jest.fn().mockResolvedValue({
      id: 'project-1',
    }),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    deleteByIdAndUser: jest.fn().mockResolvedValue(true),
    findByIdAndUser: jest.fn().mockResolvedValue({
      id: 'project-1',
      repo_full_name: 'tone/orders-api',
    }),
    listByUser: jest.fn().mockResolvedValue([]),
  }) as unknown as ProjectsRepository;

const makeWorkspaceAccessService = (
  overrides: Partial<{ assertProjectRole: jest.Mock }> = {},
) =>
  ({
    assertProjectRole: jest.fn().mockResolvedValue(null),
    ...overrides,
  }) as unknown as WorkspaceAccessService;

const makeCiService = () =>
  ({
    issueProjectToken: jest.fn().mockResolvedValue({
      token: 'flowci-token',
    }),
  }) as unknown as CiService;

const makeWorkspacesService = () =>
  ({
    getMyWorkspaces: jest.fn().mockResolvedValue({
      enabled: true,
      items: [
        {
          id: 'workspace-1',
          name: 'Personal workspace',
          kind: 'personal',
          role: 'admin',
        },
      ],
    }),
  }) as unknown as WorkspacesService;

const makeOverviewReadRepositories = () => ({
  ciTokensRepository: {
    findProjectTokenStatus: jest.fn().mockResolvedValue({
      status: 'active',
      tokenPrefix: 'aci_test',
      createdAt: '2026-06-12T00:00:00.000Z',
      updatedAt: '2026-06-12T00:00:00.000Z',
      revokedAt: null,
    }),
  },
  deploymentTargetsRepository: {
    listDeploymentTargets: jest.fn().mockResolvedValue([
      {
        id: 'target-1',
        projectId: 'project-1',
        slot: 'backend',
        ownershipMode: 'flowci_managed',
        provider: 'render',
        providerConnectionId: null,
        providerProjectId: 'srv-123',
        providerProjectName: 'orders-api-test',
        repoFullName: 'tone/orders-api',
        branchName: 'test',
        rootDirectory: '.',
        buildCommand: 'npm run build',
        startCommand: 'npm run start:prod',
        environmentMap: {},
        deploymentStrategy: 'render_image_pushed',
        providerMetadata: {},
        status: 'active',
      },
    ]),
  },
  envVarsRepository: {
    listEnvMetadata: jest.fn().mockResolvedValue([
      {
        id: 'env-1',
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
      },
    ]),
  },
  workflowHistoryRepository: {
    listByUser: jest.fn().mockResolvedValue([
      {
        id: 'history-1',
        createdAt: '2026-06-12T00:00:00.000Z',
        templateId: 'be-nestjs',
        templateName: 'Backend API',
        stack: 'nestjs',
        serviceName: 'orders-api',
        outputFileName: '00-alphaci-access.yml',
        sourceWorkflowFile: 'workflow-templates/be-nestjs.yml',
        sourcePropertiesFile: 'workflow-templates/be-nestjs.properties',
        lineCount: 42,
        yaml: 'name: ALPHACI Access Gate',
      },
      {
        id: 'history-other',
        createdAt: '2026-06-11T00:00:00.000Z',
        templateId: 'other',
        templateName: 'Other',
        stack: 'nodejs',
        serviceName: 'other',
        outputFileName: 'other.yml',
        sourceWorkflowFile: 'workflow-templates/other.yml',
        sourcePropertiesFile: 'workflow-templates/other.properties',
        lineCount: 10,
        yaml: 'name: Other',
      },
    ]),
    listForProjectIdentity: jest.fn().mockResolvedValue([
      {
        id: 'history-1',
        createdAt: '2026-06-12T00:00:00.000Z',
        templateId: 'be-nestjs',
        templateName: 'Backend API',
        stack: 'nestjs',
        serviceName: 'orders-api',
        outputFileName: '00-alphaci-access.yml',
        sourceWorkflowFile: 'workflow-templates/be-nestjs.yml',
        sourcePropertiesFile: 'workflow-templates/be-nestjs.properties',
        lineCount: 42,
        yaml: 'name: ALPHACI Access Gate',
      },
    ]),
  },
  dashboardSnapshotsRepository: {
    findLatestByProject: jest.fn().mockResolvedValue(null),
    createSnapshot: jest.fn().mockResolvedValue({
      id: 'snapshot-1',
      projectId: 'project-1',
      status: 'ok',
      summary: {
        mode: 'local_snapshot',
        projectId: 'project-1',
      },
      findings: [],
      startedAt: '2026-06-12T00:00:00.000Z',
      completedAt: '2026-06-12T00:00:01.000Z',
      createdBy: 'user-1',
      createdAt: '2026-06-12T00:00:01.000Z',
    }),
  },
  workflowSettingsRepository: {
    findByProject: jest.fn().mockResolvedValue(null),
  },
  workflowUpdateRequestsRepository: {
    createRequest: jest.fn().mockResolvedValue({
      id: 'request-1',
      projectId: 'project-1',
      branchName: 'alphaci/workflow-update-20260612000000',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
      status: 'created',
    }),
  },
});

const makeProjectFeatureConfig = (options?: {
  syncSnapshots?: boolean;
  workflowSettingsPreview?: boolean;
  workflowUpdatePr?: boolean;
}) =>
  ({
    getOrThrow: jest.fn().mockReturnValue({
      projectSyncSnapshots: {
        enabled: options?.syncSnapshots ?? true,
      },
      workflowSettingsPreview: {
        enabled: options?.workflowSettingsPreview ?? false,
      },
      workflowUpdatePr: {
        enabled: options?.workflowUpdatePr ?? false,
      },
    }),
  }) as never;

describe('ProjectsService', () => {
  let service: ProjectsService;
  let githubService: GithubService;
  let githubServiceMock: {
    getInstallationAccessTokenForUser: jest.Mock;
    getInstallationAccessTokenForUserRepo: jest.Mock;
    getEnforcedOrg: jest.Mock;
    getOrganizationProvisioningContext: jest.Mock;
    getOrganizationProvisioningContextByLogin: jest.Mock;
    createRepo: jest.Mock;
    createBranch: jest.Mock;
    applyBranchProtection: jest.Mock;
    setActionsSecretStrict: jest.Mock;
    setActionsSecret: jest.Mock;
    getRepo: jest.Mock;
    branchExists: jest.Mock;
    listActionsSecretNames: jest.Mock;
    deleteActionsSecret: jest.Mock;
  };
  let projectDeploymentProvisioningService: {
    provisionForProject: jest.Mock;
  };
  let pushWorkflowFileSpy: jest.SpyInstance;

  beforeEach(() => {
    mockedReadFile.mockResolvedValue(`
name: CI
on:
  workflow_dispatch:
    inputs: {}
jobs:
  pipeline:
    with: {}
`);

    githubService = makeGithubService();
    githubServiceMock = githubService as unknown as {
      getInstallationAccessTokenForUser: jest.Mock;
      getInstallationAccessTokenForUserRepo: jest.Mock;
      getEnforcedOrg: jest.Mock;
      getOrganizationProvisioningContext: jest.Mock;
      getOrganizationProvisioningContextByLogin: jest.Mock;
      createRepo: jest.Mock;
      createBranch: jest.Mock;
      applyBranchProtection: jest.Mock;
      setActionsSecretStrict: jest.Mock;
      setActionsSecret: jest.Mock;
      getRepo: jest.Mock;
      branchExists: jest.Mock;
      listActionsSecretNames: jest.Mock;
      deleteActionsSecret: jest.Mock;
    };
    projectDeploymentProvisioningService = {
      provisionForProject: jest.fn().mockResolvedValue({
        status: 'skipped',
        targets: [],
      }),
    };
    service = new ProjectsService(
      makeCatalogService(),
      githubService,
      makeProjectsRepository(),
      makeCiService(),
      projectDeploymentProvisioningService as never,
    );

    pushWorkflowFileSpy = jest
      .spyOn(
        service as unknown as {
          pushWorkflowFile: (
            accessToken: string,
            owner: string,
            repo: string,
            filePath: string,
            content: string,
          ) => Promise<{ commitSha: string; commitUrl: string | null }>;
        },
        'pushWorkflowFile',
      )
      .mockResolvedValue({
        commitSha: 'commit-sha',
        commitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('prefers the OAuth token over a linked GitHub App installation token for project provisioning', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
      servicePath: '.',
      nodeVersion: '24',
      coverageThreshold: 80,
    });

    expect(
      githubServiceMock.getInstallationAccessTokenForUser,
    ).not.toHaveBeenCalled();
    expect(githubServiceMock.createRepo).toHaveBeenCalledWith(
      'oauth-token',
      expect.objectContaining({ repoName: 'orders-api' }),
      undefined,
    );
  });

  it('uses OAuth to create an organization repository and the installation token to configure it', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
      ownerType: 'organization',
      installationId: 12345,
    });

    expect(
      githubServiceMock.getOrganizationProvisioningContext,
    ).toHaveBeenCalledWith('user-1', 12345);
    expect(githubServiceMock.createRepo).toHaveBeenCalledWith(
      'oauth-token',
      expect.objectContaining({ repoName: 'orders-api' }),
      'tone',
    );
    expect(githubServiceMock.setActionsSecretStrict).toHaveBeenCalledWith(
      'installation-token',
      'tone',
      'orders-api',
      'ALPHACI_TOKEN',
      'flowci-token',
    );
  });

  it('rejects organization repository creation without a user OAuth token', async () => {
    await expect(
      service.createProject('user-1', 'tone', null, {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
        ownerType: 'organization',
        installationId: 12345,
      }),
    ).rejects.toThrow(
      'A GitHub OAuth token with the repo scope is required to create a repository in an organization.',
    );
    expect(
      githubServiceMock.getOrganizationProvisioningContext,
    ).not.toHaveBeenCalled();
    expect(githubServiceMock.createRepo).not.toHaveBeenCalled();
  });

  it('forces every repository into the enforced org regardless of ownerType', async () => {
    githubServiceMock.getEnforcedOrg.mockReturnValue('Alpha-Explora');

    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
      // Even a "personal" request must land in the enforced org.
      ownerType: 'personal',
    });

    expect(
      githubServiceMock.getOrganizationProvisioningContextByLogin,
    ).toHaveBeenCalledWith('Alpha-Explora');
    expect(
      githubServiceMock.getOrganizationProvisioningContext,
    ).not.toHaveBeenCalled();
    expect(githubServiceMock.createRepo).toHaveBeenCalledWith(
      'oauth-token',
      expect.objectContaining({ repoName: 'orders-api' }),
      'Alpha-Explora',
    );
  });

  it('rejects enforced-org creation when the session has no OAuth token', async () => {
    githubServiceMock.getEnforcedOrg.mockReturnValue('Alpha-Explora');

    await expect(
      service.createProject('user-1', 'tone', null, {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
      }),
    ).rejects.toThrow(
      'required to create a repository in the Alpha-Explora organization',
    );
    expect(
      githubServiceMock.getOrganizationProvisioningContextByLogin,
    ).not.toHaveBeenCalled();
    expect(githubServiceMock.createRepo).not.toHaveBeenCalled();
  });

  it('records audit and notification events after project creation', async () => {
    const auditEventsService = {
      recordProjectEvent: jest.fn(),
    };
    const notificationEventsService = {
      record: jest.fn(),
    };
    const eventService = new ProjectsService(
      makeCatalogService(),
      githubService,
      makeProjectsRepository(),
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeProjectFeatureConfig(),
      undefined,
      undefined,
      undefined,
      auditEventsService as never,
      makeWorkspacesService(),
      notificationEventsService as never,
    );
    jest
      .spyOn(
        eventService as unknown as {
          pushWorkflowFile: (
            accessToken: string,
            owner: string,
            repo: string,
            filePath: string,
            content: string,
          ) => Promise<{ commitSha: string; commitUrl: string | null }>;
        },
        'pushWorkflowFile',
      )
      .mockResolvedValue({
        commitSha: 'commit-sha',
        commitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
      });

    await eventService.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
      servicePath: '.',
      nodeVersion: '24',
      coverageThreshold: 80,
    });

    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'project_created',
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'project-1',
        eventCode: 'project_created',
      }),
    );
  });

  it('records audit and notification events when project quota blocks creation', async () => {
    const usageQuotaService = {
      assertWithinLimit: jest.fn().mockRejectedValue(
        new BadRequestException({
          message: 'Usage quota exceeded',
          limitCode: 'projects',
        }),
      ),
    };
    const auditEventsService = {
      recordProjectEvent: jest.fn(),
    };
    const notificationEventsService = {
      record: jest.fn(),
    };
    const quotaService = new ProjectsService(
      makeCatalogService(),
      githubService,
      makeProjectsRepository(),
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeProjectFeatureConfig(),
      undefined,
      undefined,
      usageQuotaService as never,
      auditEventsService as never,
      makeWorkspacesService(),
      notificationEventsService as never,
    );

    await expect(
      quotaService.createProject('user-1', 'tone', 'oauth-token', {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
        servicePath: '.',
        nodeVersion: '24',
        coverageThreshold: 80,
      }),
    ).rejects.toThrow('Usage quota exceeded');

    expect(githubServiceMock.createRepo).not.toHaveBeenCalled();
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: null,
        eventCode: 'quota_blocked',
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: null,
        eventCode: 'quota_blocked',
      }),
    );
  });

  it('attaches created projects to the default workspace when available', async () => {
    const projectsRepository =
      makeProjectsRepository() as jest.Mocked<ProjectsRepository>;
    const workspacesService =
      makeWorkspacesService() as jest.Mocked<WorkspacesService>;
    const workspaceService = new ProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workspacesService,
    );

    jest
      .spyOn(
        workspaceService as unknown as {
          pushWorkflowFile: (
            accessToken: string,
            owner: string,
            repo: string,
            filePath: string,
            content: string,
          ) => Promise<{ commitSha: string; commitUrl: string | null }>;
        },
        'pushWorkflowFile',
      )
      .mockResolvedValue({
        commitSha: 'commit-sha',
        commitUrl: 'https://github.com/tone/orders-api/commit/commit-sha',
      });

    await workspaceService.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
    });

    expect(workspacesService.getMyWorkspaces).toHaveBeenCalledWith('user-1');
    expect(projectsRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'workspace-1' }),
    );
  });

  it('falls back to the OAuth token when no installation token is available', async () => {
    githubServiceMock.getInstallationAccessTokenForUser.mockResolvedValueOnce(
      null,
    );

    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
    });

    expect(githubServiceMock.createRepo).toHaveBeenCalledWith(
      'oauth-token',
      expect.any(Object),
      undefined,
    );
  });

  it('throws an actionable error when no GitHub token source is available', async () => {
    githubServiceMock.getInstallationAccessTokenForUser.mockResolvedValueOnce(
      null,
    );

    await expect(
      service.createProject('user-1', 'tone', null, {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('passes selected workspace id into project listing', async () => {
    const projectsRepository =
      makeProjectsRepository() as jest.Mocked<ProjectsRepository>;
    const listService = new ProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService as never,
    );

    await listService.listProjects('user-1', 25, 'workspace-1');

    expect(projectsRepository.listByUser).toHaveBeenCalledWith(
      'user-1',
      25,
      'workspace-1',
    );
  });

  it('maps is_owner to a viewer-relative isOwner so admin/manager-visible projects are distinguishable from owned ones', async () => {
    const projectsRepository = {
      listByUser: jest.fn().mockResolvedValue([
        {
          id: 'project-own',
          user_id: 'user-1',
          repo_full_name: 'tone/orders-api',
          template_id: 'be-nestjs',
          service_name: 'orders-api',
          workflow_path: '.github/workflows/ci.yml',
          status: 'provisioned',
          github_commit_sha: null,
          github_commit_url: null,
          failure_reason: null,
          repo_url: null,
          visibility: 'private',
          repo_shape: 'single-app',
          project_type_id: 'nestjs-api',
          workflow_recipe_id: 'backend-api-ci',
          project_options: {},
          workspace_id: null,
          is_owner: true,
          created_at: '2026-06-05T00:00:00.000Z',
          updated_at: '2026-06-05T00:00:00.000Z',
        },
        {
          id: 'project-other',
          user_id: 'user-2',
          repo_full_name: 'antoneeeeems/iuyyxfgfuy',
          template_id: 'be-nestjs',
          service_name: 'iuyyxfgfuy',
          workflow_path: '.github/workflows/ci.yml',
          status: 'provisioned',
          github_commit_sha: null,
          github_commit_url: null,
          failure_reason: null,
          repo_url: null,
          visibility: 'private',
          repo_shape: 'single-app',
          project_type_id: 'nestjs-api',
          workflow_recipe_id: 'backend-api-ci',
          project_options: {},
          workspace_id: null,
          is_owner: false,
          created_at: '2026-06-05T00:00:00.000Z',
          updated_at: '2026-06-05T00:00:00.000Z',
        },
      ]),
    } as unknown as jest.Mocked<ProjectsRepository>;
    const listService = new ProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService as never,
    );

    const result = await listService.listProjects('admin-1', 25);

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'project-own', isOwner: true }),
      expect.objectContaining({ id: 'project-other', isOwner: false }),
    ]);
  });

  it('omits Vercel deploy jobs for frontend single-repo creation', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-ui',
      visibility: 'private',
      projectTypeId: 'react-app',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-ui',
      servicePath: 'apps/web',
      deploymentProvisioning: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'byo',
            projectName: 'orders-ui-test',
            rootDirectory: 'apps/web',
            providerConnectionId: 'connection-1',
            env: [],
          },
        ],
      },
    });

    const packageWorkflow = (
      (
        service as unknown as {
          pushWorkflowFile: jest.Mock;
        }
      ).pushWorkflowFile.mock.calls as Array<
        [string, string, string, string, string]
      >
    ).find(([, , , path]) => path.endsWith('20-alphaci-package.yml'));

    expect(packageWorkflow?.[4]).not.toContain('deploy-vercel-frontend-test');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-uat');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-main');
    expect(packageWorkflow?.[4]).toContain('vercel-deploy.yml');
    expect(packageWorkflow?.[4]).toContain('VERCEL_FRONTEND_TOKEN');
  });

  it('emits managed Vercel deploy jobs for frontend single-repo creation', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-ui',
      visibility: 'private',
      projectTypeId: 'react-app',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-ui',
      servicePath: 'apps/web',
      deploymentProvisioning: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-ui-test',
            rootDirectory: 'apps/web',
            env: [],
          },
        ],
      },
    });

    const packageWorkflow = (
      (
        service as unknown as {
          pushWorkflowFile: jest.Mock;
        }
      ).pushWorkflowFile.mock.calls as Array<
        [string, string, string, string, string]
      >
    ).find(([, , , path]) => path.endsWith('20-alphaci-package.yml'));

    expect(packageWorkflow?.[4]).not.toContain('deploy-vercel-frontend-test');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-uat');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-main');
    expect(packageWorkflow?.[4]).toContain('vercel-deploy.yml');
    expect(packageWorkflow?.[4]).toContain('VERCEL_FRONTEND_TOKEN');
  });

  it('emits Vercel deploy jobs for frontend single-repo setup', async () => {
    await service.setupProject('user-1', 'oauth-token', {
      repoFullName: 'tone/orders-ui',
      templateId: 'be-nestjs',
      serviceName: 'orders-ui',
      servicePath: 'apps/web',
      nodeVersion: '24',
      coverageThreshold: 80,
      deploymentProvisioning: {
        enabled: true,
        targets: [
          {
            slot: 'frontend',
            provider: 'vercel',
            ownershipMode: 'byo',
            projectName: 'orders-ui-test',
            rootDirectory: 'apps/web',
            providerConnectionId: 'connection-1',
            env: [],
          },
        ],
      },
    });

    const packageWorkflow = (
      (
        service as unknown as {
          pushWorkflowFile: jest.Mock;
        }
      ).pushWorkflowFile.mock.calls as Array<
        [string, string, string, string, string]
      >
    ).find(([, , , path]) => path.endsWith('20-alphaci-package.yml'));

    expect(packageWorkflow?.[4]).not.toContain('deploy-vercel-frontend-test');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-uat');
    expect(packageWorkflow?.[4]).toContain('deploy-vercel-frontend-main');
    expect(packageWorkflow?.[4]).toContain('vercel-deploy.yml');
    expect(packageWorkflow?.[4]).toContain('VERCEL_FRONTEND_TOKEN');
  });


  /*
   * ONBOARDING AN EXISTING REPOSITORY (2026-08-18).
   *
   * Four defects this pins shut: the commit branch was hardcoded to 'main' so
   * any repo on `master` failed; a failed setup left ALPHACI_TOKEN behind in
   * somebody's repository; SonarCloud config was overwritten without asking;
   * and `uat` was never created, so the staging and promotion half of the
   * pipeline stayed dormant with no error anywhere.
   */
  describe('setupProject: existing repositories', () => {
    function pushedBranches(): string[] {
      const calls = (
        service as unknown as { pushWorkflowFile: jest.Mock }
      ).pushWorkflowFile.mock.calls as unknown[][];
      // (token, owner, repo, path, content, message, branch)
      return calls.map((call) => call[6] as string);
    }

    it('commits to the repository OWN default branch, not a hardcoded main', async () => {
      githubServiceMock.getRepo = jest
        .fn()
        .mockResolvedValue({ defaultBranch: 'master' });

      await service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      const branches = pushedBranches();
      expect(branches.length).toBeGreaterThan(0);
      expect(new Set(branches)).toEqual(new Set(['master']));
    });

    it('falls back to main when the default branch cannot be read', async () => {
      githubServiceMock.getRepo = jest
        .fn()
        .mockRejectedValue(new Error('403'));

      await service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      expect(new Set(pushedBranches())).toEqual(new Set(['main']));
    });

    it('creates uat from the default branch so the staging half can run', async () => {
      githubServiceMock.getRepo = jest
        .fn()
        .mockResolvedValue({ defaultBranch: 'master' });

      await service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      expect(githubServiceMock.createBranch).toHaveBeenCalledWith(
        expect.any(String),
        'tone',
        'orders-api',
        'uat',
        'master',
      );
    });

    it('leaves an existing uat branch alone', async () => {
      githubServiceMock.branchExists = jest.fn().mockResolvedValue(true);

      await service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      expect(githubServiceMock.createBranch).not.toHaveBeenCalled();
    });

    it('still completes when uat cannot be created — a main-only pipeline beats no pipeline', async () => {
      githubServiceMock.createBranch = jest
        .fn()
        .mockRejectedValue(new Error('protected'));

      await expect(
        service.setupProject('user-1', 'oauth-token', {
          repoFullName: 'tone/orders-api',
          templateId: 'be-nestjs',
          serviceName: 'orders-api',
        }),
      ).resolves.toBeDefined();
    });

    it('does not overwrite SonarCloud secrets the repository already has', async () => {
      githubServiceMock.listActionsSecretNames = jest
        .fn()
        .mockResolvedValue(new Set(['SONAR_TOKEN']));

      await service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'tone/orders-api',
        templateId: 'be-nestjs',
        serviceName: 'orders-api',
      });

      const written = (
        githubServiceMock.setActionsSecret as unknown as jest.Mock
      ).mock.calls.map((call) => call[3] as string);
      expect(written).not.toContain('SONAR_TOKEN');
      expect(written).not.toContain('SONAR_PROJECT_KEY');
    });

    it('removes the secrets it wrote when the push fails', async () => {
      (
        service as unknown as { pushWorkflowFile: jest.Mock }
      ).pushWorkflowFile = jest
        .fn()
        .mockRejectedValue(new Error('branch not found'));

      await expect(
        service.setupProject('user-1', 'oauth-token', {
          repoFullName: 'tone/orders-api',
          templateId: 'be-nestjs',
          serviceName: 'orders-api',
        }),
      ).rejects.toThrow();

      const removed = (
        githubServiceMock.deleteActionsSecret as unknown as jest.Mock
      ).mock.calls.map((call) => call[3] as string);
      expect(removed).toEqual(
        expect.arrayContaining(['ALPHACI_TOKEN', 'ALPHACI_REPORT_URL']),
      );
    });

    it('never deletes SONAR secrets on cleanup — it may not have written them', async () => {
      (
        service as unknown as { pushWorkflowFile: jest.Mock }
      ).pushWorkflowFile = jest.fn().mockRejectedValue(new Error('nope'));

      await expect(
        service.setupProject('user-1', 'oauth-token', {
          repoFullName: 'tone/orders-api',
          templateId: 'be-nestjs',
          serviceName: 'orders-api',
        }),
      ).rejects.toThrow();

      const removed = (
        githubServiceMock.deleteActionsSecret as unknown as jest.Mock
      ).mock.calls.map((call) => call[3] as string);
      expect(removed).not.toContain('SONAR_TOKEN');
    });

    it('reports the original failure, not a cleanup error', async () => {
      (
        service as unknown as { pushWorkflowFile: jest.Mock }
      ).pushWorkflowFile = jest
        .fn()
        .mockRejectedValue(new Error('branch not found'));
      githubServiceMock.deleteActionsSecret = jest
        .fn()
        .mockRejectedValue(new Error('no secrets:write'));

      await expect(
        service.setupProject('user-1', 'oauth-token', {
          repoFullName: 'tone/orders-api',
          templateId: 'be-nestjs',
          serviceName: 'orders-api',
        }),
      ).rejects.toThrow('branch not found');
    });
  });

  it('uses a linked GitHub App installation token for existing private repo setup without provider provisioning', async () => {
    const result = await service.setupProject('user-1', null, {
      repoFullName: 'tone/orders-api',
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    expect(
      githubServiceMock.getInstallationAccessTokenForUserRepo,
    ).toHaveBeenCalledWith('user-1', 'tone/orders-api');
    expect(githubServiceMock.setActionsSecretStrict).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'orders-api',
      'ALPHACI_TOKEN',
      'flowci-token',
    );
    expect(
      projectDeploymentProvisioningService.provisionForProject,
    ).not.toHaveBeenCalled();
    expect(result.deploymentProvisioning.status).toBe('skipped');
  });

  it('rejects Setup-flow attachment of a repo outside the enforced org', async () => {
    githubServiceMock.getEnforcedOrg.mockReturnValue('Alpha-Explora');

    await expect(
      service.setupProject('user-1', 'oauth-token', {
        repoFullName: 'some-other-org/external-repo',
        templateId: 'be-nestjs',
        serviceName: 'external-repo',
      }),
    ).rejects.toThrow(
      "repoFullName must belong to the Alpha-Explora organization. 'some-other-org' is not allowed for new Setup-flow attachments.",
    );
    expect(githubServiceMock.setActionsSecretStrict).not.toHaveBeenCalled();
  });

  it('allows Setup-flow attachment when the repo owner case-insensitively matches the enforced org', async () => {
    githubServiceMock.getEnforcedOrg.mockReturnValue('Alpha-Explora');

    const result = await service.setupProject('user-1', null, {
      repoFullName: 'alpha-explora/orders-api',
      templateId: 'be-nestjs',
      serviceName: 'orders-api',
    });

    expect(result.repoFullName).toBe('alpha-explora/orders-api');
  });

  it('provisions centralized deployment targets during GitHub project creation', async () => {
    projectDeploymentProvisioningService.provisionForProject.mockResolvedValueOnce(
      {
        status: 'completed',
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            deploymentStrategy: 'render_image_pushed',
            status: 'created',
            deploymentTargetId: 'target-1',
            providerProjectId: 'srv-1',
            providerProjectName: 'orders-api-test',
            providerMetadata: {},
            errorSummary: null,
            env: [],
          },
        ],
      },
    );

    const result = await service.createProject(
      'user-1',
      'tone',
      'oauth-token',
      {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
        deploymentProvisioning: {
          enabled: true,
          targets: [
            {
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              projectName: 'orders-api-uat',
            },
          ],
        },
      },
    );

    expect(
      projectDeploymentProvisioningService.provisionForProject,
    ).toHaveBeenCalledWith({
      projectId: 'project-1',
      userId: 'user-1',
      repoFullName: 'tone/orders-api',
      githubAccessToken: 'oauth-token',
      request: {
        enabled: true,
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'flowci_managed',
            projectName: 'orders-api-uat',
          },
        ],
      },
    });
    expect(result.deploymentProvisioning.status).toBe('completed');
  });

  it('defaults backend repo creation to managed Render provisioning when the UI sends no deployment request', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
    });

    expect(
      projectDeploymentProvisioningService.provisionForProject,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        userId: 'user-1',
        repoFullName: 'tone/orders-api',
        githubAccessToken: 'oauth-token',
        request: {
          enabled: true,
          targets: [
            expect.objectContaining({
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              projectName: 'orders-api-uat',
              branchName: 'uat',
              rootDirectory: '.',
              renderDeployMethod: 'managed_image',
              renderRuntime: 'docker',
              renderInstanceType: 'free',
            }),
          ],
        },
      }),
    );

    const packageWorkflow = (
      (
        service as unknown as {
          pushWorkflowFile: jest.Mock;
        }
      ).pushWorkflowFile.mock.calls as Array<
        [string, string, string, string, string]
      >
    ).find(([, , , path]) => path.endsWith('20-alphaci-package.yml'));

    expect(packageWorkflow?.[4]).not.toContain('deploy-render-backend-test');
    expect(packageWorkflow?.[4]).toContain('deploy-render-backend-uat');
    expect(packageWorkflow?.[4]).toContain('deploy-render-backend-main');
    expect(packageWorkflow?.[4]).toContain('RENDER_DEPLOY_HOOK_URL_UAT');
    expect(githubServiceMock.createBranch).toHaveBeenCalledWith(
      'oauth-token',
      'tone',
      'orders-api',
      'develop',
      'main',
    );
    expect(githubServiceMock.createBranch).toHaveBeenCalledWith(
      'oauth-token',
      'tone',
      'orders-api',
      'uat',
      'main',
    );
    expect(githubServiceMock.createBranch).not.toHaveBeenCalledWith(
      'oauth-token',
      'tone',
      'orders-api',
      'test',
      'main',
    );
    expect(githubServiceMock.applyBranchProtection.mock.calls).toEqual(
      expect.arrayContaining([
        ['oauth-token', 'tone', 'orders-api', 'uat'],
        ['oauth-token', 'tone', 'orders-api', 'main'],
      ]),
    );
    expect(
      githubServiceMock.applyBranchProtection.mock.calls.some(
        (call) => call[3] === 'develop' || call[3] === 'test',
      ),
    ).toBe(false);
  });

  it('forces BYO provisioning requests onto centralized hosting and drops connection ids', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders-api',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
      deploymentProvisioning: {
        enabled: true,
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            ownershipMode: 'byo',
            providerConnectionId: 'connection-1',
            projectName: 'orders-api-test',
          },
        ],
      },
    });

    const request = (
      projectDeploymentProvisioningService.provisionForProject.mock
        .calls[0] as [{ request: { targets: Array<Record<string, unknown>> } }]
    )[0].request;
    expect(request.targets[0]?.['ownershipMode']).toBe('flowci_managed');
    expect(request.targets[0]).not.toHaveProperty('providerConnectionId');
  });

  it('reports provisioning failures without failing project creation', async () => {
    projectDeploymentProvisioningService.provisionForProject.mockResolvedValueOnce(
      {
        status: 'failed',
        targets: [
          {
            slot: 'backend',
            provider: 'render',
            status: 'failed',
            deploymentTargetId: null,
            providerProjectId: null,
            providerProjectName: null,
            errorSummary: 'Render service could not be created: 401',
            env: [],
          },
        ],
      },
    );

    const result = await service.createProject(
      'user-1',
      'tone',
      'oauth-token',
      {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
        deploymentProvisioning: {
          enabled: true,
          targets: [
            {
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              projectName: 'orders-api-test',
            },
          ],
        },
      },
    );

    expect(result.repoFullName).toBe('tone/orders-api');
    expect(result.status).toBe('provisioned');
    expect(result.deploymentProvisioning.status).toBe('failed');
  });

  it('records the actual staged workflow path even when a custom outputFileName is supplied', async () => {
    const result = await service.createProject(
      'user-1',
      'tone',
      'oauth-token',
      {
        repoName: 'orders-api',
        visibility: 'private',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-api',
        outputFileName: 'ci.yml',
      },
    );

    expect(result.workflowPath).toBe('.github/workflows/00-alphaci-access.yml');
  });

  it("dispatches the catalog shape ID 'multi' to the multi-repo flow (two repos)", async () => {
    const result = await service.createProject(
      'user-1',
      'tone',
      'oauth-token',
      {
        repoName: 'orders',
        visibility: 'private',
        repoShape: 'multi',
        projectTypeId: 'nestjs-api',
        workflowRecipeId: 'backend-api-ci',
        serviceName: 'orders-backend',
        multiRepoConfig: {
          backend: {
            projectTypeId: 'nestjs-api',
            workflowRecipeId: 'backend-api-ci',
            serviceName: 'orders-backend',
            servicePath: 'backend/',
          },
          frontend: {
            projectTypeId: 'nestjs-api',
            workflowRecipeId: 'backend-api-ci',
            serviceName: 'orders-frontend',
            servicePath: 'frontend/',
          },
        },
      },
    );

    expect(githubServiceMock.createRepo).toHaveBeenCalledTimes(2);
    expect(githubServiceMock.createRepo).toHaveBeenNthCalledWith(
      1,
      'oauth-token',
      expect.objectContaining({ repoName: 'orders-be' }),
      undefined,
    );
    expect(githubServiceMock.createRepo).toHaveBeenNthCalledWith(
      2,
      'oauth-token',
      expect.objectContaining({ repoName: 'orders-fe' }),
      undefined,
    );
    expect(result.secondaryRepoFullName).toBeDefined();
    expect(
      projectDeploymentProvisioningService.provisionForProject,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          enabled: true,
          targets: [
            expect.objectContaining({
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              renderDeployMethod: 'managed_image',
            }),
          ],
        }),
      }),
    );
  });

  it("renders the monorepo scaffold for the catalog shape ID 'mono'", async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders',
      visibility: 'private',
      repoShape: 'mono',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-platform',
    });

    const pushedPaths = (
      pushWorkflowFileSpy.mock.calls as unknown as Array<
        [string, string, string, string, string]
      >
    ).map((call) => call[3]);
    expect(pushedPaths).toContain('packages/core/package.json');

    const readmeContent = (
      pushWorkflowFileSpy.mock.calls as unknown as Array<
        [string, string, string, string, string]
      >
    ).find((call) => call[3] === 'README.md')?.[4];
    expect(readmeContent).toContain(
      'Created by ALPHACI as a NestJS API monorepo workspace.',
    );
    expect(readmeContent).toContain('`packages/core/` contains');
  });

  it('normalizes legacy project type IDs when creating starter files', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders',
      visibility: 'private',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-api',
    });

    const pushedPaths = (
      pushWorkflowFileSpy.mock.calls as unknown as Array<
        [string, string, string, string, string]
      >
    ).map((call) => call[3]);
    expect(pushedPaths).toContain('src/main.ts');
    expect(pushedPaths).toContain('src/app.module.ts');

    const readmeContent = (
      pushWorkflowFileSpy.mock.calls as unknown as Array<
        [string, string, string, string, string]
      >
    ).find((call) => call[3] === 'README.md')?.[4];
    expect(readmeContent).toContain(
      'Created by ALPHACI as a NestJS API standalone repository.',
    );
    expect(readmeContent).toContain('`src/main.ts` boots the NestJS app.');
  });

  it('pushes variant-suffixed workflow files for the microservices shape so the slots do not collide', async () => {
    await service.createProject('user-1', 'tone', 'oauth-token', {
      repoName: 'orders',
      visibility: 'private',
      repoShape: 'microservices',
      projectTypeId: 'nestjs-api',
      workflowRecipeId: 'backend-api-ci',
      serviceName: 'orders-backend',
      microservicesConfig: {
        backend: {
          projectTypeId: 'nestjs-api',
          workflowRecipeId: 'backend-api-ci',
          serviceName: 'orders-backend',
          servicePath: 'backend/',
        },
        frontend: {
          projectTypeId: 'nestjs-api',
          workflowRecipeId: 'backend-api-ci',
          serviceName: 'orders-frontend',
          servicePath: 'frontend/',
        },
      },
    });

    const pushedPaths = (
      pushWorkflowFileSpy.mock.calls as unknown as Array<
        [string, string, string, string, string]
      >
    ).map((call) => call[3]);

    expect(pushedPaths).toEqual(
      expect.arrayContaining([
        '.github/workflows/00-alphaci-access-backend.yml',
        '.github/workflows/10-alphaci-quality-backend.yml',
        '.github/workflows/20-alphaci-package-backend.yml',
        '.github/workflows/00-alphaci-access-frontend.yml',
        '.github/workflows/10-alphaci-quality-frontend.yml',
        '.github/workflows/20-alphaci-package-frontend.yml',
      ]),
    );
    // The unsuffixed paths would mean one slot overwrote the other.
    expect(pushedPaths).not.toContain(
      '.github/workflows/00-alphaci-access.yml',
    );
    expect(pushedPaths).not.toContain(
      '.github/workflows/10-alphaci-quality.yml',
    );
    expect(pushedPaths).not.toContain(
      '.github/workflows/20-alphaci-package.yml',
    );
    expect(
      projectDeploymentProvisioningService.provisionForProject,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          enabled: true,
          targets: [
            expect.objectContaining({
              slot: 'backend',
              provider: 'render',
              ownershipMode: 'flowci_managed',
              renderDeployMethod: 'managed_image',
            }),
          ],
        }),
      }),
    );
  });

  it('aggregates a project overview from stored project, workflow, target, env, CI token, and history data', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url:
          'https://github.com/tone/orders-api/commit/abc123456789',
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {
          workflowFiles: [
            {
              stage: 'access',
              name: 'ALPHACI Access Gate',
              path: '.github/workflows/00-alphaci-access.yml',
              gated: true,
            },
            {
              stage: 'quality',
              name: 'ALPHACI Quality',
              path: '.github/workflows/10-alphaci-quality.yml',
              gated: true,
            },
          ],
          lint: true,
        },
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const OverviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const overviewService = new OverviewProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ syncSnapshots: true }),
    ) as ProjectsService & {
      getProjectOverview: (
        projectId: string,
        userId: string,
      ) => Promise<{
        project: { id: string; repoFullName: string };
        workflow: { files: Array<{ path: string }>; stageCount: number };
        deploymentTargets: { items: unknown[]; count: number };
        environment: { items: Array<{ key: string }>; count: number };
        ciAuth: { status: string; tokenPresent: boolean };
        health: {
          checks: Array<{ key: string; status: string }>;
          summary: string;
        };
        capabilities: { envProvisioning: boolean; syncSnapshots: boolean };
        syncSnapshot: {
          enabled: boolean;
          mode: string;
          latest: unknown;
        };
      }>;
    };

    const overview = await overviewService.getProjectOverview(
      'project-1',
      'user-1',
    );

    expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(overview.project).toMatchObject({
      id: 'project-1',
      repoFullName: 'tone/orders-api',
    });
    expect(overview.workflow.stageCount).toBe(2);
    expect(overview.workflow.files.map((file) => file.path)).toEqual([
      '.github/workflows/00-alphaci-access.yml',
      '.github/workflows/10-alphaci-quality.yml',
    ]);
    expect(overview.deploymentTargets.count).toBe(1);
    expect(overview.environment.items).toEqual([
      expect.objectContaining({ key: 'DATABASE_URL' }),
    ]);
    expect(overview.ciAuth).toMatchObject({
      status: 'active',
      tokenPresent: true,
    });
    expect(overview.health.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'workflow_bundle', status: 'ok' }),
        expect.objectContaining({ key: 'ci_token', status: 'ok' }),
        expect.objectContaining({ key: 'deployment_targets', status: 'ok' }),
      ]),
    );
    expect(overview.health.summary).toBe('ok');
    expect(overview.capabilities.envProvisioning).toBe(true);
    expect(overview.capabilities.syncSnapshots).toBe(true);
    expect(overview.syncSnapshot).toEqual({
      enabled: true,
      mode: 'local_snapshot',
      latest: null,
    });
    expect(
      overviewRepos.dashboardSnapshotsRepository.findLatestByProject,
    ).toHaveBeenCalledWith('project-1');
    expect(
      overviewRepos.workflowHistoryRepository.listByUser,
    ).not.toHaveBeenCalled();
    expect(
      overviewRepos.workflowHistoryRepository.listForProjectIdentity,
    ).toHaveBeenCalledWith({
      userId: 'user-1',
      serviceName: 'orders-api',
      templateId: 'be-nestjs',
      limit: 5,
    });
  });

  it('lists project audit events from the audit service after ownership is verified', async () => {
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
      }),
    } as unknown as ProjectsRepository;
    const auditEventsService = {
      listProjectEvents: jest.fn().mockResolvedValue({
        enabled: true,
        items: [
          {
            id: 'audit-1',
            eventCode: 'workflow_pr_created',
            message: 'Workflow update PR created',
            actorUserId: 'user-1',
            createdAt: '2026-06-14T00:00:00.000Z',
          },
        ],
      }),
    };
    const auditService = new ProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      makeProjectFeatureConfig({}),
      undefined,
      undefined,
      undefined,
      auditEventsService as never,
    );

    await expect(
      auditService.listProjectAuditEvents('project-1', 'user-1'),
    ).resolves.toEqual({
      enabled: true,
      items: [
        {
          id: 'audit-1',
          eventCode: 'workflow_pr_created',
          message: 'Workflow update PR created',
          actorUserId: 'user-1',
          createdAt: '2026-06-14T00:00:00.000Z',
        },
      ],
    });
    expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
    expect(auditEventsService.listProjectEvents).toHaveBeenCalledWith(
      'project-1',
      'user-1',
    );
  });

  it('creates a local dashboard snapshot without calling live provider APIs', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    overviewRepos.ciTokensRepository.findProjectTokenStatus.mockResolvedValue(
      null,
    );
    overviewRepos.envVarsRepository.listEnvMetadata.mockResolvedValue([]);
    overviewRepos.dashboardSnapshotsRepository.createSnapshot.mockResolvedValue(
      {
        id: 'snapshot-warning',
        projectId: 'project-1',
        status: 'warning',
        summary: {
          mode: 'local_snapshot',
          projectId: 'project-1',
        },
        findings: [
          {
            code: 'ci_token_missing',
            severity: 'warning',
            message: 'No project CI token is tracked.',
            source: 'local_snapshot',
          },
        ],
        startedAt: '2026-06-12T00:00:00.000Z',
        completedAt: '2026-06-12T00:00:01.000Z',
        createdBy: 'user-1',
        createdAt: '2026-06-12T00:00:01.000Z',
      },
    );
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url:
          'https://github.com/tone/orders-api/commit/abc123456789',
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {
          workflowFiles: [
            {
              stage: 'access',
              name: 'ALPHACI Access Gate',
              path: '.github/workflows/00-alphaci-access.yml',
              gated: true,
            },
          ],
        },
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const githubWithLiveChecks = {
      ...makeGithubService(),
      repoExists: jest.fn(),
    };
    const auditEventsService = {
      recordProjectEvent: jest.fn(),
    };
    const notificationEventsService = {
      record: jest.fn(),
    };
    const OverviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const overviewService = new OverviewProjectsService(
      makeCatalogService(),
      githubWithLiveChecks,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ syncSnapshots: true }),
      undefined,
      undefined,
      undefined,
      auditEventsService,
      makeWorkspacesService(),
      notificationEventsService,
    ) as ProjectsService & {
      syncProjectSnapshot: (
        projectId: string,
        userId: string,
      ) => Promise<{
        snapshot: { status: string; findings: Array<{ code: string }> };
        overview: { syncSnapshot: { latest: unknown } };
      }>;
    };

    const result = await overviewService.syncProjectSnapshot(
      'project-1',
      'user-1',
    );

    expect(githubWithLiveChecks.repoExists).not.toHaveBeenCalled();
    expect(
      overviewRepos.dashboardSnapshotsRepository.createSnapshot,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        status: 'warning',
        createdBy: 'user-1',
        summary: expect.objectContaining({
          mode: 'local_snapshot',
          projectId: 'project-1',
          ciTokenStatus: 'missing',
          envVarCount: 0,
        }),
        findings: expect.arrayContaining([
          expect.objectContaining({ code: 'ci_token_missing' }),
          expect.objectContaining({ code: 'env_metadata_empty' }),
        ]),
      }),
    );
    expect(result.snapshot.status).toBe('warning');
    expect(result.overview.syncSnapshot.latest).toMatchObject({
      id: 'snapshot-warning',
    });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: 'project-1',
        eventCode: 'project_snapshot_synced',
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: 'project-1',
        eventCode: 'project_snapshot_synced',
      }),
    );
  });

  it('maps existing project options into workflow settings when no settings row exists', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url:
          'https://github.com/tone/orders-api/commit/abc123456789',
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {
          servicePath: 'apps/api',
          nodeVersion: '22',
          coverageThreshold: 90,
          tests: { lint: true, security: true },
        },
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const PreviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const previewService = new PreviewProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ workflowSettingsPreview: true }),
      overviewRepos.workflowSettingsRepository,
    ) as ProjectsService & {
      getWorkflowSettings: (
        projectId: string,
        userId: string,
      ) => Promise<{
        source: string;
        settings: {
          servicePath: string;
          nodeVersion: string;
          coverageThreshold: number;
          packageManager: string;
        };
      }>;
    };

    const result = await previewService.getWorkflowSettings(
      'project-1',
      'user-1',
    );

    expect(
      overviewRepos.workflowSettingsRepository.findByProject,
    ).toHaveBeenCalledWith('project-1');
    expect(result).toMatchObject({
      source: 'project_options',
      settings: {
        servicePath: 'apps/api',
        nodeVersion: '22',
        coverageThreshold: 90,
        packageManager: 'npm',
      },
    });
  });

  it('previews the three staged workflow files without writing to GitHub', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url:
          'https://github.com/tone/orders-api/commit/abc123456789',
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {
          workflowFiles: [
            {
              stage: 'access',
              name: 'ALPHACI Access Gate',
              path: '.github/workflows/00-alphaci-access.yml',
              gated: true,
            },
          ],
        },
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const githubWithWrites = {
      ...makeGithubService(),
      pushWorkflowFile: jest.fn(),
      createBranch: jest.fn(),
    };
    const PreviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const previewService = new PreviewProjectsService(
      makeCatalogService(),
      githubWithWrites,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ workflowSettingsPreview: true }),
      overviewRepos.workflowSettingsRepository,
    ) as ProjectsService & {
      previewWorkflowSettings: (
        projectId: string,
        userId: string,
        settings: Record<string, unknown>,
      ) => Promise<{
        workflowFiles: Array<{ path: string; yaml: string }>;
        diffSummary: Array<{ path: string; status: string }>;
        validationWarnings: unknown[];
      }>;
    };

    const result = await previewService.previewWorkflowSettings(
      'project-1',
      'user-1',
      { nodeVersion: '24', coverageThreshold: 85 },
    );

    expect(githubWithWrites.createBranch).not.toHaveBeenCalled();
    expect(githubWithWrites.pushWorkflowFile).not.toHaveBeenCalled();
    expect(result.workflowFiles.map((file) => file.path)).toEqual([
      '.github/workflows/00-alphaci-access.yml',
      '.github/workflows/10-alphaci-quality.yml',
      '.github/workflows/20-alphaci-package.yml',
      '.github/workflows/05-alphaci-env-guard.yml',
    ]);
    expect(result.workflowFiles[0]?.yaml).toContain('ALPHACI Access Gate');
    expect(result.diffSummary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.github/workflows/00-alphaci-access.yml',
          status: 'changed',
        }),
        expect.objectContaining({
          path: '.github/workflows/10-alphaci-quality.yml',
          status: 'new',
        }),
      ]),
    );
    expect(result.validationWarnings).toEqual([]);
  });

  it('returns a validation warning for an invalid coverage threshold preview', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url: null,
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {},
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const PreviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const previewService = new PreviewProjectsService(
      makeCatalogService(),
      githubService,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ workflowSettingsPreview: true }),
      overviewRepos.workflowSettingsRepository,
    ) as ProjectsService & {
      previewWorkflowSettings: (
        projectId: string,
        userId: string,
        settings: Record<string, unknown>,
      ) => Promise<{ workflowFiles: unknown[]; validationWarnings: unknown[] }>;
    };

    const result = await previewService.previewWorkflowSettings(
      'project-1',
      'user-1',
      { coverageThreshold: 150 },
    );

    expect(result.workflowFiles).toEqual([]);
    expect(result.validationWarnings).toEqual([
      expect.objectContaining({
        field: 'coverageThreshold',
        message: 'Coverage threshold must be between 0 and 100.',
      }),
    ]);
  });

  it('creates a workflow update branch, writes all staged files, creates a PR, and stores request metadata', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url: null,
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {
          workflowFiles: [
            {
              stage: 'access',
              name: 'ALPHACI Access Gate',
              path: '.github/workflows/00-alphaci-access.yml',
              gated: true,
            },
          ],
        },
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    } as unknown as ProjectsRepository;
    const githubWrites = makeGithubService() as unknown as GithubService & {
      createBranch: jest.Mock;
      putFileContent: jest.Mock;
      createPullRequest: jest.Mock;
    };
    const auditEventsService = {
      recordProjectEvent: jest.fn().mockResolvedValue(undefined),
    };
    const notificationEventsService = {
      record: jest.fn().mockResolvedValue(undefined),
    };
    const prService = new ProjectsService(
      makeCatalogService(),
      githubWrites,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService as never,
      overviewRepos.ciTokensRepository as never,
      overviewRepos.deploymentTargetsRepository as never,
      overviewRepos.envVarsRepository as never,
      overviewRepos.workflowHistoryRepository as never,
      overviewRepos.dashboardSnapshotsRepository as never,
      makeProjectFeatureConfig({
        workflowSettingsPreview: true,
        workflowUpdatePr: true,
      }),
      overviewRepos.workflowSettingsRepository as never,
      overviewRepos.workflowUpdateRequestsRepository as never,
      undefined,
      auditEventsService as never,
      undefined,
      notificationEventsService as never,
    ) as ProjectsService & {
      createWorkflowUpdatePullRequest: (
        projectId: string,
        userId: string,
        oauthAccessToken: string | null,
        settings: Record<string, unknown>,
      ) => Promise<{
        branchName: string;
        pullRequestNumber: number;
        pullRequestUrl: string;
        workflowPath: string;
      }>;
    };

    const result = await prService.createWorkflowUpdatePullRequest(
      'project-1',
      'user-1',
      null,
      { nodeVersion: '24', coverageThreshold: 85 },
    );

    expect(githubWrites.createBranch).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'orders-api',
      expect.stringMatching(/^alphaci\/workflow-update-\d{14}$/),
      'main',
    );
    expect(githubWrites.putFileContent).toHaveBeenCalledTimes(4);
    const putFileContentCalls = githubWrites.putFileContent.mock.calls as Array<
      [string, string, string, string, string, string, string]
    >;
    expect(putFileContentCalls.map((call) => call[3])).toEqual([
      '.github/workflows/00-alphaci-access.yml',
      '.github/workflows/10-alphaci-quality.yml',
      '.github/workflows/20-alphaci-package.yml',
      '.github/workflows/05-alphaci-env-guard.yml',
    ]);
    expect(githubWrites.createPullRequest).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'orders-api',
      expect.objectContaining({
        title: 'Update ALPHACI workflow configuration',
        head: expect.stringMatching(/^alphaci\/workflow-update-\d{14}$/),
        base: 'main',
        body: expect.stringContaining(
          'Runtime environment values are not included.',
        ),
      }),
    );
    expect(
      overviewRepos.workflowUpdateRequestsRepository.createRequest,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        requestedBy: 'user-1',
        status: 'created',
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
      }),
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: expect.objectContaining({
        pullRequestNumber: 42,
        pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
        branchName: result.branchName,
        baseBranch: 'main',
      }),
    });
    expect(notificationEventsService.record).toHaveBeenCalledWith({
      userId: 'user-1',
      projectId: 'project-1',
      eventCode: 'workflow_pr_created',
      title: 'Workflow update PR created',
      body: expect.stringContaining('Workflow update PR #42'),
    });
    expect(result).toMatchObject({
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/orders-api/pull/42',
      workflowPath: '.github/workflows/00-alphaci-access.yml',
    });
  });

  it('creates workflow update PRs against the repository default branch', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url: null,
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {},
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const githubWrites = makeGithubService() as unknown as GithubService & {
      createBranch: jest.Mock;
      createPullRequest: jest.Mock;
      getRepo: jest.Mock;
    };
    githubWrites.getRepo.mockResolvedValueOnce({
      fullName: 'tone/orders-api',
      htmlUrl: 'https://github.com/tone/orders-api',
      defaultBranch: 'master',
      private: false,
    });
    const PrProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const prService = new PrProjectsService(
      makeCatalogService(),
      githubWrites,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({
        workflowSettingsPreview: true,
        workflowUpdatePr: true,
      }),
      overviewRepos.workflowSettingsRepository,
      overviewRepos.workflowUpdateRequestsRepository,
    );

    const result = await prService.createWorkflowUpdatePullRequest(
      'project-1',
      'user-1',
      null,
      {},
    );

    expect(githubWrites.createBranch).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'orders-api',
      result.branchName,
      'master',
    );
    expect(githubWrites.createPullRequest).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'orders-api',
      expect.objectContaining({ base: 'master' }),
    );
  });

  it('returns a clean error when GitHub rejects workflow update PR creation', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const projectsRepository = {
      create: jest.fn(),
      findByIdAndUser: jest.fn().mockResolvedValue({
        id: 'project-1',
        user_id: 'user-1',
        repo_full_name: 'tone/orders-api',
        template_id: 'be-nestjs',
        service_name: 'orders-api',
        workflow_path: '.github/workflows/00-alphaci-access.yml',
        status: 'provisioned',
        github_commit_sha: 'abc123456789',
        github_commit_url: null,
        failure_reason: null,
        repo_url: 'https://github.com/tone/orders-api',
        visibility: 'private',
        repo_shape: 'mono',
        project_type_id: 'nestjs-api',
        workflow_recipe_id: 'backend-api-ci',
        project_options: {},
        created_at: '2026-06-12T00:00:00.000Z',
        updated_at: '2026-06-12T00:00:00.000Z',
      }),
    };
    const githubWrites = makeGithubService() as unknown as GithubService & {
      createPullRequest: jest.Mock;
    };
    githubWrites.createPullRequest.mockRejectedValueOnce(
      new Error('GitHub pull request creation failed (422): Validation Failed'),
    );
    const PrProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const prService = new PrProjectsService(
      makeCatalogService(),
      githubWrites,
      projectsRepository,
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({
        workflowSettingsPreview: true,
        workflowUpdatePr: true,
      }),
      overviewRepos.workflowSettingsRepository,
      overviewRepos.workflowUpdateRequestsRepository,
    ) as ProjectsService & {
      createWorkflowUpdatePullRequest: (
        projectId: string,
        userId: string,
        oauthAccessToken: string | null,
        settings: Record<string, unknown>,
      ) => Promise<unknown>;
    };

    await expect(
      prService.createWorkflowUpdatePullRequest(
        'project-1',
        'user-1',
        null,
        {},
      ),
    ).rejects.toThrow(
      'GitHub could not create the workflow update pull request.',
    );
  });

  it('throws not found when overview is requested for a project outside the user scope', async () => {
    const overviewRepos = makeOverviewReadRepositories();
    const OverviewProjectsService = ProjectsService as unknown as new (
      ...args: unknown[]
    ) => ProjectsService;
    const overviewService = new OverviewProjectsService(
      makeCatalogService(),
      githubService,
      { create: jest.fn(), findByIdAndUser: jest.fn().mockResolvedValue(null) },
      makeCiService(),
      projectDeploymentProvisioningService,
      overviewRepos.ciTokensRepository,
      overviewRepos.deploymentTargetsRepository,
      overviewRepos.envVarsRepository,
      overviewRepos.workflowHistoryRepository,
      overviewRepos.dashboardSnapshotsRepository,
      makeProjectFeatureConfig({ syncSnapshots: true }),
    ) as ProjectsService & {
      getProjectOverview: (
        projectId: string,
        userId: string,
      ) => Promise<unknown>;
    };

    await expect(
      overviewService.getProjectOverview('project-1', 'user-2'),
    ).rejects.toThrow('Project not found');
  });

  it('disconnects an owned project through the repository (default, no GitHub call)', async () => {
    const projectsRepository = {
      deleteByIdAndUser: jest.fn().mockResolvedValue(true),
      findByIdAndUser: jest.fn(),
    };
    const githubServiceSpy = makeGithubService();
    const disconnectService = new ProjectsService(
      makeCatalogService(),
      githubServiceSpy,
      projectsRepository as never,
      makeCiService(),
      projectDeploymentProvisioningService as never,
    );

    await expect(
      disconnectService.disconnectProject('project-1', 'user-1'),
    ).resolves.toEqual({ ok: true, githubRepoDeleted: false });
    // Default path passes allowedRoles: undefined through, which falls back
    // to deleteByIdAndUser's own default (admin/delegated_lead/member) — the
    // plain-disconnect permissive role set stays unchanged.
    expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
      'project-1',
      'user-1',
      undefined,
    );
    // Default path must never touch GitHub or require a repo lookup.
    expect(projectsRepository.findByIdAndUser).not.toHaveBeenCalled();
    expect(githubServiceSpy.deleteRepoForUser).not.toHaveBeenCalled();
  });

  it('throws not found when disconnecting a project outside the user scope', async () => {
    const disconnectService = new ProjectsService(
      makeCatalogService(),
      githubService,
      { deleteByIdAndUser: jest.fn().mockResolvedValue(false) } as never,
      makeCiService(),
      projectDeploymentProvisioningService as never,
    );

    await expect(
      disconnectService.disconnectProject('project-1', 'user-2'),
    ).rejects.toThrow(NotFoundException);
  });

  describe('disconnectProject with deleteGithubRepo opt-in', () => {
    const buildService = (options: {
      githubServiceOverride?: Partial<{
        deleteRepoForUser: jest.Mock;
      }>;
      workspaceAccessService?: WorkspaceAccessService;
      projectsRepositoryOverride?: Partial<{
        findByIdAndUser: jest.Mock;
        deleteByIdAndUser: jest.Mock;
      }>;
      auditEventsService?: { recordProjectEvent: jest.Mock };
      notificationEventsService?: { record: jest.Mock };
    }) => {
      const githubServiceMock = {
        ...(makeGithubService() as unknown as Record<string, unknown>),
        ...options.githubServiceOverride,
      } as unknown as GithubService;
      const projectsRepository = {
        ...(makeProjectsRepository() as unknown as Record<string, unknown>),
        ...options.projectsRepositoryOverride,
      } as unknown as ProjectsRepository;

      const service = new ProjectsService(
        makeCatalogService(),
        githubServiceMock,
        projectsRepository,
        makeCiService(),
        projectDeploymentProvisioningService as never,
        undefined, // ciTokensRepository
        undefined, // deploymentTargetsRepository
        undefined, // envVarsRepository
        undefined, // workflowHistoryRepository
        undefined, // dashboardSnapshotsRepository
        undefined, // configService
        undefined, // workflowSettingsRepository
        undefined, // workflowUpdateRequestsRepository
        undefined, // usageQuotaService
        (options.auditEventsService as never) ?? undefined, // auditEventsService
        undefined, // workspacesService
        (options.notificationEventsService as never) ?? undefined, // notificationEventsService
        options.workspaceAccessService, // workspaceAccessService
      );

      return { service, githubServiceMock, projectsRepository };
    };

    it('succeeds and calls GithubService.deleteRepoForUser when confirmRepoName matches', async () => {
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const notificationEventsService = { record: jest.fn() };
      const { service, githubServiceMock, projectsRepository } = buildService({
        workspaceAccessService: makeWorkspaceAccessService(),
        auditEventsService,
        notificationEventsService,
      });

      const result = await service.disconnectProject(
        'project-1',
        'user-1',
        { deleteGithubRepo: true, confirmRepoName: 'tone/orders-api' },
        'gh-token',
      );

      expect(result).toEqual({ ok: true, githubRepoDeleted: true });
      expect(githubServiceMock.deleteRepoForUser).toHaveBeenCalledWith(
        'gh-token',
        'tone',
        'orders-api',
      );
      // Both the role-scoped lookup and the final delete must carry the
      // tightened role list — this is the SQL-level (fail-closed)
      // enforcement, independent of workspaceAccessService.
      expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventCode: 'project_github_repo_deleted' }),
      );
    });

    it('rejects a mismatched confirmRepoName without ever calling GitHub, and audits the rejection', async () => {
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const { service, githubServiceMock, projectsRepository } = buildService({
        workspaceAccessService: makeWorkspaceAccessService(),
        auditEventsService,
      });

      await expect(
        service.disconnectProject(
          'project-1',
          'user-1',
          { deleteGithubRepo: true, confirmRepoName: 'wrong/name' },
          'gh-token',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(githubServiceMock.deleteRepoForUser).not.toHaveBeenCalled();
      expect(projectsRepository.deleteByIdAndUser).not.toHaveBeenCalled();
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_github_repo_delete_rejected',
          metadata: expect.objectContaining({
            reason: 'confirmation_mismatch',
          }),
        }),
      );
    });

    it('rejects deleteGithubRepo=true for a developer-role user via the app-layer pre-check (owner/admin only), and audits it', async () => {
      const workspaceAccessService = makeWorkspaceAccessService({
        assertProjectRole: jest
          .fn()
          .mockRejectedValue(
            new ForbiddenException('Insufficient workspace role'),
          ),
      });
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const { service, githubServiceMock, projectsRepository } = buildService({
        workspaceAccessService,
        auditEventsService,
      });

      await expect(
        service.disconnectProject(
          'project-1',
          'user-1',
          { deleteGithubRepo: true, confirmRepoName: 'tone/orders-api' },
          'gh-token',
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(workspaceAccessService.assertProjectRole).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(githubServiceMock.deleteRepoForUser).not.toHaveBeenCalled();
      expect(projectsRepository.findByIdAndUser).not.toHaveBeenCalled();
      expect(projectsRepository.deleteByIdAndUser).not.toHaveBeenCalled();
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_github_repo_delete_rejected',
          metadata: expect.objectContaining({ reason: 'insufficient_role' }),
        }),
      );
    });

    it('fails closed at the SQL layer even when workspaceAccessService is entirely absent (H1 defense-in-depth)', async () => {
      // No workspaceAccessService passed at all — the app-layer pre-check
      // no-ops via `?.`. The role-scoped findByIdAndUser must still deny
      // access on its own: simulate the DB returning no row, as it would for
      // a caller whose workspace role isn't in the allowedRoles list.
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const { service, githubServiceMock, projectsRepository } = buildService({
        projectsRepositoryOverride: {
          findByIdAndUser: jest.fn().mockResolvedValue(null),
        },
        auditEventsService,
      });

      await expect(
        service.disconnectProject(
          'project-1',
          'user-1',
          { deleteGithubRepo: true, confirmRepoName: 'tone/orders-api' },
          'gh-token',
        ),
      ).rejects.toThrow(NotFoundException);

      expect(projectsRepository.findByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(githubServiceMock.deleteRepoForUser).not.toHaveBeenCalled();
      expect(projectsRepository.deleteByIdAndUser).not.toHaveBeenCalled();
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_github_repo_delete_rejected',
          metadata: expect.objectContaining({
            reason: 'not_found_or_insufficient_role',
          }),
        }),
      );
    });

    it('lets the local disconnect proceed and reports a missing-scope error when GitHub delete fails with 403', async () => {
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const { service, projectsRepository } = buildService({
        workspaceAccessService: makeWorkspaceAccessService(),
        githubServiceOverride: {
          deleteRepoForUser: jest
            .fn()
            .mockRejectedValue(
              new GithubRepoDeleteError(
                'missing_scope',
                'GitHub denied deleting tone/orders-api (403). Reconnect your GitHub account.',
              ),
            ),
        },
        auditEventsService,
      });

      const result = await service.disconnectProject(
        'project-1',
        'user-1',
        { deleteGithubRepo: true, confirmRepoName: 'tone/orders-api' },
        'gh-token',
      );

      expect(result).toEqual({
        ok: true,
        githubRepoDeleted: false,
        githubRepoDeleteError: {
          code: 'missing_scope',
          message:
            'GitHub denied deleting tone/orders-api (403). Reconnect your GitHub account.',
        },
      });
      // The local DB row must still be removed even though GitHub failed,
      // and still scoped to the tightened role list.
      expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_github_repo_delete_missing_scope',
        }),
      );
    });

    it('reports missing_scope without calling GitHub when the session has no access token', async () => {
      const { service, githubServiceMock, projectsRepository } = buildService({
        workspaceAccessService: makeWorkspaceAccessService(),
      });

      const result = await service.disconnectProject(
        'project-1',
        'user-1',
        { deleteGithubRepo: true, confirmRepoName: 'tone/orders-api' },
        null,
      );

      expect(result.githubRepoDeleted).toBe(false);
      expect(result.githubRepoDeleteError?.code).toBe('missing_scope');
      expect(githubServiceMock.deleteRepoForUser).not.toHaveBeenCalled();
      expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
    });

    it('reports an "other" error and audits it when repo_full_name has no owner/repo split', async () => {
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const { service, githubServiceMock, projectsRepository } = buildService({
        workspaceAccessService: makeWorkspaceAccessService(),
        projectsRepositoryOverride: {
          findByIdAndUser: jest
            .fn()
            .mockResolvedValue({ id: 'project-1', repo_full_name: 'no-slash' }),
        },
        auditEventsService,
      });

      const result = await service.disconnectProject(
        'project-1',
        'user-1',
        { deleteGithubRepo: true, confirmRepoName: 'no-slash' },
        'gh-token',
      );

      expect(result.githubRepoDeleted).toBe(false);
      expect(result.githubRepoDeleteError?.code).toBe('other');
      expect(githubServiceMock.deleteRepoForUser).not.toHaveBeenCalled();
      // Local disconnect still proceeds even for this failure mode.
      expect(projectsRepository.deleteByIdAndUser).toHaveBeenCalledWith(
        'project-1',
        'user-1',
        ['admin', 'delegated_lead'],
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventCode: 'project_github_repo_delete_failed',
          metadata: expect.objectContaining({ code: 'other' }),
        }),
      );
    });
  });

  it('returns an empty sync summary when the user has no projects', async () => {
    const auditEventsService = {
      recordProjectEvent: jest.fn(),
    };
    const notificationEventsService = {
      record: jest.fn(),
    };
    const syncService = new ProjectsService(
      makeCatalogService(),
      githubService,
      { listByUser: jest.fn().mockResolvedValue([]) } as never,
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      auditEventsService as never,
      undefined,
      notificationEventsService as never,
    );

    await expect(
      syncService.syncProjects('user-1', 'gh-token'),
    ).resolves.toEqual({
      orphaned: 0,
      reachable: 0,
      total: 0,
    });
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: null,
        eventCode: 'project_sync_completed',
        metadata: { orphaned: 0, reachable: 0, total: 0 },
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: null,
        eventCode: 'project_sync_completed',
      }),
    );
  });

  it('marks unreachable projects orphaned and reachable projects active during sync', async () => {
    const syncGithubService = {
      ...makeGithubService(),
      repoExists: jest
        .fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('transient')),
    } as unknown as GithubService;
    const projectsRepository = {
      listByUser: jest.fn().mockResolvedValue([
        { id: 'project-1', repo_full_name: 'tone/orders-api' },
        { id: 'project-2', repo_full_name: 'tone/deleted-api' },
        { id: 'project-3', repo_full_name: 'tone/flaky-api' },
      ]),
      markOrphaned: jest.fn().mockResolvedValue(1),
      markReachable: jest.fn().mockResolvedValue(1),
    };
    const auditEventsService = {
      recordProjectEvent: jest.fn(),
    };
    const notificationEventsService = {
      record: jest.fn(),
    };
    const syncService = new ProjectsService(
      makeCatalogService(),
      syncGithubService,
      projectsRepository as never,
      makeCiService(),
      projectDeploymentProvisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      auditEventsService as never,
      undefined,
      notificationEventsService as never,
    );

    await expect(
      syncService.syncProjects('user-1', 'gh-token'),
    ).resolves.toEqual({
      orphaned: 1,
      reachable: 1,
      total: 3,
    });
    expect(projectsRepository.markReachable).toHaveBeenCalledWith(
      ['project-1'],
      'user-1',
    );
    expect(projectsRepository.markOrphaned).toHaveBeenCalledWith(
      ['project-2'],
      'user-1',
    );
    expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: 'user-1',
        projectId: null,
        eventCode: 'project_sync_completed',
        metadata: { orphaned: 1, reachable: 1, total: 3 },
      }),
    );
    expect(notificationEventsService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        projectId: null,
        eventCode: 'project_sync_completed',
      }),
    );
  });

  describe('reconcileDeletedRepos', () => {
    it('returns an empty summary when there are no tracked projects', async () => {
      const reconcileGithubService = {
        ...makeGithubService(),
        getEnforcedOrg: jest.fn().mockReturnValue('Alpha-Explora'),
      } as unknown as GithubService;
      const projectsRepository = {
        listAllRepoFullNames: jest.fn().mockResolvedValue([]),
      };
      const reconcileService = new ProjectsService(
        makeCatalogService(),
        reconcileGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
      );

      await expect(reconcileService.reconcileDeletedRepos()).resolves.toEqual({
        total: 0,
        checked: 0,
        deleted: 0,
        skipped: 0,
        outOfScope: 0,
      });
      expect(
        reconcileGithubService.getOrganizationProvisioningContextByLogin,
      ).toHaveBeenCalledWith('Alpha-Explora');
    });

    it('deletes confirmed-404 rows, skips inconclusive checks, and leaves reachable rows alone', async () => {
      const reconcileGithubService = {
        ...makeGithubService(),
        getEnforcedOrg: jest.fn().mockReturnValue('Alpha-Explora'),
        repoExists: jest
          .fn()
          // Alpha-Explora/reachable-api -> still exists, leave alone
          .mockResolvedValueOnce(true)
          // Alpha-Explora/gone-api -> confirmed 404, delete
          .mockResolvedValueOnce(false)
          // Alpha-Explora/flaky-api -> inconclusive (bad token/5xx/network), skip
          .mockRejectedValueOnce(new Error('502 from GitHub')),
      } as unknown as GithubService;
      const projectsRepository = {
        listAllRepoFullNames: jest.fn().mockResolvedValue([
          {
            id: 'project-1',
            repo_full_name: 'Alpha-Explora/reachable-api',
            user_id: 'user-1',
          },
          {
            id: 'project-2',
            repo_full_name: 'Alpha-Explora/gone-api',
            user_id: 'user-2',
          },
          {
            id: 'project-3',
            repo_full_name: 'Alpha-Explora/flaky-api',
            user_id: 'user-3',
          },
        ]),
        deleteByRepoFullName: jest
          .fn()
          .mockResolvedValue([{ id: 'project-2', user_id: 'user-2' }]),
      };
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const notificationEventsService = { record: jest.fn() };
      const reconcileService = new ProjectsService(
        makeCatalogService(),
        reconcileGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        auditEventsService as never,
        undefined,
        notificationEventsService as never,
      );

      await expect(reconcileService.reconcileDeletedRepos()).resolves.toEqual({
        total: 3,
        checked: 3,
        deleted: 1,
        skipped: 1,
        outOfScope: 0,
      });

      expect(projectsRepository.deleteByRepoFullName).toHaveBeenCalledTimes(1);
      expect(projectsRepository.deleteByRepoFullName).toHaveBeenCalledWith(
        'Alpha-Explora/gone-api',
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-2',
          // Same FK reasoning as the webhook path: projectId is null, the
          // deleted id travels in metadata instead.
          projectId: null,
          eventCode: 'project_deleted_reconciliation',
          metadata: expect.objectContaining({
            repoFullName: 'Alpha-Explora/gone-api',
            source: 'reconciliation',
            deletedProjectId: 'project-2',
          }),
        }),
      );
      expect(notificationEventsService.record).toHaveBeenCalledTimes(1);
    });

    it('fans out a product event per distinct owner when multiple projects share a deleted repo', async () => {
      const reconcileGithubService = {
        ...makeGithubService(),
        getEnforcedOrg: jest.fn().mockReturnValue('Alpha-Explora'),
        repoExists: jest.fn().mockResolvedValue(false),
      } as unknown as GithubService;
      const projectsRepository = {
        listAllRepoFullNames: jest.fn().mockResolvedValue([
          {
            id: 'project-1',
            repo_full_name: 'Alpha-Explora/shared-gone-api',
            user_id: 'user-1',
          },
        ]),
        deleteByRepoFullName: jest.fn().mockResolvedValue([
          { id: 'project-1', user_id: 'user-1' },
          { id: 'project-9', user_id: 'user-9' },
        ]),
      };
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const notificationEventsService = { record: jest.fn() };
      const reconcileService = new ProjectsService(
        makeCatalogService(),
        reconcileGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        auditEventsService as never,
        undefined,
        notificationEventsService as never,
      );

      await expect(reconcileService.reconcileDeletedRepos()).resolves.toEqual({
        total: 1,
        checked: 1,
        deleted: 2,
        skipped: 0,
        outOfScope: 0,
      });
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'user-1', projectId: null }),
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'user-9', projectId: null }),
      );
      expect(notificationEventsService.record).toHaveBeenCalledTimes(2);
    });

    it('never checks or deletes a project whose repo is outside the enforced org', async () => {
      // Safety guard: this job authenticates with a single org-level
      // installation token, which returns 404 both for "deleted" and for
      // "not accessible to this token". A repo outside the enforced org
      // (e.g. one connected via the "import an existing repo" flow, which
      // can point at any owner) must never be passed to repoExists() at
      // all — otherwise a perfectly healthy external repo would look
      // "confirmed gone" and get wrongly deleted.
      const repoExistsSpy = jest.fn().mockResolvedValue(false);
      const reconcileGithubService = {
        ...makeGithubService(),
        getEnforcedOrg: jest.fn().mockReturnValue('Alpha-Explora'),
        repoExists: repoExistsSpy,
      } as unknown as GithubService;
      const projectsRepository = {
        listAllRepoFullNames: jest.fn().mockResolvedValue([
          {
            id: 'project-1',
            repo_full_name: 'some-other-owner/external-api',
            user_id: 'user-1',
          },
          {
            id: 'project-2',
            repo_full_name: 'alpha-explora/in-scope-api',
            user_id: 'user-2',
          },
        ]),
        deleteByRepoFullName: jest
          .fn()
          .mockResolvedValue([{ id: 'project-2', user_id: 'user-2' }]),
      };
      const reconcileService = new ProjectsService(
        makeCatalogService(),
        reconcileGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
      );

      await expect(reconcileService.reconcileDeletedRepos()).resolves.toEqual({
        total: 2,
        checked: 1,
        deleted: 1,
        skipped: 0,
        outOfScope: 1,
      });

      expect(repoExistsSpy).toHaveBeenCalledTimes(1);
      expect(repoExistsSpy).toHaveBeenCalledWith(
        'installation-token',
        // Org match is case-insensitive.
        'alpha-explora/in-scope-api',
      );
      expect(projectsRepository.deleteByRepoFullName).not.toHaveBeenCalledWith(
        'some-other-owner/external-api',
      );
    });
  });

  describe('repository.deleted webhook subscription', () => {
    it('subscribes to REPOSITORY_DELETED_EVENT on construction', () => {
      const onSpy = jest.fn();
      const webhookGithubService = {
        ...makeGithubService(),
        on: onSpy,
      } as unknown as GithubService;

      new ProjectsService(
        makeCatalogService(),
        webhookGithubService,
        makeProjectsRepository(),
        makeCiService(),
        projectDeploymentProvisioningService as never,
      );

      expect(onSpy).toHaveBeenCalledWith(
        'repository.deleted',
        expect.any(Function),
      );
    });

    it('hard-deletes matching projects and records a per-owner event when the repo is deleted', async () => {
      let capturedHandler:
        | ((event: { repoFullName: string }) => void)
        | undefined;
      const webhookGithubService = {
        ...makeGithubService(),
        on: jest.fn((eventName: string, handler: typeof capturedHandler) => {
          if (eventName === 'repository.deleted') {
            capturedHandler = handler;
          }
        }),
      } as unknown as GithubService;
      const projectsRepository = {
        deleteByRepoFullName: jest.fn().mockResolvedValue([
          { id: 'project-1', user_id: 'user-1' },
          { id: 'project-9', user_id: 'user-2' },
        ]),
      };
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const notificationEventsService = { record: jest.fn() };

      new ProjectsService(
        makeCatalogService(),
        webhookGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        auditEventsService as never,
        undefined,
        notificationEventsService as never,
      );

      expect(capturedHandler).toBeDefined();
      capturedHandler?.({ repoFullName: 'Alpha-Explora/some-repo' });
      // The handler is fire-and-forget (async work runs after the sync
      // .on() callback returns), so flush microtasks before asserting.
      await Promise.resolve();
      await Promise.resolve();

      expect(projectsRepository.deleteByRepoFullName).toHaveBeenCalledWith(
        'Alpha-Explora/some-repo',
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-1',
          // projectId must be null — the row is already deleted by the time
          // this runs, and audit_events.project_id has an FK to
          // provisioned_projects, so a non-null id here would fail the
          // insert. The deleted id still travels in metadata.
          projectId: null,
          eventCode: 'project_deleted_webhook',
          metadata: expect.objectContaining({ deletedProjectId: 'project-1' }),
        }),
      );
      expect(auditEventsService.recordProjectEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-2',
          projectId: null,
          eventCode: 'project_deleted_webhook',
          metadata: expect.objectContaining({ deletedProjectId: 'project-9' }),
        }),
      );
      expect(notificationEventsService.record).toHaveBeenCalledTimes(2);
      expect(notificationEventsService.record).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: null }),
      );
    });

    it('does nothing when no project matches the deleted repo', async () => {
      let capturedHandler:
        | ((event: { repoFullName: string }) => void)
        | undefined;
      const webhookGithubService = {
        ...makeGithubService(),
        on: jest.fn((eventName: string, handler: typeof capturedHandler) => {
          if (eventName === 'repository.deleted') {
            capturedHandler = handler;
          }
        }),
      } as unknown as GithubService;
      const projectsRepository = {
        deleteByRepoFullName: jest.fn().mockResolvedValue([]),
      };
      const auditEventsService = { recordProjectEvent: jest.fn() };
      const notificationEventsService = { record: jest.fn() };

      new ProjectsService(
        makeCatalogService(),
        webhookGithubService,
        projectsRepository as never,
        makeCiService(),
        projectDeploymentProvisioningService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        auditEventsService as never,
        undefined,
        notificationEventsService as never,
      );

      capturedHandler?.({ repoFullName: 'tone/never-provisioned' });
      await Promise.resolve();
      await Promise.resolve();

      expect(auditEventsService.recordProjectEvent).not.toHaveBeenCalled();
      expect(notificationEventsService.record).not.toHaveBeenCalled();
    });
  });

  it('builds workflow YAML with generated defaults and enhancement flags', async () => {
    const workflowService = service as unknown as {
      buildWorkflowYaml: (
        templateId: string,
        serviceName: string,
        servicePath?: string,
        nodeVersion?: string,
        coverageThreshold?: number,
        customOutputFileName?: string,
        enhancements?: Array<
          | 'strictProductionApproval'
          | 'enableUatApproval'
          | 'disablePlaywright'
          | 'disableK6'
        >,
      ) => Promise<{ generatedYaml: string; outputFileName: string }>;
    };

    mockedReadFile.mockResolvedValueOnce(`
name: CI
on:
  workflow_dispatch:
    inputs:
      service_name:
        type: string
jobs:
  pipeline:
    with: {}
`);

    const result = await workflowService.buildWorkflowYaml(
      'be-nestjs',
      'Orders API',
      'apps/api',
      '24',
      90,
      undefined,
      [
        'strictProductionApproval',
        'enableUatApproval',
        'disablePlaywright',
        'disableK6',
      ],
    );

    expect(result.outputFileName).toBe('orders-api-be-nestjs.yml');
    expect(result.generatedYaml).toContain('Orders API - Backend API');
    expect(result.generatedYaml).toContain('default: apps/api');
    expect(result.generatedYaml).toContain("default: '24'");
    expect(result.generatedYaml).toContain('default: 90');
    expect(result.generatedYaml).toContain('run-playwright: false');
    expect(result.generatedYaml).toContain('run-k6: false');
    expect(result.generatedYaml).toContain('require-uat-approval: true');
    expect(result.generatedYaml).toContain('require-production-approval: true');
  });

  it('throws when workflow YAML template cannot be parsed as an object', async () => {
    const workflowService = service as unknown as {
      buildWorkflowYaml: (
        templateId: string,
        serviceName: string,
      ) => Promise<{ generatedYaml: string; outputFileName: string }>;
    };
    mockedReadFile.mockResolvedValueOnce('- invalid');

    await expect(
      workflowService.buildWorkflowYaml('be-nestjs', 'Orders API'),
    ).rejects.toThrow('Workflow template could not be parsed');
  });
});
