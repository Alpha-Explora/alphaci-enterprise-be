import { readFile } from 'node:fs/promises';

import type { CatalogService } from '../catalog/catalog.service.js';
import type { GithubService } from '../github/github.service.js';
import { ExistingReposService } from './existing-repos.service.js';

jest.mock('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

const mockedReadFile = readFile as jest.MockedFunction<typeof readFile>;

const makeGithubService = () =>
  ({
    getInstallationAccessTokenForUser: jest.fn().mockResolvedValue('app-token'),
    getInstallationAccessTokenForUserRepo: jest
      .fn()
      .mockResolvedValue('app-token'),
    getFileContent: jest.fn().mockResolvedValue(
      JSON.stringify({
        dependencies: { next: '16.0.0' },
        devDependencies: { typescript: '5.0.0' },
      }),
    ),
    createBranch: jest.fn().mockResolvedValue(undefined),
    // Preflight reads (added 2026-08-18). Defaults describe the CLEAN repo:
    // default branch main, no protection, no Sonar, no uat — so the existing
    // assertions keep describing the same repository they always did.
    getRepo: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
    requiresPullRequestToPush: jest.fn().mockResolvedValue(false),
    listActionsSecretNames: jest.fn().mockResolvedValue(new Set<string>()),
    branchExists: jest.fn().mockResolvedValue(false),
    putFileContent: jest.fn().mockResolvedValue({
      commitSha: 'commit-sha',
      commitUrl: 'https://github.com/tone/app/commit/commit-sha',
    }),
    createPullRequest: jest.fn().mockResolvedValue({
      number: 42,
      htmlUrl: 'https://github.com/tone/app/pull/42',
    }),
  }) as unknown as GithubService;

const makeCatalogService = () =>
  ({
    getProjectOptions: jest.fn().mockReturnValue({
      recipes: [
        {
          id: 'standard',
          templateByProjectType: {
            nextjs: 'nextjs-service-pipeline',
            nestjs: 'nest-service-pipeline',
          },
        },
      ],
    }),
    getTemplateById: jest.fn().mockResolvedValue({
      id: 'nextjs-service-pipeline',
      name: 'Next.js Service',
      workflowPath: 'workflow-templates/nextjs-service-pipeline.yml',
    }),
  }) as unknown as CatalogService;

describe('ExistingReposService', () => {
  let githubService: GithubService;
  let service: ExistingReposService;

  beforeEach(() => {
    githubService = makeGithubService();
    service = new ExistingReposService(githubService, makeCatalogService());
    mockedReadFile.mockResolvedValue(`
name: Service CI
on:
  workflow_dispatch:
    inputs: {}
jobs:
  pipeline:
    with: {}
`);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('discovers an existing repo and recommends a workflow plan', async () => {
    const result = await service.discover('user-1', null, {
      repoFullName: 'tone/app',
      baseBranch: 'main',
    });

    expect(
      githubService.getInstallationAccessTokenForUserRepo,
    ).toHaveBeenCalledWith('user-1', 'tone/app');
    expect(githubService.getFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      'package.json',
      'main',
    );
    expect(result).toMatchObject({
      repoFullName: 'tone/app',
      baseBranch: 'main',
      detectedProjectTypeId: 'nextjs',
      recommendedWorkflowRecipeId: 'standard',
      serviceName: 'app',
      servicePath: '.',
    });
  });

  it('creates a setup branch and pull request for an existing repo', async () => {
    const result = await service.setupPullRequest('user-1', null, {
      repoFullName: 'tone/app',
      baseBranch: 'main',
      projectTypeId: 'nextjs',
      workflowRecipeId: 'standard',
      serviceName: 'app',
      servicePath: '.',
      outputFileName: 'ci.yml',
    });

    expect(githubService.createBranch).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      'alphaci/app-ci',
      'main',
    );
    expect(githubService.putFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      '.github/workflows/ci.yml',
      expect.stringContaining('app - Next.js Service'),
      'alphaci/app-ci',
      'ci: add ALPHACI workflow',
    );
    expect(githubService.createPullRequest).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      expect.objectContaining({
        head: 'alphaci/app-ci',
        base: 'main',
      }),
    );
    expect(result).toEqual({
      repoFullName: 'tone/app',
      branchName: 'alphaci/app-ci',
      workflowPath: '.github/workflows/ci.yml',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/tone/app/pull/42',
    });
  });

  it.each([
    [{ dependencies: { '@nestjs/core': '11.0.0' } }, 'nestjs'],
    [{ dependencies: { react: '19.0.0' } }, 'react'],
    [{ dependencies: { express: '5.0.0' } }, 'nodejs'],
    [{ dependencies: { fastify: '5.0.0' } }, 'nodejs'],
    [{ dependencies: {} }, null],
  ])(
    'detects project type from package dependencies',
    async (pkg, expected) => {
      (githubService.getFileContent as jest.Mock).mockResolvedValueOnce(
        JSON.stringify(pkg),
      );

      await expect(
        service.discover('user-1', null, {
          repoFullName: 'tone/app',
        }),
      ).resolves.toMatchObject({
        baseBranch: 'main',
        detectedProjectTypeId: expected,
      });
    },
  );

  it('falls back to the OAuth token when no app installation token exists', async () => {
    (
      githubService.getInstallationAccessTokenForUserRepo as jest.Mock
    ).mockResolvedValueOnce(null);

    await service.discover('user-1', 'oauth-token', {
      repoFullName: 'tone/app',
    });

    expect(githubService.getFileContent).toHaveBeenCalledWith(
      'oauth-token',
      'tone',
      'app',
      'package.json',
      'main',
    );
  });

  it('rejects discovery when no GitHub token source is available', async () => {
    (
      githubService.getInstallationAccessTokenForUserRepo as jest.Mock
    ).mockResolvedValueOnce(null);

    await expect(
      service.discover('user-1', null, {
        repoFullName: 'tone/app',
      }),
    ).rejects.toThrow('No usable GitHub token found');
  });

  it('rejects malformed repo full names', async () => {
    await expect(
      service.discover('user-1', null, {
        repoFullName: 'tone',
      }),
    ).rejects.toThrow('Invalid repoFullName');
  });

  it('uses fallback template and sanitized output names for setup PRs', async () => {
    const result = await service.setupPullRequest('user-1', null, {
      repoFullName: 'tone/app',
      projectTypeId: 'unknown',
      serviceName: 'Orders API',
      nodeVersion: '24',
      coverageThreshold: 90,
    });

    expect(result).toMatchObject({
      branchName: 'alphaci/orders-api-ci',
      workflowPath: '.github/workflows/orders-api-unknown-standard.yml',
    });
    expect(githubService.putFileContent).toHaveBeenCalledWith(
      'app-token',
      'tone',
      'app',
      '.github/workflows/orders-api-unknown-standard.yml',
      expect.stringContaining("default: '24'"),
      'alphaci/orders-api-ci',
      'ci: add ALPHACI workflow',
    );
  });

  it('throws when the selected workflow template does not exist', async () => {
    const catalogService = makeCatalogService();
    (catalogService.getTemplateById as jest.Mock).mockResolvedValueOnce(null);
    service = new ExistingReposService(githubService, catalogService);

    await expect(
      service.setupPullRequest('user-1', null, {
        repoFullName: 'tone/app',
        projectTypeId: 'nextjs',
        serviceName: 'app',
      }),
    ).rejects.toThrow("Template 'nextjs-service-pipeline' not found");
  });

  it('throws when workflow template YAML is not an object', async () => {
    mockedReadFile.mockResolvedValueOnce('- invalid');

    await expect(
      service.setupPullRequest('user-1', null, {
        repoFullName: 'tone/app',
        projectTypeId: 'nextjs',
        serviceName: 'app',
      }),
    ).rejects.toThrow('Workflow template could not be parsed');
  });

  /*
   * ONBOARDING AN EXISTING REPOSITORY (2026-08-18).
   *
   * Every case below was a real defect before this suite existed: the push
   * branch was hardcoded to 'main', a failed setup left its secrets behind,
   * SonarCloud config was silently overwritten, and `uat` was never created so
   * half the pipeline sat dormant with no error.
   */
  describe('discover: preflight', () => {
    it('uses the repository OWN default branch instead of assuming main', async () => {
      githubService.getRepo = jest
        .fn()
        .mockResolvedValue({ defaultBranch: 'master' });

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/legacy',
      });

      expect(result.baseBranch).toBe('master');
    });

    it('still honours an explicit baseBranch from the caller', async () => {
      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
        baseBranch: 'develop',
      });

      expect(result.baseBranch).toBe('develop');
      expect(githubService.getRepo).not.toHaveBeenCalled();
    });

    it('warns that a protected branch will reject the commit', async () => {
      githubService.requiresPullRequestToPush = jest
        .fn()
        .mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain('branch_protected');
    });

    it('does NOT warn when protection cannot be read — an unknown is not a blocker', async () => {
      githubService.requiresPullRequestToPush = jest
        .fn()
        .mockResolvedValue(null);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).not.toContain(
        'branch_protected',
      );
    });

    it('warns that existing SonarCloud secrets will be left alone', async () => {
      githubService.listActionsSecretNames = jest
        .fn()
        .mockResolvedValue(new Set(['SONAR_TOKEN']));

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain(
        'sonar_already_configured',
      );
    });

    it('says a uat branch will be created when the repository has none', async () => {
      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).toContain('uat_missing');
    });

    it('stays quiet about uat when the repository already has one', async () => {
      githubService.branchExists = jest.fn().mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings.map((w) => w.code)).not.toContain('uat_missing');
    });

    it('tells the user to pick a stack when none could be detected', async () => {
      githubService.getFileContent = jest.fn().mockResolvedValue(null);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.detectedProjectTypeId).toBeNull();
      expect(result.warnings.map((w) => w.code)).toContain(
        'project_type_undetected',
      );
    });

    it('reports a clean repository with no warnings at all', async () => {
      githubService.branchExists = jest.fn().mockResolvedValue(true);

      const result = await service.discover('user-1', 'token', {
        repoFullName: 'tone/app',
      });

      expect(result.warnings).toEqual([]);
    });
  });

});
