import { readFile } from 'node:fs/promises';

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import yaml from 'js-yaml';

import type { AppConfig } from '../../config/app.config';
import { CatalogService } from '../catalog/catalog.service';
import { CiService } from '../ci/ci.service';
import {
  CiTokensRepository,
  type ProjectTokenStatus,
} from '../ci/ci-tokens.repository';
import { AuditEventsService } from '../audit/audit-events.service';
import { DeploymentTargetsRepository } from '../env-provisioning/deployment-targets.repository';
import { EnvVarsRepository } from '../env-provisioning/env-vars.repository';
import type {
  DeploymentTargetSummary,
  EnvVarMetadata,
} from '../env-provisioning/env-provisioning.types';
import {
  GithubRepoDeleteError,
  GithubService,
  REPOSITORY_DELETED_EVENT,
  type GithubRepoDeleteErrorCode,
  type RepositoryDeletedEvent,
} from '../github/github.service';
import { ProjectDeploymentProvisioningService } from '../env-provisioning/project-deployment-provisioning.service';
import { HierarchyProjectLinkService } from '../hierarchy/project-link/hierarchy-project-link.service';
import {
  WorkflowHistoryRepository,
  type WorkflowHistoryEntry,
} from '../persistence/workflow-history.repository';
import {
  ProjectsRepository,
  type ProvisionedProjectRow,
  type ProvisionedProjectStatus,
} from './projects.repository';
import {
  ProjectDashboardSnapshotsRepository,
  type ProjectDashboardSnapshot,
  type ProjectDashboardSnapshotFinding,
} from './project-dashboard-snapshots.repository';
import {
  ProjectWorkflowSettingsRepository,
  type ProjectWorkflowSettingsRowValue,
} from './project-workflow-settings.repository';
import {
  ProjectWorkflowUpdateRequestsRepository,
  type WorkflowUpdateRequestRecord,
} from './project-workflow-update-requests.repository';
import type { CreateProjectDto } from './dto/create-project.dto';
import type { SetupProjectDto } from './dto/setup-project.dto';
import type { DisconnectProjectDto } from './dto/disconnect-project.dto';
import {
  ALPHACI_REPORT_URL,
  buildStagedWorkflowBundle,
  resolveDefaultCentralWorkflowRef,
  type StagedWorkflowFile,
  type WorkflowFileMetadata,
} from '../workflows/staged-workflow.builder';
import type {
  DeploymentProvider,
  DeploymentWorkflowTarget,
} from '../workflows/dto/generate-workflow.dto';
import { UsageQuotaService } from '../usage/usage-quota.service';
import type { UsageLimitCode } from '../usage/usage.types';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { WorkspaceRole } from '../workspaces/workspaces.repository';
import { NotificationEventsService } from '../notifications/notification-events.service';
import {
  buildProjectScaffold,
  defaultIncludeDocker,
  normalizeProjectStack,
  normalizeRepoShape,
} from './scaffold.builder';
import type {
  DeploymentProvisioningRequestDto,
  DeploymentProvisioningTargetDto,
} from './dto/create-project.dto';

// ─── Response shapes (match FE contracts exactly) ────────────────────────────

export interface CreateProjectResponse {
  id: string;
  repoFullName: string;
  repoUrl: string;
  status: 'provisioned';
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  githubCommitSha: string;
  githubCommitUrl: string | null;
  projectTypeId: string;
  workflowRecipeId: string;
  additionalWorkflowPaths?: string[];
  secondaryRepoFullName?: string;
  secondaryRepoUrl?: string;
  deploymentProvisioning: DeploymentProvisioningResult;
}

export interface SetupProjectResponse {
  id: string;
  repoFullName: string;
  status: 'provisioned';
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  githubCommitSha: string;
  githubCommitUrl: string | null;
  deploymentProvisioning: DeploymentProvisioningResult;
}

export interface DeploymentProvisioningResult {
  status: 'skipped' | 'completed' | 'partial' | 'failed';
  targets: Array<{
    slot: 'backend' | 'frontend' | 'standalone';
    provider: 'render' | 'vercel';
    ownershipMode: 'byo' | 'flowci_managed';
    deploymentStrategy:
      | 'provider_native'
      | 'vercel_git_connected'
      | 'vercel_ci_pushed'
      | 'render_git_connected'
      | 'render_image_pushed'
      | 'render_existing_service'
      | null;
    status: 'created' | 'registered' | 'failed';
    deploymentTargetId: string | null;
    providerProjectId: string | null;
    providerProjectName: string | null;
    providerMetadata: Record<string, unknown>;
    renderServiceType?: string | null;
    renderRuntime?: string | null;
    renderInstanceType?: string | null;
    renderRegion?: string | null;
    renderEnvironmentName?: 'test' | 'uat' | 'production' | null;
    dockerContext?: string | null;
    dockerfilePath?: string | null;
    imageUrl?: string | null;
    errorSummary: string | null;
    env: Array<{
      environment: 'test' | 'uat' | 'production';
      provisioned: Array<{ key: string; status: 'provisioned' }>;
      failed: Array<{ key: string; status: 'failed'; errorSummary: string }>;
    }>;
  }>;
}

export interface ProvisionedProject {
  id: string;
  repoFullName: string;
  templateId: string;
  serviceName: string;
  workflowPath: string;
  workflowFiles?: WorkflowFileMetadata[] | null;
  status: ProvisionedProjectStatus;
  githubCommitSha: string | null;
  githubCommitUrl: string | null;
  failureReason: string | null;
  repoUrl?: string | null;
  visibility?: string | null;
  repoShape?: string | null;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  projectOptions?: Record<string, unknown> | null;
  /**
   * Owning workspace (orgs.workspaces.id). For hierarchy-managed repositories
   * this is the GROUP id — the FE Projects screen groups the list by it.
   */
  workspaceId?: string | null;
  /**
   * Viewer-relative: true only when the authenticated user is the actual
   * project creator, not just able to see it via admin/manager visibility.
   * Only populated by `listByUser`-backed reads (currently `listProjects`) —
   * undefined elsewhere (e.g. `findByIdAndUser`-backed reads).
   */
  isOwner?: boolean | undefined;
}

export interface SyncProjectsResponse {
  orphaned: number;
  reachable: number;
  total: number;
}

export interface ReconcileDeletedReposResult {
  /** Total tracked projects fetched for this reconciliation pass. */
  total: number;
  /** Rows actually checked against GitHub — `total` minus `outOfScope`. */
  checked: number;
  /** Rows hard-deleted after a confirmed 404 from GitHub. */
  deleted: number;
  /** Rows left untouched because the GitHub check was inconclusive
   *  (401/403/5xx/network error) — never treated as "confirmed gone". */
  skipped: number;
  /** Rows never checked at all because their repo doesn't belong to the
   *  enforced org — the org-scoped installation token can't reliably tell
   *  "deleted" apart from "not accessible to this token" for those repos
   *  (e.g. projects added via the "import an existing repo" flow, which can
   *  point at a personal account or a different org). See the method doc
   *  on reconcileDeletedRepos() for the full reasoning. */
  outOfScope: number;
}

export interface DisconnectProjectResponse {
  ok: true;
  githubRepoDeleted: boolean;
  githubRepoDeleteError?: {
    code: GithubRepoDeleteErrorCode;
    message: string;
  };
}

export interface ProvisionedProjectsResponse {
  items: ProvisionedProject[];
}

export type ProjectOverviewHealthStatus = 'ok' | 'warning' | 'error';

export interface ProjectOverviewResponse {
  project: ProvisionedProject & {
    createdAt: string;
    updatedAt: string;
  };
  workflow: {
    path: string;
    files: WorkflowFileMetadata[];
    stageCount: number;
    history: WorkflowHistoryEntry[];
  };
  deploymentTargets: {
    items: DeploymentTargetSummary[];
    count: number;
  };
  environment: {
    items: EnvVarMetadata[];
    count: number;
    failedCount: number;
  };
  ciAuth: {
    status: 'active' | 'revoked' | 'missing';
    tokenPresent: boolean;
    tokenPrefix: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    revokedAt: string | null;
  };
  health: {
    summary: ProjectOverviewHealthStatus;
    checks: Array<{
      key: string;
      label: string;
      status: ProjectOverviewHealthStatus;
      message: string;
    }>;
  };
  syncSnapshot: {
    enabled: boolean;
    mode: 'local_snapshot';
    latest: ProjectDashboardSnapshot | null;
  };
  capabilities: {
    envProvisioning: boolean;
    workflowSettings: boolean;
    syncSnapshots: boolean;
    ciRunTracking: boolean;
    deploymentHistory: boolean;
    driftDetection: boolean;
  };
  /**
   * The hierarchy.repositories id this project is linked to, or null.
   *
   * Developer assignments hang off hierarchy.repositories, not off
   * provisioned_projects, so without this id the project page has no way to
   * address its own access panel. Null means "no assignment surface for this
   * project" — a personal-workspace project, or one created before the link
   * existed — and the UI hides the entry point rather than guessing a URL.
   */
  hierarchyRepositoryId: string | null;
}

export interface ProjectSyncSnapshotResponse {
  snapshot: ProjectDashboardSnapshot;
  overview: ProjectOverviewResponse;
}

export interface ProjectAuditEventsResponse {
  enabled: boolean;
  items: Array<{
    id: string;
    eventCode: string;
    message: string;
    actorUserId: string | null;
    createdAt: string;
  }>;
}

export interface WorkflowSettings {
  projectId: string;
  templateId: string;
  projectTypeId: string | null;
  workflowRecipeId: string | null;
  serviceName: string;
  servicePath: string;
  nodeVersion: string;
  packageManager: 'npm';
  coverageThreshold: number;
  centralWorkflowRef: string;
  checks: {
    lint: boolean;
    unit: boolean;
    build: boolean;
    security: boolean;
  };
}

export interface WorkflowSettingsResponse {
  enabled: boolean;
  source: 'stored' | 'project_options';
  settings: WorkflowSettings;
}

export interface WorkflowSettingsPreviewRequest {
  templateId?: string;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  serviceName?: string;
  servicePath?: string;
  nodeVersion?: string;
  packageManager?: 'npm';
  coverageThreshold?: number;
  centralWorkflowRef?: string;
  checks?: Partial<WorkflowSettings['checks']>;
}

export interface WorkflowSettingsPreviewResponse {
  settings: WorkflowSettings;
  workflowFiles: StagedWorkflowFile[];
  diffSummary: Array<{
    path: string;
    status: 'new' | 'changed' | 'unchanged';
  }>;
  validationWarnings: Array<{
    field: string;
    message: string;
  }>;
}

export interface WorkflowUpdatePullRequestResponse {
  projectId: string;
  repoFullName: string;
  branchName: string;
  workflowPath: string;
  workflowFiles: WorkflowFileMetadata[];
  pullRequestNumber: number;
  pullRequestUrl: string;
  status: 'created';
  request: WorkflowUpdateRequestRecord | null;
}

// ─── GitHub Contents API response ────────────────────────────────────────────

interface GitHubContentsResponse {
  content: { html_url?: string };
  commit: { sha: string; html_url?: string };
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(
    private readonly catalogService: CatalogService,
    private readonly githubService: GithubService,
    private readonly projectsRepository: ProjectsRepository,
    private readonly ciService: CiService,
    private readonly projectDeploymentProvisioningService: ProjectDeploymentProvisioningService,
    @Optional()
    private readonly ciTokensRepository?: CiTokensRepository,
    @Optional()
    private readonly deploymentTargetsRepository?: DeploymentTargetsRepository,
    @Optional()
    private readonly envVarsRepository?: EnvVarsRepository,
    @Optional()
    private readonly workflowHistoryRepository?: WorkflowHistoryRepository,
    @Optional()
    private readonly dashboardSnapshotsRepository?: ProjectDashboardSnapshotsRepository,
    @Optional()
    private readonly configService?: ConfigService,
    @Optional()
    private readonly workflowSettingsRepository?: ProjectWorkflowSettingsRepository,
    @Optional()
    private readonly workflowUpdateRequestsRepository?: ProjectWorkflowUpdateRequestsRepository,
    @Optional()
    private readonly usageQuotaService?: UsageQuotaService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly workspacesService?: WorkspacesService,
    @Optional()
    private readonly notificationEventsService?: NotificationEventsService,
    @Optional()
    private readonly workspaceAccessService?: WorkspaceAccessService,
    // Optional and last, like every collaborator above it: the existing specs
    // construct ProjectsService positionally, and an absent linker simply
    // means group projects are not linked (the migration backfill still is).
    @Optional()
    private readonly hierarchyProjectLinkService?: HierarchyProjectLinkService,
  ) {
    // GithubModule cannot import ProjectsModule (that would create a
    // Projects → Github → Projects cycle), so GithubService can't inject
    // ProjectsRepository/ProjectsService directly. Instead GithubService
    // emits a plain EventEmitter event when a `repository` `deleted`
    // webhook arrives, and — since ProjectsService already depends on
    // GithubService one-way — this subscribes here to react to it. Fire-and
    // -forget is intentional: handleWebhook() has already ack'd the
    // delivery to GitHub by the time this listener runs, so failures are
    // logged, not thrown.
    this.githubService.on(
      REPOSITORY_DELETED_EVENT,
      (event: RepositoryDeletedEvent) => {
        this.handleRepositoryDeleted(event).catch((error) => {
          this.logger.warn(
            `Failed to process repository.deleted webhook for ${event.repoFullName}: ${String(error)}`,
          );
        });
      },
    );
  }

  /**
   * Reacts to GithubService's REPOSITORY_DELETED_EVENT (see constructor).
   * Hard-deletes every provisioned project matching the deleted repo —
   * matched by repo_full_name across all owners, since the GitHub webhook
   * carries no user context — and records a per-owner product event for
   * each row touched, so the deletion is still visible in audit/notification
   * history even though the row itself is gone.
   *
   * projectId is deliberately `null` on these events, NOT `row.id`: both
   * audit.audit_events.project_id and notifications.notifications.project_id
   * are `REFERENCES projects.provisioned_projects(id)`, and by the time this
   * runs that row has already been deleted — an INSERT referencing it would
   * fail its FK constraint (ON DELETE SET NULL only rewrites *existing*
   * rows, it doesn't permit new ones pointing at a since-deleted id). The
   * deleted project's id is preserved in metadata instead. This mirrors
   * disconnectProject(), which never emits a product event with a projectId
   * after the delete that removes that project.
   */
  private async handleRepositoryDeleted(
    event: RepositoryDeletedEvent,
  ): Promise<void> {
    const deletedRows = await this.projectsRepository.deleteByRepoFullName(
      event.repoFullName,
    );
    if (deletedRows.length === 0) {
      return;
    }

    this.logger.log(
      `Deleted ${deletedRows.length} project(s) after GitHub reported ${event.repoFullName} deleted`,
    );

    await Promise.all(
      deletedRows.map((row) =>
        this.recordProductEvent({
          userId: row.user_id,
          projectId: null,
          eventCode: 'project_deleted_webhook',
          title: 'Repository deleted on GitHub',
          body: `The GitHub repository ${event.repoFullName} was deleted, so this project has been deleted.`,
          metadata: {
            repoFullName: event.repoFullName,
            source: 'webhook',
            deletedProjectId: row.id,
          },
        }),
      ),
    );
  }

  // ─── POST /projects ────────────────────────────────────────────────────────

  async createProject(
    userId: string,
    userLogin: string,
    accessToken: string | null,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    await this.assertWithinQuota(userId, 'projects', 1, null);
    const {
      repositoryCreationToken,
      provisioningToken,
      provisioningOwnerLogin,
    } = await this.resolveRepositoryProvisioning(userId, accessToken, dto);

    // The catalog publishes the shape IDs 'mono' and 'multi'; normalize so
    // the flow dispatch never silently falls back to the standalone path.
    const repoShape = normalizeRepoShape(dto.repoShape);

    if (repoShape === 'microservices') {
      return this.createMicroservicesProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    if (repoShape === 'multi-repo') {
      return this.createMultiRepoProject(
        userId,
        userLogin,
        repositoryCreationToken,
        provisioningToken,
        provisioningOwnerLogin,
        dto,
      );
    }

    // 1. Resolve templateId from projectTypeId + workflowRecipeId
    const templateId = this.resolveTemplateId(
      dto.projectTypeId,
      dto.workflowRecipeId,
    );
    const effectiveDeploymentProvisioning =
      this.withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: dto.projectTypeId,
        serviceName: dto.serviceName,
        repoName: dto.repoName,
        servicePath: dto.servicePath,
      });

    // 2. Load template and build workflow YAML
    const { workflowFiles, outputFileName } = await this.buildWorkflowBundle({
      templateId,
      serviceName: dto.serviceName,
      servicePath: dto.servicePath,
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      customOutputFileName: dto.outputFileName,
      // The standalone scaffold ships tests/ at the repo root; the monorepo
      // keeps tests under packages/*, so the root-level guard stays off.
      hasTestsDirectory: repoShape === 'standalone',
      deploymentProvider: this.extractDeploymentProvider(
        effectiveDeploymentProvisioning,
        'backend',
      ),
      deploymentTargets: this.resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['standalone', 'backend', 'frontend'],
        dto.servicePath,
      ),
    });

    // 3. Create the GitHub repository (auto_init: true creates main branch)
    const { repoUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: dto.repoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

    const repoFullName = `${ownerLogin}/${repoName}`;
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    // Once the repo exists, wrap the remaining steps so a mid-flow failure
    // compensates by deleting the half-created repo + DB row instead of leaving
    // an orphan that would 422 on the next attempt.
    let row: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      // 3.5 Push scaffold + README to main so all downstream branches inherit them
      await this.pushStarterFiles(provisioningToken, ownerLogin, repoName, {
        projectName: dto.serviceName,
        stack: dto.projectTypeId,
        repoShape,
        ...(dto.tests?.['docker'] !== undefined && {
          includeDocker: dto.tests['docker'],
        }),
      });

      // 4. Persist the project, issue the CI token, and install the Actions
      // secrets BEFORE any workflow YAML exists. The access-gate workflow runs
      // the instant a workflow file is pushed (and again on branch creation),
      // so the secrets must already be present or that first run fails for lack
      // of ALPHACI_TOKEN. Secrets are installed strictly so a token without
      // `secrets:write` aborts provisioning here rather than producing a repo
      // whose pipelines can never authenticate.
      row = await this.createProjectRow({
        userId,
        workspaceId: await this.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        ),
        repoFullName,
        templateId,
        serviceName: dto.serviceName,
        workflowPath,
        status: 'provisioned',
        repoUrl,
        visibility: dto.visibility,
        repoShape,
        projectTypeId: dto.projectTypeId,
        workflowRecipeId: dto.workflowRecipeId ?? null,
        projectOptions: {
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: this.workflowFileMetadata(workflowFiles),
        },
      });

      const ciToken = await this.ciService.issueProjectToken(row.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.installSonarSecrets(provisioningToken, ownerLogin, repoName);

      // 5. Push workflow YAML to main now that the secrets exist, then record
      // the resulting commit on the project row.
      const { commitSha, commitUrl } = await this.pushWorkflowFiles(
        provisioningToken,
        ownerLogin,
        repoName,
        workflowFiles,
      );
      await this.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );

      // 6. Create develop and uat from main. `develop` is intentionally
      // unprotected and has no CI trigger; uat is the integration/test branch.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 7. Only uat and main are protected long-lived branches.
      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
        );
      }

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      // Create the requested hosting targets on the centralized platform
      // accounts and install their Render/Vercel Actions secrets.
      const deploymentProvisioning = await this.provisionDeploymentTargets({
        projectId: row.id,
        userId,
        repoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: this.resolveSingleRepoDeploymentSlots(
          effectiveDeploymentProvisioning,
        ),
      });

      await this.recordProductEvent({
        userId,
        projectId: row.id,
        eventCode: 'project_created',
        title: 'Project created',
        body: `${repoFullName} is now tracked by ALPHACI.`,
        metadata: {
          repoFullName,
          repoShape,
          projectTypeId: dto.projectTypeId,
        },
      });

      return {
        id: row.id,
        repoFullName,
        repoUrl,
        status: 'provisioned',
        workflowPath,
        workflowFiles: this.workflowFileMetadata(workflowFiles),
        githubCommitSha: commitSha,
        githubCommitUrl: commitUrl,
        projectTypeId: dto.projectTypeId,
        workflowRecipeId: dto.workflowRecipeId ?? '',
        deploymentProvisioning,
      };
    } catch (error) {
      if (!provisioningComplete) {
        await this.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          repoName,
          row?.id,
          userId,
        );
      }
      throw error;
    }
  }

  // ─── POST /projects (microservices shape) ─────────────────────────────────

  private async createMicroservicesProject(
    userId: string,
    _userLogin: string,
    repositoryCreationToken: string,
    provisioningToken: string,
    provisioningOwnerLogin: string | undefined,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    if (!dto.microservicesConfig) {
      throw new UnprocessableEntityException(
        'microservicesConfig is required for microservices shape',
      );
    }

    const { backend, frontend } = dto.microservicesConfig;
    const effectiveDeploymentProvisioning =
      this.withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: backend.projectTypeId,
        serviceName: backend.serviceName,
        repoName: dto.repoName,
        servicePath: backend.servicePath ?? 'backend',
      });

    // 1. Resolve template IDs for both slots
    const backendTemplateId = this.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    const frontendTemplateId = this.resolveTemplateId(
      frontend.projectTypeId,
      frontend.workflowRecipeId,
    );

    // 2. Build workflow YAML for both slots. Each slot gets a variant suffix
    // so the two pipelines coexist in one repo without overwriting each other,
    // and service paths default to the scaffold's backend/ and frontend/ dirs.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.buildWorkflowBundle({
      templateId: backendTemplateId,
      serviceName: backend.serviceName,
      servicePath: backend.servicePath ?? 'backend',
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      workflowVariant: 'backend',
      // The scaffold seeds tests/ only inside its own backend/ dir; a custom
      // servicePath points at a layout the scaffold does not control.
      hasTestsDirectory: (backend.servicePath ?? 'backend') === 'backend',
      deploymentProvider: this.extractDeploymentProvider(
        effectiveDeploymentProvisioning,
        'backend',
      ),
      deploymentTargets: this.resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['backend'],
        backend.servicePath ?? 'backend',
      ),
    });

    const {
      workflowFiles: frontendWorkflowFiles,
      outputFileName: frontendOutputFileName,
    } = await this.buildWorkflowBundle({
      templateId: frontendTemplateId,
      serviceName: frontend.serviceName,
      servicePath: frontend.servicePath ?? 'frontend',
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      workflowVariant: 'frontend',
      hasTestsDirectory: (frontend.servicePath ?? 'frontend') === 'frontend',
      deploymentTargets: this.resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['frontend'],
        frontend.servicePath ?? 'frontend',
      ),
    });

    // 3. Create the GitHub repository once
    const { repoUrl, ownerLogin, repoName } =
      await this.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: dto.repoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

    const repoFullName = `${ownerLogin}/${repoName}`;
    const backendWorkflowPath =
      backendWorkflowFiles[0]?.path ??
      `.github/workflows/${backendOutputFileName}`;
    const frontendWorkflowPath =
      frontendWorkflowFiles[0]?.path ??
      `.github/workflows/${frontendOutputFileName}`;
    const additionalWorkflowPaths: string[] = [];

    let backendRow: ProvisionedProjectRow | undefined;
    let provisioningComplete = false;
    try {
      // 4. Push starter files to main so all subsequent branches inherit them
      await this.pushStarterFiles(provisioningToken, ownerLogin, repoName, {
        projectName: dto.repoName,
        stack: backend.projectTypeId,
        repoShape: 'microservices',
        ...(dto.tests?.['docker'] !== undefined && {
          includeDocker: dto.tests['docker'],
        }),
        backendServiceName: backend.serviceName,
        frontendStack: frontend.projectTypeId,
        frontendServiceName: frontend.serviceName,
      });

      // 5. Persist the backend row, issue the CI token, and install the shared
      // repo Actions secrets BEFORE pushing any workflow YAML — both pipeline
      // chains authenticate with the same repo-level ALPHACI_TOKEN, and the
      // access-gate runs as soon as a workflow file is pushed.
      backendRow = await this.createProjectRow({
        userId,
        workspaceId: await this.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        ),
        repoFullName,
        templateId: backendTemplateId,
        serviceName: backend.serviceName,
        workflowPath: backendWorkflowPath,
        status: 'provisioned',
        repoUrl,
        visibility: dto.visibility,
        repoShape: normalizeRepoShape(dto.repoShape),
        projectTypeId: backend.projectTypeId,
        workflowRecipeId: backend.workflowRecipeId ?? null,
        projectOptions: {
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: this.workflowFileMetadata(backendWorkflowFiles),
        },
      });

      const ciToken = await this.ciService.issueProjectToken(backendRow.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        repoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.installSonarSecrets(provisioningToken, ownerLogin, repoName);

      // 6. Push backend workflow file to main, then record the commit.
      const { commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          repoName,
          backendWorkflowFiles,
        );
      await this.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // 7. Push frontend workflow file to main (wrapped: failure should not block backend)
      let frontendPushResult:
        | { commitSha: string; commitUrl: string | null }
        | undefined;
      try {
        frontendPushResult = await this.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          repoName,
          frontendWorkflowFiles,
        );
        additionalWorkflowPaths.push(
          ...frontendWorkflowFiles.map((file) => file.path),
        );
      } catch (err) {
        this.logger.warn(
          `Microservices project: frontend workflow push failed: ${String(err)}`,
        );
      }

      // 8. Create develop and uat from main. CI runs only on uat/main.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
          'main',
        );
      }

      // 9. Protect only the integration/test and production branches.
      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          repoName,
          branch,
        );
      }

      // Repo is now fully usable; failures past this point must not delete it.
      provisioningComplete = true;

      // 10. Save frontend DB row if the push succeeded
      if (frontendPushResult !== undefined) {
        try {
          await this.createProjectRow({
            userId,
            workspaceId: await this.resolveWorkspaceIdForCreate(
              userId,
              dto.workspaceId,
            ),
            repoFullName,
            templateId: frontendTemplateId,
            serviceName: frontend.serviceName,
            workflowPath: frontendWorkflowPath,
            status: 'provisioned',
            githubCommitSha: frontendPushResult.commitSha,
            githubCommitUrl: frontendPushResult.commitUrl,
            repoUrl,
            visibility: dto.visibility,
            repoShape: normalizeRepoShape(dto.repoShape),
            projectTypeId: frontend.projectTypeId,
            workflowRecipeId: frontend.workflowRecipeId ?? null,
            projectOptions: {
              ...this.repositoryOwnershipMetadata(dto, ownerLogin),
              workflowFiles: this.workflowFileMetadata(frontendWorkflowFiles),
            },
          });
        } catch (err) {
          this.logger.warn(
            `Microservices project: frontend DB row save failed: ${String(err)}`,
          );
        }
      }

      // Both slots live in this one repository, so a single provisioning pass
      // creates the backend + frontend hosting targets and installs their
      // centralized Render/Vercel Actions secrets.
      const deploymentProvisioning = await this.provisionDeploymentTargets({
        projectId: backendRow.id,
        userId,
        repoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: ['backend', 'frontend'],
      });

      await this.recordProductEvent({
        userId,
        projectId: backendRow.id,
        eventCode: 'project_created',
        title: 'Project created',
        body: `${repoFullName} is now tracked by ALPHACI.`,
        metadata: {
          repoFullName,
          repoShape: 'microservices',
          projectTypeId: backend.projectTypeId,
        },
      });

      return {
        id: backendRow.id,
        repoFullName,
        repoUrl,
        status: 'provisioned',
        workflowPath: backendWorkflowPath,
        workflowFiles: this.workflowFileMetadata(backendWorkflowFiles),
        githubCommitSha: backendCommitSha,
        githubCommitUrl: backendCommitUrl,
        projectTypeId: backend.projectTypeId,
        workflowRecipeId: backend.workflowRecipeId ?? '',
        additionalWorkflowPaths,
        deploymentProvisioning,
      };
    } catch (error) {
      if (!provisioningComplete) {
        await this.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          repoName,
          backendRow?.id,
          userId,
        );
      }
      throw error;
    }
  }

  // ─── POST /projects/setup ──────────────────────────────────────────────────

  async setupProject(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: SetupProjectDto,
  ): Promise<SetupProjectResponse> {
    // 1. Build workflow YAML from the given templateId
    const { workflowFiles, outputFileName } = await this.buildWorkflowBundle({
      templateId: dto.templateId,
      serviceName: dto.serviceName,
      servicePath: dto.servicePath,
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      customOutputFileName: dto.outputFileName,
      enhancements: dto.enhancements,
      deploymentProvider: this.extractDeploymentProvider(
        dto.deploymentProvisioning,
        'backend',
      ),
      deploymentTargets: this.resolveDeploymentWorkflowTargets(
        dto.deploymentProvisioning,
        ['standalone', 'backend', 'frontend'],
        dto.servicePath,
      ),
    });

    // 2. Derive owner and repo from repoFullName (format: "owner/repo")
    const [owner, repo] = this.parseRepoFullName(dto.repoFullName);

    // Product decision: going forward, Setup-flow attachments are restricted
    // to the enforced org, same as brand-new repository creation. Already
    // attached external repos in the DB are untouched — this only blocks new
    // attachments. Enforced defense-in-depth: the FE repo picker is filtered
    // too, but the FE is not a trust boundary. Mirrors the `if (enforcedOrg)`
    // guard in resolveRepositoryProvisioning — an unconfigured/empty enforced
    // org means no restriction is active.
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (enforcedOrg && owner.toLowerCase() !== enforcedOrg.toLowerCase()) {
      throw new UnprocessableEntityException(
        `repoFullName must belong to the ${enforcedOrg} organization. '${owner}' is not allowed for new Setup-flow attachments.`,
      );
    }

    const accessToken = await this.resolveSetupProvisioningToken(
      userId,
      oauthAccessToken,
      dto.repoFullName,
    );

    // 3. Persist the project, issue the CI token, and install the Actions
    // secrets BEFORE pushing the workflow file so the access-gate's first run
    // on the existing repo can authenticate. Secrets are installed strictly so
    // a token without `secrets:write` aborts setup with a clear error.
    const workflowPath =
      workflowFiles[0]?.path ?? `.github/workflows/${outputFileName}`;

    const row = await this.createProjectRow({
      userId,
      workspaceId: await this.resolveWorkspaceIdForCreate(
        userId,
        dto.workspaceId,
      ),
      repoFullName: dto.repoFullName,
      templateId: dto.templateId,
      serviceName: dto.serviceName,
      workflowPath,
      status: 'provisioned',
      projectOptions: {
        workflowFiles: this.workflowFileMetadata(workflowFiles),
      },
    });

    let commitSha = '';
    let commitUrl: string | null = null;
    try {
      const ciToken = await this.ciService.issueProjectToken(row.id);
      await this.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_TOKEN',
        ciToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        accessToken,
        owner,
        repo,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.installSonarSecrets(accessToken, owner, repo);

      // 4. Push workflow file to the existing repo's default branch (main) now
      // that the secrets exist, then record the commit.
      ({ commitSha, commitUrl } = await this.pushWorkflowFiles(
        accessToken,
        owner,
        repo,
        workflowFiles,
      ));
      await this.projectsRepository.updateStatus(
        row.id,
        'provisioned',
        commitSha,
        commitUrl,
      );
    } catch (error) {
      // The repo is the user's own existing repo — never delete it; just remove
      // the half-created tracking row so a retry starts clean.
      try {
        await this.projectsRepository.deleteByIdAndUser(row.id, userId);
      } catch (cleanupError) {
        this.logger.warn(
          `setupProject: failed to delete project row ${row.id}: ${String(cleanupError)}`,
        );
      }
      throw error;
    }

    const deploymentProvisioning = await this.provisionDeploymentTargets({
      projectId: row.id,
      userId,
      repoFullName: dto.repoFullName,
      githubAccessToken: accessToken,
      request: dto.deploymentProvisioning,
      slots: this.resolveSingleRepoDeploymentSlots(dto.deploymentProvisioning),
    });

    await this.recordProductEvent({
      userId,
      projectId: row.id,
      eventCode: 'project_created',
      title: 'Project created',
      body: `${dto.repoFullName} is now tracked by ALPHACI.`,
      metadata: {
        repoFullName: dto.repoFullName,
        repoShape: 'existing',
        templateId: dto.templateId,
      },
    });

    return {
      id: row.id,
      repoFullName: dto.repoFullName,
      status: 'provisioned',
      workflowPath,
      workflowFiles: this.workflowFileMetadata(workflowFiles),
      githubCommitSha: commitSha,
      githubCommitUrl: commitUrl,
      deploymentProvisioning,
    };
  }

  // ─── GET /projects ─────────────────────────────────────────────────────────

  async listProjects(
    userId: string,
    limit = 25,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectsResponse> {
    const rows = await this.projectsRepository.listByUser(
      userId,
      limit,
      workspaceId,
    );
    return {
      items: rows.map((row) => this.toProvisionedProject(row)),
    };
  }

  async getProjectOverview(
    projectId: string,
    userId: string,
  ): Promise<ProjectOverviewResponse> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    const [
      ciToken,
      deploymentTargets,
      envMetadata,
      workflowHistory,
      latestSnapshot,
      hierarchyRepositoryId,
    ] = await Promise.all([
      this.loadCiTokenStatus(projectId),
      this.deploymentTargetsRepository?.listDeploymentTargets(projectId) ??
        Promise.resolve([]),
      this.envVarsRepository?.listEnvMetadata(projectId) ?? Promise.resolve([]),
      this.workflowHistoryRepository?.listForProjectIdentity({
        userId,
        serviceName: row.service_name,
        templateId: row.template_id,
        limit: 5,
      }) ?? Promise.resolve([]),
      this.dashboardSnapshotsRepository?.findLatestByProject(projectId) ??
        Promise.resolve(null),
      this.hierarchyProjectLinkService?.getLinkedRepositoryId(projectId) ??
        Promise.resolve(null),
    ]);

    const project = this.toProvisionedProject(row);
    const workflowFiles = project.workflowFiles ?? [];
    const matchingHistory = workflowHistory;
    const ciAuth = this.toCiAuthOverview(ciToken);
    const failedEnvCount = envMetadata.filter(
      (metadata) => metadata.status === 'failed',
    ).length;

    return {
      project: {
        ...project,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      workflow: {
        path: row.workflow_path,
        files: workflowFiles,
        stageCount: workflowFiles.length,
        history: matchingHistory,
      },
      deploymentTargets: {
        items: deploymentTargets,
        count: deploymentTargets.length,
      },
      environment: {
        items: envMetadata,
        count: envMetadata.length,
        failedCount: failedEnvCount,
      },
      ciAuth,
      health: this.buildOverviewHealth({
        project,
        workflowFiles,
        ciAuth,
        deploymentTargets,
        envMetadata,
      }),
      syncSnapshot: {
        enabled: this.projectSyncSnapshotsEnabled(),
        mode: 'local_snapshot',
        latest: latestSnapshot,
      },
      capabilities: {
        envProvisioning: true,
        workflowSettings: this.workflowSettingsPreviewEnabled(),
        syncSnapshots: this.projectSyncSnapshotsEnabled(),
        ciRunTracking: this.ciRunTrackingEnabled(),
        deploymentHistory: this.deploymentHistoryEnabled(),
        driftDetection: this.driftDetectionEnabled(),
      },
      hierarchyRepositoryId,
    };
  }

  // ─── DELETE /projects/:id ──────────────────────────────────────────────────

  /**
   * Removes a provisioned_projects record from ALPHACI's database.
   * The GitHub repository, its workflow YAML files, and its GitHub Secrets
   * are NOT touched — this is an ALPHACI tracking disconnect only.
   * CASCADE deletes ci.project_ci_tokens automatically via the FK.
   */
  async syncProjectSnapshot(
    projectId: string,
    userId: string,
  ): Promise<ProjectSyncSnapshotResponse> {
    if (!this.projectSyncSnapshotsEnabled()) {
      throw new BadRequestException('Project sync snapshots are disabled');
    }

    if (!this.dashboardSnapshotsRepository) {
      throw new ServiceUnavailableException(
        'Project dashboard snapshots are not configured',
      );
    }

    const startedAt = new Date().toISOString();
    const overview = await this.getProjectOverview(projectId, userId);
    const findings = this.buildLocalSnapshotFindings(overview);
    const completedAt = new Date().toISOString();
    const snapshot = await this.dashboardSnapshotsRepository.createSnapshot({
      projectId,
      status: overview.health.summary,
      summary: {
        mode: 'local_snapshot',
        projectId,
        healthSummary: overview.health.summary,
        workflowStageCount: overview.workflow.stageCount,
        deploymentTargetCount: overview.deploymentTargets.count,
        envVarCount: overview.environment.count,
        failedEnvVarCount: overview.environment.failedCount,
        ciTokenStatus: overview.ciAuth.status,
      },
      findings,
      startedAt,
      completedAt,
      createdBy: userId,
    });

    await this.recordProductEvent({
      userId,
      projectId,
      eventCode: 'project_snapshot_synced',
      title: 'Project snapshot synced',
      body: `Project snapshot completed with ${findings.length} finding${findings.length === 1 ? '' : 's'}.`,
      metadata: {
        snapshotId: snapshot.id,
        status: snapshot.status,
        findingCount: findings.length,
      },
    });

    return {
      snapshot,
      overview: {
        ...overview,
        syncSnapshot: {
          enabled: true,
          mode: 'local_snapshot',
          latest: snapshot,
        },
      },
    };
  }

  async listProjectAuditEvents(
    projectId: string,
    userId: string,
  ): Promise<ProjectAuditEventsResponse> {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return (
      (await this.auditEventsService?.listProjectEvents(projectId, userId)) ?? {
        enabled: this.auditEventsEnabled(),
        items: [],
      }
    );
  }

  async getWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<WorkflowSettingsResponse> {
    if (!this.workflowSettingsPreviewEnabled()) {
      throw new BadRequestException('Workflow settings preview is disabled');
    }

    const { row } = await this.loadOwnedProjectForWorkflowSettings(
      projectId,
      userId,
    );
    const storedSettings =
      await this.workflowSettingsRepository?.findByProject(projectId);

    if (storedSettings) {
      return {
        enabled: true,
        source: 'stored',
        settings: this.normalizeWorkflowSettings(row, storedSettings),
      };
    }

    return {
      enabled: true,
      source: 'project_options',
      settings: this.normalizeWorkflowSettings(row, null),
    };
  }

  async previewWorkflowSettings(
    projectId: string,
    userId: string,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowSettingsPreviewResponse> {
    if (!this.workflowSettingsPreviewEnabled()) {
      throw new BadRequestException('Workflow settings preview is disabled');
    }

    const { row, project } = await this.loadOwnedProjectForWorkflowSettings(
      projectId,
      userId,
    );
    const storedSettings =
      await this.workflowSettingsRepository?.findByProject(projectId);
    const settings = this.mergeWorkflowSettings(
      this.normalizeWorkflowSettings(row, storedSettings ?? null),
      request,
    );
    const validationWarnings = this.validateWorkflowSettingsPreview(
      settings,
      request,
    );

    if (validationWarnings.length > 0) {
      return {
        settings,
        workflowFiles: [],
        diffSummary: [],
        validationWarnings,
      };
    }

    const { workflowFiles } = await this.buildWorkflowBundle({
      templateId: settings.templateId,
      serviceName: settings.serviceName,
      servicePath: settings.servicePath,
      nodeVersion: settings.nodeVersion,
      coverageThreshold: settings.coverageThreshold,
      centralWorkflowRef: settings.centralWorkflowRef,
    });

    return {
      settings,
      workflowFiles,
      diffSummary: this.buildWorkflowPreviewDiff(
        project.workflowFiles ?? [],
        workflowFiles,
      ),
      validationWarnings: [],
    };
  }

  async createWorkflowUpdatePullRequest(
    projectId: string,
    userId: string,
    oauthAccessToken: string | null | undefined,
    request: WorkflowSettingsPreviewRequest,
  ): Promise<WorkflowUpdatePullRequestResponse> {
    if (!this.workflowUpdatePrEnabled()) {
      throw new BadRequestException(
        'Workflow update pull requests are disabled',
      );
    }
    await this.assertWithinQuota(userId, 'workflow_prs', 1, projectId);

    const { row, project } = await this.loadOwnedProjectForWorkflowSettings(
      projectId,
      userId,
    );
    const token = await this.resolveProvisioningToken(userId, oauthAccessToken);
    const [owner, repo] = this.parseRepoFullName(row.repo_full_name);
    const preview = await this.previewWorkflowSettings(
      projectId,
      userId,
      request,
    );

    if (preview.validationWarnings.length > 0) {
      throw new BadRequestException(
        preview.validationWarnings.map((warning) => warning.message).join(' '),
      );
    }

    const repoInfo = await this.githubService.getRepo(token, owner, repo);
    const baseBranch = repoInfo.defaultBranch || 'main';
    const branchName = `alphaci/workflow-update-${this.timestampForBranch()}`;
    await this.githubService.createBranch(
      token,
      owner,
      repo,
      branchName,
      baseBranch,
    );

    for (const file of preview.workflowFiles) {
      await this.githubService.putFileContent(
        token,
        owner,
        repo,
        file.path,
        file.yaml,
        branchName,
        'ci: update ALPHACI workflow configuration',
      );
    }

    let pullRequest: { number: number; htmlUrl: string };
    try {
      pullRequest = await this.githubService.createPullRequest(
        token,
        owner,
        repo,
        {
          title: 'Update ALPHACI workflow configuration',
          head: branchName,
          base: baseBranch,
          body: this.buildWorkflowUpdatePullRequestBody(preview),
        },
      );
    } catch (error) {
      throw new BadRequestException(
        'GitHub could not create the workflow update pull request. Check repository permissions and whether an update PR already exists.',
        { cause: error },
      );
    }

    const workflowFiles = preview.workflowFiles.map((file) => ({
      stage: file.stage,
      name: file.name,
      path: file.path,
      gated: file.gated,
    }));
    const persistedRequest =
      (await this.workflowUpdateRequestsRepository?.createRequest({
        projectId,
        requestedBy: userId,
        branchName,
        baseBranch,
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.htmlUrl,
        status: 'created',
        settings: preview.settings as unknown as Record<string, unknown>,
        workflowFiles,
      })) ?? null;

    await this.auditEventsService?.recordProjectEvent({
      actorUserId: userId,
      projectId,
      eventCode: 'workflow_pr_created',
      message: 'Workflow update PR created',
      metadata: {
        pullRequestNumber: pullRequest.number,
        pullRequestUrl: pullRequest.htmlUrl,
        branchName,
        baseBranch,
      },
    });

    await this.notificationEventsService?.record({
      userId,
      projectId,
      eventCode: 'workflow_pr_created',
      title: 'Workflow update PR created',
      body: `Workflow update PR #${pullRequest.number} was created for ${project.repoFullName}.`,
    });

    return {
      projectId,
      repoFullName: project.repoFullName,
      branchName,
      workflowPath: preview.workflowFiles[0]?.path ?? row.workflow_path,
      workflowFiles,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
      status: 'created',
      request: persistedRequest,
    };
  }

  /**
   * DELETE /api/v1/projects/:id.
   *
   * Default (options.deleteGithubRepo not true): unchanged plain DB-only
   * disconnect at the existing permissive role set (owner/admin/developer,
   * enforced by deleteByIdAndUser's SQL) — the GitHub repository is never
   * touched.
   *
   * Opt-in (options.deleteGithubRepo === true): tightens the required role
   * to owner/admin only, re-validates options.confirmRepoName server-side
   * against the project's actual repo_full_name (never trusting the client
   * alone), and attempts to delete the GitHub repository. A GitHub failure
   * (including a missing delete_repo OAuth scope) is reported back in
   * githubRepoDeleteError but never blocks the local ALPHACI disconnect —
   * the project row is still removed either way.
   */
  async disconnectProject(
    projectId: string,
    userId: string,
    options?: DisconnectProjectDto,
    githubAccessToken?: string | null,
  ): Promise<DisconnectProjectResponse> {
    const deleteGithubRepo = options?.deleteGithubRepo === true;
    // Single source of truth for the tightened role set, used both as the
    // app-layer fast-fail pre-check below AND passed down into the
    // repository so the SQL itself enforces it (see findByIdAndUser /
    // deleteByIdAndUser). The app-layer check alone is not sufficient: it
    // depends on workspaceAccessService being wired in (it's `@Optional()`
    // and no-ops via `?.` when absent), so it must not be the only gate for
    // a destructive, external-side-effecting action.
    const destructiveRoles: WorkspaceRole[] = ['admin', 'delegated_lead'];

    try {
      await this.assertProjectMutationAccess(
        projectId,
        userId,
        deleteGithubRepo ? destructiveRoles : undefined,
      );
    } catch (error) {
      if (deleteGithubRepo) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: 'Insufficient workspace role for deleteGithubRepo=true (owner/admin required).',
          metadata: { reason: 'insufficient_role' },
        });
      }
      throw error;
    }

    let githubRepoDeleted = false;
    let githubRepoDeleteError:
      | { code: GithubRepoDeleteErrorCode; message: string }
      | undefined;

    if (deleteGithubRepo) {
      // Role-scoped fetch: this is the SQL-level enforcement point. If the
      // caller's workspace role isn't owner/admin, no row comes back — this
      // fails closed independent of whether the app-layer check above ran.
      const project = await this.projectsRepository.findByIdAndUser(
        projectId,
        userId,
        destructiveRoles,
      );
      if (!project) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `Project '${projectId}' was not found, does not belong to the current user, or the current workspace role does not permit deleting its GitHub repository (owner/admin required).`,
          metadata: { reason: 'not_found_or_insufficient_role' },
        });
        throw new NotFoundException(
          `Project '${projectId}' not found or does not belong to the current user.`,
        );
      }

      const repoFullName = project.repo_full_name;
      // CRITICAL: re-validate the typed confirmation server-side against the
      // project's actual repo_full_name. Never trust client-side gating —
      // a modified or replayed request without this check would let a
      // caller delete the GitHub repo without ever having typed the
      // confirmation the UI showed them.
      if (options?.confirmRepoName !== repoFullName) {
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_rejected',
          title: 'GitHub repository deletion rejected',
          body: `confirmRepoName did not match this project's repository name (${repoFullName}). The GitHub repository was not deleted.`,
          metadata: { reason: 'confirmation_mismatch', repoFullName },
        });
        throw new BadRequestException(
          "confirmRepoName does not match this project's repository name. The GitHub repository was not deleted.",
        );
      }

      if (!githubAccessToken) {
        githubRepoDeleteError = {
          code: 'missing_scope',
          message:
            'No GitHub access token on this session — reconnect your GitHub account to grant repository-deletion permission.',
        };
        await this.recordProductEvent({
          userId,
          projectId,
          eventCode: 'project_github_repo_delete_missing_scope',
          title: 'GitHub repository deletion needs reconnect',
          body: `Could not delete ${repoFullName} on GitHub: no GitHub access token on this session.`,
          metadata: { repoFullName, code: 'missing_scope' },
        });
      } else {
        const [owner, repo] = repoFullName.split('/');
        if (!owner || !repo) {
          githubRepoDeleteError = {
            code: 'other',
            message: `Could not derive an owner/repo from '${repoFullName}'.`,
          };
          await this.recordProductEvent({
            userId,
            projectId,
            eventCode: 'project_github_repo_delete_failed',
            title: 'GitHub repository deletion failed',
            body: `Could not derive an owner/repo from '${repoFullName}'.`,
            metadata: { repoFullName, code: 'other' },
          });
        } else {
          try {
            await this.githubService.deleteRepoForUser(
              githubAccessToken,
              owner,
              repo,
            );
            githubRepoDeleted = true;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode: 'project_github_repo_deleted',
              title: 'GitHub repository deleted',
              body: `${repoFullName} was deleted from GitHub.`,
              metadata: { repoFullName },
            });
          } catch (error) {
            const deleteError =
              error instanceof GithubRepoDeleteError
                ? { code: error.code, message: error.message }
                : { code: 'other' as const, message: (error as Error).message };
            githubRepoDeleteError = deleteError;
            await this.recordProductEvent({
              userId,
              projectId,
              eventCode:
                deleteError.code === 'missing_scope'
                  ? 'project_github_repo_delete_missing_scope'
                  : 'project_github_repo_delete_failed',
              title: 'GitHub repository deletion failed',
              body: `Could not delete ${repoFullName} on GitHub: ${deleteError.message}`,
              metadata: { repoFullName, code: deleteError.code },
            });
          }
        }
      }
    }

    const deleted = await this.projectsRepository.deleteByIdAndUser(
      projectId,
      userId,
      deleteGithubRepo ? destructiveRoles : undefined,
    );
    if (!deleted) {
      throw new NotFoundException(
        `Project '${projectId}' not found or does not belong to the current user.`,
      );
    }

    return {
      ok: true,
      githubRepoDeleted,
      ...(githubRepoDeleteError ? { githubRepoDeleteError } : {}),
    };
  }

  // ─── POST /projects/sync ───────────────────────────────────────────────────

  /**
   * Checks each provisioned project against the GitHub API to see if its
   * repository still exists. Projects whose repos have been deleted are marked
   * 'orphaned'; orphaned projects whose repos reappear are restored to
   * 'provisioned'. Requires a valid GitHub access token in session.
   */
  async syncProjects(
    userId: string,
    accessToken: string,
  ): Promise<SyncProjectsResponse> {
    const rows = await this.projectsRepository.listByUser(userId, 100);
    if (rows.length === 0) {
      await this.recordProductEvent({
        userId,
        projectId: null,
        eventCode: 'project_sync_completed',
        title: 'Project sync completed',
        body: 'Project repository sync found no tracked projects.',
        metadata: { orphaned: 0, reachable: 0, total: 0 },
      });
      return { orphaned: 0, reachable: 0, total: 0 };
    }

    const orphanedIds: string[] = [];
    const reachableIds: string[] = [];

    // Check repos concurrently — cap at 10 parallel requests to avoid GitHub
    // secondary rate-limit triggers on large project lists.
    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (exists) {
              reachableIds.push(row.id);
            } else {
              orphanedIds.push(row.id);
            }
          } catch (err) {
            // repoExists throws on anything inconclusive — 401/403 (bad or
            // revoked token, rate limit) as well as 5xx/network errors. None
            // of those confirm the repo is gone, so skip rather than mark
            // orphaned; a batch full of these usually means the shared
            // session token is bad, not that every repo vanished at once.
            this.logger.warn(
              `Sync: GitHub check failed for ${row.repo_full_name}: ${String(err)}`,
            );
          }
        }),
      );
    }

    const [orphanedCount, reachableCount] = await Promise.all([
      this.projectsRepository.markOrphaned(orphanedIds, userId),
      this.projectsRepository.markReachable(reachableIds, userId),
    ]);

    await this.recordProductEvent({
      userId,
      projectId: null,
      eventCode: 'project_sync_completed',
      title: 'Project sync completed',
      body: `Project repository sync checked ${rows.length} tracked project${rows.length === 1 ? '' : 's'}.`,
      metadata: {
        orphaned: orphanedCount,
        reachable: reachableCount,
        total: rows.length,
      },
    });

    return {
      orphaned: orphanedCount,
      reachable: reachableCount,
      total: rows.length,
    };
  }

  // ─── Scheduled reconciliation (src/scripts/reconcile-deleted-repos.ts) ────

  /**
   * System-wide sweep that hard-deletes provisioned projects whose GitHub
   * repository is confirmed gone — catches the backlog of repos that were
   * deleted on GitHub before the repository.deleted webhook path
   * (handleRepositoryDeleted) existed. Driven by an external cron script,
   * NOT the live webhook.
   *
   * Uses a single org-level installation token (via
   * getOrganizationProvisioningContextByLogin(getEnforcedOrg())), not any
   * individual user's session token, since this runs unattended with no
   * signed-in user.
   *
   * SECOND non-negotiable safety rule, beyond the inconclusive-check one
   * below: this org-scoped installation token can only reliably vouch for
   * repos that actually belong to the enforced org. The "import an existing
   * repo" flow (ExistingReposService) lets a project point at ANY repo the
   * connecting user owns — personal account or a different org entirely —
   * so provisioned_projects can legitimately contain rows outside the
   * enforced org. GitHub's API returns a 404 both for "deleted" AND for "the
   * calling token has no access to this repo", and an org installation token
   * has no access to a repo it doesn't own — those two cases are
   * indistinguishable from repoExists()'s return value alone. Checking such
   * a row with the org token would therefore read as a false "confirmed
   * gone" and wrongly delete a project whose repo is perfectly fine. Rows
   * whose repo_full_name owner doesn't match the enforced org are skipped
   * entirely (outOfScope), never passed to repoExists().
   *
   * Same concurrency-capped batching as syncProjects() (CONCURRENCY = 10)
   * to avoid GitHub secondary rate limits, and the SAME non-negotiable
   * safety rule for the repos this job CAN check: repoExists() throws on
   * anything inconclusive (401/403/5xx/network errors) — those rows are
   * skipped, NEVER treated as "confirmed gone". Only a clean `false`
   * (confirmed 404 from a repo we know the token can see) qualifies a row
   * for deletion. A bad/expired org token or a transient GitHub outage must
   * never mass-delete every tracked project.
   */
  async reconcileDeletedRepos(): Promise<ReconcileDeletedReposResult> {
    const enforcedOrg = this.githubService.getEnforcedOrg();
    const { accessToken } =
      await this.githubService.getOrganizationProvisioningContextByLogin(
        enforcedOrg,
      );

    const allRows = await this.projectsRepository.listAllRepoFullNames();
    if (allRows.length === 0) {
      return { total: 0, checked: 0, deleted: 0, skipped: 0, outOfScope: 0 };
    }

    const normalizedOrg = enforcedOrg.toLowerCase();
    const rows = allRows.filter(
      (row) =>
        row.repo_full_name.split('/')[0]?.toLowerCase() === normalizedOrg,
    );
    const outOfScope = allRows.length - rows.length;
    if (outOfScope > 0) {
      this.logger.warn(
        `Reconcile: skipping ${String(outOfScope)} project(s) whose repo is outside the ${enforcedOrg} org — the org installation token cannot reliably verify them (see method doc).`,
      );
    }

    const confirmedGoneRepoFullNames: string[] = [];
    let skipped = 0;

    const CONCURRENCY = 10;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
      const batch = rows.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (row) => {
          try {
            const exists = await this.githubService.repoExists(
              accessToken,
              row.repo_full_name,
            );
            if (!exists) {
              confirmedGoneRepoFullNames.push(row.repo_full_name);
            }
          } catch (err) {
            // See method doc: inconclusive checks are skipped, never
            // treated as confirmation the repo is gone.
            skipped += 1;
            this.logger.warn(
              `Reconcile: GitHub check failed for ${row.repo_full_name}: ${String(err)}`,
            );
          }
        }),
      );
    }

    const deletedByOwner = new Map<
      string,
      Array<{ id: string; user_id: string }>
    >();
    for (const repoFullName of confirmedGoneRepoFullNames) {
      const deletedRows =
        await this.projectsRepository.deleteByRepoFullName(repoFullName);
      if (deletedRows.length > 0) {
        deletedByOwner.set(repoFullName, deletedRows);
      }
    }

    const totalDeleted = [...deletedByOwner.values()].reduce(
      (sum, rowsForRepo) => sum + rowsForRepo.length,
      0,
    );

    this.logger.log(
      `Reconcile: checked ${rows.length} project(s) (${String(outOfScope)} out of scope), deleted ${totalDeleted}, skipped ${skipped} (inconclusive)`,
    );

    await Promise.all(
      [...deletedByOwner.entries()].flatMap(([repoFullName, deletedRows]) =>
        deletedRows.map((row) =>
          // projectId is `null`, not `row.id` — same FK reasoning as
          // handleRepositoryDeleted: the row is already gone by the time
          // this runs, and audit/notification project_id references would
          // fail their FK constraint. `source: 'reconciliation'` (vs.
          // 'webhook') keeps the two deletion paths distinguishable in
          // audit history.
          this.recordProductEvent({
            userId: row.user_id,
            projectId: null,
            eventCode: 'project_deleted_reconciliation',
            title: 'Repository deleted on GitHub',
            body: `The GitHub repository ${repoFullName} was found deleted during scheduled reconciliation, so this project has been deleted.`,
            metadata: {
              repoFullName,
              source: 'reconciliation',
              deletedProjectId: row.id,
            },
          }),
        ),
      ),
    );

    return {
      total: allRows.length,
      checked: rows.length,
      deleted: totalDeleted,
      skipped,
      outOfScope,
    };
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Resolve the catalog templateId from projectTypeId + optional workflowRecipeId.
   * Uses the recipe's templateByProjectType mapping. Falls back to
   * "{projectTypeId}-standard" when no recipe is supplied.
   */
  private async resolveProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
  ): Promise<string> {
    // Repository creation for personal accounts requires a user OAuth token.
    // GitHub App installation tokens cannot call POST /user/repos, so only use
    // one as a fallback when the session has no OAuth token.
    if (oauthAccessToken) {
      return oauthAccessToken;
    }

    const installationToken =
      await this.githubService.getInstallationAccessTokenForUser(userId);

    if (installationToken) {
      return installationToken;
    }

    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
    );
  }

  private async resolveSetupProvisioningToken(
    userId: string,
    oauthAccessToken: string | null | undefined,
    repoFullName: string,
  ): Promise<string> {
    const installationToken =
      await this.githubService.getInstallationAccessTokenForUserRepo(
        userId,
        repoFullName,
      );

    if (installationToken) {
      return installationToken;
    }

    if (oauthAccessToken) {
      return oauthAccessToken;
    }

    throw new UnauthorizedException(
      'No usable GitHub token found. Link the GitHub App installation or re-authenticate via GitHub OAuth.',
    );
  }

  private async resolveRepositoryProvisioning(
    userId: string,
    oauthAccessToken: string | null | undefined,
    dto: CreateProjectDto,
  ): Promise<{
    repositoryCreationToken: string;
    provisioningToken: string;
    provisioningOwnerLogin: string | undefined;
  }> {
    // When the deployment enforces a destination org, every repository is
    // created there regardless of the request's ownerType/installationId. The
    // org repo is created with the user's OAuth token (GitHub forbids a
    // server-to-server installation token from creating org repos), while the
    // enforced org's installation token drives downstream provisioning.
    const enforcedOrg = this.githubService.getEnforcedOrg();
    if (enforcedOrg) {
      if (!oauthAccessToken) {
        throw new UnauthorizedException(
          `A GitHub OAuth token with the repo scope is required to create a repository in the ${enforcedOrg} organization. Sign out and sign back in with GitHub.`,
        );
      }

      const context =
        await this.githubService.getOrganizationProvisioningContextByLogin(
          enforcedOrg,
        );

      return {
        repositoryCreationToken: oauthAccessToken,
        provisioningToken: context.accessToken,
        provisioningOwnerLogin: context.ownerLogin,
      };
    }

    const ownerType = dto.ownerType ?? 'personal';

    if (ownerType === 'organization') {
      if (!dto.installationId) {
        throw new UnprocessableEntityException(
          'installationId is required when creating a repository in an organization.',
        );
      }
      if (!oauthAccessToken) {
        throw new UnauthorizedException(
          'A GitHub OAuth token with the repo scope is required to create a repository in an organization. Sign out and sign back in with GitHub.',
        );
      }

      const context =
        await this.githubService.getOrganizationProvisioningContext(
          userId,
          dto.installationId,
        );
      // GitHub does not allow a server-to-server installation token to create
      // an organization repository. Use the signed-in user's OAuth token for
      // POST /orgs/{org}/repos, then use the selected installation token for
      // repository contents, branches, secrets, and protection settings.
      return {
        repositoryCreationToken: oauthAccessToken,
        provisioningToken: context.accessToken,
        provisioningOwnerLogin: context.ownerLogin,
      };
    }

    if (dto.installationId) {
      throw new UnprocessableEntityException(
        'installationId can only be used with an organization repository owner.',
      );
    }
    if (!oauthAccessToken) {
      throw new UnauthorizedException(
        'A GitHub OAuth token is required to create a personal repository. Sign out and sign back in with GitHub.',
      );
    }

    return {
      repositoryCreationToken: oauthAccessToken,
      provisioningToken: oauthAccessToken,
      provisioningOwnerLogin: undefined,
    };
  }

  private repositoryOwnershipMetadata(
    dto: CreateProjectDto,
    ownerLogin: string,
  ): Record<string, unknown> {
    return {
      repositoryOwner: {
        type: dto.ownerType ?? 'personal',
        login: ownerLogin,
        installationId: dto.installationId ?? null,
      },
    };
  }

  private resolveTemplateId(
    projectTypeId: string,
    workflowRecipeId?: string,
  ): string {
    const { recipes } = this.catalogService.getProjectOptions();
    const recipeId = workflowRecipeId ?? 'standard';
    const recipe = recipes.find((r) => r.id === recipeId);

    if (recipe) {
      const mapped = recipe.templateByProjectType[projectTypeId];
      if (mapped) {
        return mapped;
      }
    }

    // Fallback: conventional naming that matches the YAML file names on disk
    return `${projectTypeId}-${recipeId}`;
  }

  private filterDeploymentProvisioningRequest(
    request: DeploymentProvisioningRequestDto | undefined,
    slots: DeploymentProvisioningTargetDto['slot'][],
  ): DeploymentProvisioningRequestDto | undefined {
    if (!request) {
      return undefined;
    }

    return {
      enabled: request.enabled,
      ...(request.variableGroups
        ? { variableGroups: request.variableGroups }
        : {}),
      ...(request.sharedEnv ? { sharedEnv: request.sharedEnv } : {}),
      targets: request.targets.filter((target) => slots.includes(target.slot)),
    };
  }

  private combineDeploymentProvisioningResults(
    results: DeploymentProvisioningResult[],
  ): DeploymentProvisioningResult {
    const targets = results.flatMap((result) => result.targets);
    if (targets.length === 0) {
      return { status: 'skipped', targets: [] };
    }

    const failedCount = targets.filter(
      (target) => target.status === 'failed',
    ).length;

    return {
      status:
        failedCount === 0
          ? 'completed'
          : failedCount === targets.length
            ? 'failed'
            : 'partial',
      targets,
    };
  }

  private skippedDeploymentProvisioning(): DeploymentProvisioningResult {
    return { status: 'skipped', targets: [] };
  }

  private withDefaultCreateDeploymentProvisioning(input: {
    request: DeploymentProvisioningRequestDto | undefined;
    projectTypeId: string;
    serviceName: string;
    repoName: string;
    servicePath?: string | undefined;
  }): DeploymentProvisioningRequestDto | undefined {
    if (!this.isBackendProjectType(input.projectTypeId)) {
      return input.request;
    }

    const existingTargets = input.request?.targets ?? [];
    const hasBackendRenderTarget = existingTargets.some(
      (target) =>
        ['backend', 'standalone'].includes(target.slot) &&
        target.provider === 'render',
    );
    if (hasBackendRenderTarget) {
      return {
        ...input.request,
        enabled: true,
        targets: existingTargets,
      };
    }

    return {
      enabled: true,
      ...(input.request?.variableGroups
        ? { variableGroups: input.request.variableGroups }
        : {}),
      ...(input.request?.sharedEnv
        ? { sharedEnv: input.request.sharedEnv }
        : {}),
      targets: [
        ...existingTargets,
        {
          slot: 'backend',
          provider: 'render',
          ownershipMode: 'flowci_managed',
          projectName: this.defaultManagedRenderProjectName(
            input.serviceName,
            input.repoName,
          ),
          branchName: 'uat',
          rootDirectory: input.servicePath?.trim() || '.',
          buildCommand: 'npm ci && npm run build',
          startCommand: 'npm run start:prod',
          renderDeployMethod: 'managed_image',
          renderServiceType: 'web_service',
          renderRuntime: 'docker',
          renderInstanceType: 'free',
          renderRegion: 'singapore',
          dockerContext: input.servicePath?.trim() || '.',
          dockerfilePath: 'Dockerfile',
          env: [],
        },
      ],
    };
  }

  private isBackendProjectType(projectTypeId: string): boolean {
    return !/(react|next|frontend|web|ui)/i.test(projectTypeId);
  }

  private defaultManagedRenderProjectName(
    serviceName: string,
    repoName: string,
  ): string {
    const base = (serviceName || repoName || 'backend')
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
    return `${base || 'backend'}-uat`;
  }

  /**
   * BYO hosting is archived: every deployment target is forced onto the
   * platform's centralized Render/Vercel credentials regardless of what the
   * client sent, and any BYO provider-connection reference is dropped.
   */
  private forceManagedProvisioning(
    request: DeploymentProvisioningRequestDto | undefined,
  ): DeploymentProvisioningRequestDto | undefined {
    if (!request) {
      return undefined;
    }

    return {
      ...request,
      targets: request.targets.map((target) => {
        const managedTarget = {
          ...target,
          ownershipMode: 'flowci_managed' as const,
        };
        delete managedTarget.providerConnectionId;
        return managedTarget;
      }),
    };
  }

  /**
   * Create the requested hosting targets and install their Render/Vercel
   * GitHub Actions secrets as part of project creation. Provisioning is
   * best-effort: the repo is already fully usable, so a hosting failure is
   * reported in the response instead of failing the whole creation.
   */
  private async provisionDeploymentTargets(input: {
    projectId: string;
    userId: string;
    repoFullName: string;
    githubAccessToken: string;
    request: DeploymentProvisioningRequestDto | undefined;
    slots: DeploymentProvisioningTargetDto['slot'][];
  }): Promise<DeploymentProvisioningResult> {
    const request = this.filterDeploymentProvisioningRequest(
      this.forceManagedProvisioning(input.request),
      input.slots,
    );
    if (!request?.enabled || request.targets.length === 0) {
      return this.skippedDeploymentProvisioning();
    }

    try {
      return await this.projectDeploymentProvisioningService.provisionForProject(
        {
          projectId: input.projectId,
          userId: input.userId,
          repoFullName: input.repoFullName,
          githubAccessToken: input.githubAccessToken,
          request,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Deployment provisioning failed for ${input.repoFullName}: ${String(error)}`,
      );
      return {
        status: 'failed',
        targets: request.targets.map((target) => ({
          slot: target.slot,
          provider: target.provider,
          ownershipMode: 'flowci_managed',
          deploymentStrategy: null,
          status: 'failed',
          deploymentTargetId: null,
          providerProjectId: null,
          providerProjectName: null,
          providerMetadata: {},
          errorSummary: 'Deployment provisioning failed',
          env: [],
        })),
      };
    }
  }

  /**
   * Install the centralized SonarCloud secrets the generated workflows expect
   * (the quality-scan job only runs when all three are present). Best-effort:
   * a missing central Sonar configuration or a secret-write hiccup must not
   * fail repository creation.
   */
  private async installSonarSecrets(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<void> {
    const managed =
      this.configService?.getOrThrow<AppConfig>('app')?.envProvisioning
        ?.flowciManaged;
    const sonarToken = managed?.sonarToken?.trim();
    const sonarOrganization = managed?.sonarOrganization?.trim();
    if (!sonarToken || !sonarOrganization) {
      this.logger.warn(
        `SonarCloud secrets not installed for ${owner}/${repo}: ALPHACI_SONAR_TOKEN / ALPHACI_SONAR_ORGANIZATION are not configured`,
      );
      return;
    }

    // SonarCloud's GitHub-import convention for project keys is `${owner}_${repo}`.
    const sonarProjectKey = this.sonarProjectKey(owner, repo);
    await this.ensureSonarCloudProject({
      sonarToken,
      sonarOrganization,
      sonarProjectKey,
      projectName: repo,
      repoFullName: `${owner}/${repo}`,
    });
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_TOKEN',
      sonarToken,
    );
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_ORGANIZATION',
      sonarOrganization,
    );
    await this.githubService.setActionsSecret(
      accessToken,
      owner,
      repo,
      'SONAR_PROJECT_KEY',
      sonarProjectKey,
    );
  }

  private sonarProjectKey(owner: string, repo: string): string {
    return `${owner}_${repo}`;
  }

  private async ensureSonarCloudProject(input: {
    sonarToken: string;
    sonarOrganization: string;
    sonarProjectKey: string;
    projectName: string;
    repoFullName: string;
  }): Promise<void> {
    try {
      const body = new URLSearchParams({
        organization: input.sonarOrganization,
        project: input.sonarProjectKey,
        name: input.projectName,
      });
      const response = await fetch(
        'https://sonarcloud.io/api/projects/create',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${input.sonarToken}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      if (response.ok) {
        this.logger.log(
          `SonarCloud project ensured for ${input.repoFullName} (${input.sonarProjectKey})`,
        );
        return;
      }

      const responseBody = await response.text();
      if (response.status === 400 && /already|exist|key/i.test(responseBody)) {
        this.logger.log(
          `SonarCloud project already exists for ${input.repoFullName} (${input.sonarProjectKey})`,
        );
        return;
      }

      this.logger.warn(
        `SonarCloud project was not created for ${input.repoFullName} (${String(response.status)}): ${responseBody.slice(0, 500)}`,
      );
    } catch (error) {
      this.logger.warn(
        `SonarCloud project was not created for ${input.repoFullName}: ${String(error)}`,
      );
    } finally {
      await this.ensureSonarCloudProjectLink(input);
    }
  }

  private async ensureSonarCloudProjectLink(input: {
    sonarToken: string;
    sonarProjectKey: string;
    repoFullName: string;
  }): Promise<void> {
    try {
      const body = new URLSearchParams({
        projectKey: input.sonarProjectKey,
        name: 'GitHub',
        url: `https://github.com/${input.repoFullName}`,
      });
      const response = await fetch(
        'https://sonarcloud.io/api/project_links/create',
        {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(
              `${input.sonarToken}:`,
            ).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
        },
      );

      if (response.ok) {
        return;
      }

      const responseBody = await response.text();
      if (
        response.status === 400 &&
        /already|exist|duplicate/i.test(responseBody)
      ) {
        return;
      }

      this.logger.warn(
        `SonarCloud GitHub link was not created for ${input.repoFullName} (${String(response.status)}): ${responseBody.slice(0, 500)}`,
      );
    } catch (error) {
      this.logger.warn(
        `SonarCloud GitHub link was not created for ${input.repoFullName}: ${String(error)}`,
      );
    }
  }

  /**
   * Load the template from the catalog, apply substitutions, and return the
   * generated YAML string plus the derived output file name.
   */
  private async buildWorkflowYaml(
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
  ): Promise<{ generatedYaml: string; outputFileName: string }> {
    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    const source = await readFile(template.workflowPath, 'utf8');

    // Use DEFAULT_SCHEMA (the js-yaml default) explicitly to document that no
    // unsafe tag constructors (!!js/function, !!js/regexp, etc.) are permitted.
    // This is equivalent to yaml.load() with no schema option, but makes the
    // intent clear and is resilient to any future js-yaml API drift.
    const parsed = yaml.load(source, { schema: yaml.DEFAULT_SCHEMA }) as Record<
      string,
      unknown
    > | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new UnprocessableEntityException(
        'Workflow template could not be parsed',
      );
    }

    parsed.name = `${serviceName} - ${template.name}`;

    const onConfig = this.ensureObject(parsed, 'on');
    const dispatchConfig = this.ensureObject(onConfig, 'workflow_dispatch');
    const inputConfig = this.ensureObject(dispatchConfig, 'inputs');

    this.setInputDefault(inputConfig, 'service_name', serviceName, 'string');

    if (servicePath !== undefined) {
      this.setInputDefault(inputConfig, 'service_path', servicePath, 'string');
    }

    if (nodeVersion !== undefined) {
      this.setInputDefault(inputConfig, 'node_version', nodeVersion, 'string');
    }

    if (coverageThreshold !== undefined) {
      this.setInputDefault(
        inputConfig,
        'coverage_threshold',
        coverageThreshold,
        'number',
      );
    }

    if (enhancements && enhancements.length > 0) {
      const pipelineConfig = this.ensureObject(
        this.ensureObject(parsed, 'jobs'),
        'pipeline',
      );
      const withConfig = this.ensureObject(pipelineConfig, 'with');
      this.applyEnhancements(withConfig, enhancements);
    }

    const generatedYaml = yaml.dump(parsed, {
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    const outputFileName =
      customOutputFileName ??
      this.deriveOutputFileName(serviceName, template.id);

    return { generatedYaml, outputFileName };
  }

  private extractDeploymentProvider(
    request: DeploymentProvisioningRequestDto | undefined,
    slot: DeploymentProvisioningTargetDto['slot'],
  ): DeploymentProvider | undefined {
    if (!request?.enabled || !request.targets?.length) return undefined;
    const provider = request.targets.find(
      (t) => t.slot === slot && t.provider === 'render' && slot === 'backend',
    )?.provider;
    return provider === 'render' ? provider : undefined;
  }

  private resolveDeploymentWorkflowTargets(
    request: DeploymentProvisioningRequestDto | undefined,
    slots: DeploymentProvisioningTargetDto['slot'][],
    fallbackRootDirectory?: string,
  ): DeploymentWorkflowTarget[] {
    if (!request?.enabled || !request.targets?.length) {
      return [];
    }

    return request.targets
      .filter((target) => slots.includes(target.slot))
      .filter(
        (target) =>
          (target.provider === 'vercel' && target.slot === 'frontend') ||
          (target.provider === 'render' &&
            target.slot === 'backend' &&
            (target.renderInstanceType?.trim() || 'free') === 'free' &&
            (target.renderServiceType ?? 'web_service') === 'web_service' &&
            this.resolveRenderDeploymentStrategy(target) ===
              'render_image_pushed'),
      )
      .flatMap((target) => {
        const rootDirectory = this.resolveWorkflowRootDirectory(
          target,
          fallbackRootDirectory,
        );
        if (target.provider === 'render') {
          return this.renderDeploymentBranches().map((branchName) => {
            const descriptor: DeploymentWorkflowTarget = {
              slot: target.slot,
              provider: 'render',
              branchName,
              deploymentStrategy: 'render_image_pushed',
              secretNames: this.renderSecretNames(target.slot, branchName),
              dockerContext:
                target.dockerContext?.trim() || rootDirectory || '.',
              dockerfilePath: target.dockerfilePath?.trim() || 'Dockerfile',
              imageName: this.renderImageName(target, branchName),
              renderServiceType: target.renderServiceType ?? 'web_service',
              renderInstanceType: target.renderInstanceType ?? 'free',
            };
            if (rootDirectory) {
              descriptor.rootDirectory = rootDirectory;
            }

            return descriptor;
          });
        }

        const descriptor: DeploymentWorkflowTarget = {
          slot: target.slot,
          provider: 'vercel',
          deploymentStrategy: 'vercel_ci_pushed',
          secretNames: this.vercelSecretNames(target.slot),
        };
        if (rootDirectory) {
          descriptor.rootDirectory = rootDirectory;
        }

        return descriptor;
      });
  }

  private renderDeploymentBranches(): Array<'uat' | 'main'> {
    return ['uat', 'main'];
  }

  private resolveRenderDeploymentStrategy(
    target: DeploymentProvisioningTargetDto,
  ):
    | 'render_image_pushed'
    | 'render_git_connected'
    | 'render_existing_service' {
    if (target.renderDeployMethod === 'existing_service') {
      return 'render_existing_service';
    }
    if (
      target.ownershipMode === 'flowci_managed' ||
      target.renderDeployMethod === 'byo_image'
    ) {
      return 'render_image_pushed';
    }

    return 'render_git_connected';
  }

  private resolveWorkflowRootDirectory(
    target: DeploymentProvisioningTargetDto,
    fallbackRootDirectory?: string,
  ): string | undefined {
    const rootDirectory = target.rootDirectory?.trim();
    if (rootDirectory) {
      return rootDirectory;
    }

    return fallbackRootDirectory?.trim() || undefined;
  }

  private vercelSecretNames(
    slot: DeploymentProvisioningTargetDto['slot'],
  ): NonNullable<DeploymentWorkflowTarget['secretNames']> {
    const prefix = `VERCEL_${slot.toUpperCase()}`;
    return {
      token: `${prefix}_TOKEN`,
      orgId: `${prefix}_ORG_ID`,
      projectId: `${prefix}_PROJECT_ID`,
    };
  }

  private renderSecretNames(
    slot: DeploymentProvisioningTargetDto['slot'],
    branchName: 'uat' | 'main' = 'uat',
  ): NonNullable<DeploymentWorkflowTarget['secretNames']> {
    const prefix = `RENDER_${slot.toUpperCase()}_${branchName.toUpperCase()}`;
    const branchSuffix = branchName.toUpperCase();
    return {
      apiKey: `${prefix}_API_KEY`,
      serviceId: `${prefix}_SERVICE_ID`,
      ownerId: `${prefix}_OWNER_ID`,
      registryCredentialId: `${prefix}_REGISTRY_CREDENTIAL_ID`,
      deployHookUrl: `RENDER_DEPLOY_HOOK_URL_${branchSuffix}`,
      healthcheckUrl: `RENDER_HEALTHCHECK_URL_${branchSuffix}`,
    };
  }

  private renderImageName(
    target: DeploymentProvisioningTargetDto,
    branchName: string = target.branchName ?? 'uat',
  ): string {
    const raw = `alphaci-${target.slot}-${branchName}-${target.projectName ?? target.slot}`;
    return raw
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');
  }

  private resolveSingleRepoDeploymentSlots(
    request: DeploymentProvisioningRequestDto | undefined,
  ): DeploymentProvisioningTargetDto['slot'][] {
    if (!request?.enabled || !request.targets?.length) {
      return ['standalone'];
    }

    const slots = request.targets
      .map((target) => target.slot)
      .filter((slot): slot is DeploymentProvisioningTargetDto['slot'] =>
        ['standalone', 'frontend', 'backend'].includes(slot),
      );

    return slots.length > 0 ? Array.from(new Set(slots)) : ['standalone'];
  }

  private async buildWorkflowBundle(options: {
    templateId: string;
    serviceName: string;
    servicePath?: string | undefined;
    nodeVersion?: string | undefined;
    coverageThreshold?: number | undefined;
    customOutputFileName?: string | undefined;
    enhancements?:
      | Array<
          | 'strictProductionApproval'
          | 'enableUatApproval'
          | 'disablePlaywright'
          | 'disableK6'
        >
      | undefined;
    deploymentProvider?: DeploymentProvider | undefined;
    deploymentTargets?: DeploymentWorkflowTarget[] | undefined;
    workflowVariant?: 'backend' | 'frontend' | undefined;
    centralWorkflowRef?: string | undefined;
    /**
     * True when the workflow targets a service path that carries the
     * scaffold's tests/ directory (product-created repos). Leave unset for
     * BYO/setup repos and monorepo roots (their tests live under packages/).
     */
    hasTestsDirectory?: boolean | undefined;
  }): Promise<{ workflowFiles: StagedWorkflowFile[]; outputFileName: string }> {
    const {
      templateId,
      serviceName,
      servicePath,
      nodeVersion,
      coverageThreshold,
      customOutputFileName,
      enhancements,
      deploymentProvider,
      deploymentTargets = [],
      workflowVariant,
      centralWorkflowRef,
      hasTestsDirectory,
    } = options;

    const template = await this.catalogService.getTemplateById(templateId);
    if (!template) {
      throw new NotFoundException(`Template '${templateId}' not found`);
    }

    const bundle = buildStagedWorkflowBundle(template, {
      templateId,
      serviceName,
      ...(servicePath !== undefined && { servicePath }),
      ...(nodeVersion !== undefined && { nodeVersion }),
      ...(coverageThreshold !== undefined && { coverageThreshold }),
      ...(enhancements !== undefined && { enhancements }),
      ...(deploymentProvider !== undefined && { deploymentProvider }),
      ...(deploymentTargets.length > 0 && { deploymentTargets }),
      ...(workflowVariant !== undefined && { workflowVariant }),
      ...(centralWorkflowRef !== undefined && { centralWorkflowRef }),
      ...(hasTestsDirectory !== undefined && { hasTestsDirectory }),
    });

    const outputFileName = customOutputFileName ?? '00-alphaci-access.yml';
    return {
      workflowFiles: bundle.workflowFiles,
      outputFileName,
    };
  }

  private async pushWorkflowFiles(
    accessToken: string,
    owner: string,
    repo: string,
    workflowFiles: StagedWorkflowFile[],
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    let latest: { commitSha: string; commitUrl: string | null } | null = null;

    for (const file of workflowFiles) {
      latest = await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.yaml,
      );
    }

    if (!latest) {
      throw new UnprocessableEntityException(
        'No workflow files were generated',
      );
    }

    return latest;
  }

  /**
   * Push a file to a GitHub repository via the Contents API.
   * If the file already exists (sha required), this will overwrite it.
   * Returns the commit SHA and HTML URL.
   */
  private async pushWorkflowFile(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    commitMessage = 'ci: add ALPHACI workflow',
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    const encodedContent = Buffer.from(content, 'utf8').toString('base64');

    // Check whether the file already exists so we can supply its sha (required for updates)
    let existingSha: string | undefined;
    try {
      const checkRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (checkRes.ok) {
        const existing = (await checkRes.json()) as { sha?: string };
        existingSha = existing.sha;
      }
    } catch {
      // Not critical — proceed without sha; GitHub will reject if required
    }

    const body: Record<string, unknown> = {
      message: commitMessage,
      content: encodedContent,
      branch: 'main',
    };

    if (existingSha) {
      body['sha'] = existingSha;
    }

    const putRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!putRes.ok) {
      const err = await putRes.text();
      throw new UnprocessableEntityException(
        `GitHub file push failed (${String(putRes.status)}): ${err}`,
      );
    }

    const response = (await putRes.json()) as GitHubContentsResponse;
    const commitSha = response.commit?.sha ?? '';
    const commitUrl = response.commit?.html_url ?? null;

    return { commitSha, commitUrl };
  }

  private describeGeneratedStack(stack: string | undefined): string {
    switch (normalizeProjectStack(stack)) {
      case 'nestjs':
        return 'NestJS API';
      case 'nextjs':
        return 'Next.js app';
      case 'react':
        return 'React app';
      case 'nodejs':
      default:
        return 'Node.js service';
    }
  }

  private generatedStructureLines(opts: {
    projectName: string;
    stack: string;
    repoShape?: string;
    frontendStack?: string;
    frontendServiceName?: string;
    backendServiceName?: string;
  }): string[] {
    const stack = normalizeProjectStack(opts.stack);
    const repoShape = normalizeRepoShape(opts.repoShape);

    if (repoShape === 'monorepo') {
      return [
        '- `package.json`, `tsconfig.json`, `jest.config.ts`, and `eslint.config.mjs` define the workspace-level toolchain.',
        `- \`packages/core/\` contains the ${this.describeGeneratedStack(opts.stack)} starter package and tests.`,
        '- Add more packages under `packages/` when the project grows beyond the initial core package.',
      ];
    }

    if (repoShape === 'microservices') {
      return [
        `- \`backend/\` contains ${opts.backendServiceName ?? opts.projectName} as a ${this.describeGeneratedStack(opts.stack)}.`,
        `- \`frontend/\` contains ${opts.frontendServiceName ?? `${opts.projectName}-fe`} as a ${this.describeGeneratedStack(opts.frontendStack ?? 'nextjs')}.`,
        '- Each service owns its own `package.json`, TypeScript config, Jest config, ESLint config, source folder, and `tests/` folder.',
        '- `docker-compose.yml` is included when Docker scaffolding is enabled for the backend service.',
      ];
    }

    if (stack === 'nestjs') {
      return [
        '- `src/main.ts` boots the NestJS app.',
        '- `src/app.module.ts` is the initial application module.',
        '- `tests/unit/` holds the unit test suites; the starter spec verifies the exported service name.',
      ];
    }

    if (stack === 'nextjs') {
      return [
        '- `src/app/layout.tsx` provides the App Router root layout.',
        '- `src/app/page.tsx` is the starter page.',
        '- `tests/unit/` holds the unit test suites; CI verifies this folder exists.',
        '- `next.config.ts` and the shared TypeScript/Jest/ESLint configs are ready for the generated workflow.',
      ];
    }

    if (stack === 'react') {
      return [
        '- `src/App.tsx` contains the starter React component.',
        '- `tests/unit/App.spec.tsx` renders the component with `react-dom/server` so unit tests pass without choosing a bundler for you.',
        '- Add Vite, Next.js, or another bundler when you are ready to build the real app shell.',
      ];
    }

    return [
      '- `src/index.ts` is the starter Node.js entrypoint.',
      '- `tests/unit/index.spec.ts` verifies the exported service name.',
      '- Docker scaffolding starts `dist/index.js`, matching the TypeScript build output.',
    ];
  }

  private gettingStartedCommands(repoShape?: string): string[] {
    if (normalizeRepoShape(repoShape) === 'microservices') {
      return [
        '```bash',
        'cd backend',
        'npm install',
        'npm run lint',
        'npm test',
        'npm run build',
        '',
        'cd ../frontend',
        'npm install',
        'npm run lint',
        'npm test',
        'npm run build',
        '```',
      ];
    }

    return [
      '```bash',
      'npm install',
      'npm run lint',
      'npm test',
      'npm run build',
      '```',
    ];
  }

  private repoShapeLabel(repoShape?: string): string {
    switch (normalizeRepoShape(repoShape)) {
      case 'monorepo':
        return 'monorepo workspace';
      case 'microservices':
        return 'microservices repository';
      case 'multi-repo':
        return 'single-service repository in a multi-repo project';
      case 'standalone':
      default:
        return 'standalone repository';
    }
  }

  private buildGeneratedRepoReadme(opts: {
    projectName: string;
    stack: string;
    repoShape?: string;
    frontendStack?: string;
    frontendServiceName?: string;
    backendServiceName?: string;
  }): string {
    return [
      `# ${opts.projectName}`,
      '',
      `Created by ALPHACI as a ${this.describeGeneratedStack(opts.stack)} ${this.repoShapeLabel(opts.repoShape)}.`,
      '',
      'This starter already includes source files, package scripts, TypeScript, ESLint, Jest coverage, SonarQube metadata, branch protections, and ALPHACI workflow files that match the selected stack. Use it as the first working baseline, then replace the starter code with your application code.',
      '',
      '## Project structure',
      '',
      ...this.generatedStructureLines(opts),
      '',
      '## Branch strategy',
      '',
      '| Branch  | Purpose |',
      '|---------|---------|',
      '| main    | Production - protected |',
      '| uat     | Integration and test - protected |',
      '| develop | Development integration - unprotected, no CI pipeline |',
      '',
      '## CI/CD',
      '',
      'Workflow files live in `.github/workflows/`. The CI pipeline runs on `uat` and `main` only. `develop` and user-created branches do not trigger workflows. Push to `uat` to trigger your first run.',
      '',
      '## Getting started',
      '',
      ...this.gettingStartedCommands(opts.repoShape),
      '',
      'Create a feature branch, open a pull request into `uat`, and let ALPHACI promote green changes to `main`.',
    ].join('\n');
  }

  /**
   * Push a full project scaffold to the repository on main, then add README.md.
   * Called immediately after createRepo() so that all downstream branches
   * branch off a commit that already contains these files.
   *
   * The scaffold structure varies by repoShape:
   * - standalone/multi-repo: flat files at repo root
   * - monorepo: workspace root + packages/core with project references
   * - microservices: backend/ and frontend/ subdirectories
   */
  private async pushStarterFiles(
    accessToken: string,
    owner: string,
    repo: string,
    opts: {
      projectName: string;
      stack?: string;
      repoShape?: string;
      includeDocker?: boolean;
      frontendStack?: string;
      frontendServiceName?: string;
      backendServiceName?: string;
    },
  ): Promise<void> {
    const {
      projectName,
      stack = 'nodejs',
      repoShape,
      frontendStack,
      frontendServiceName,
      backendServiceName,
    } = opts;

    const scaffoldOptions = {
      serviceName: projectName,
      stack,
      includeDocker: opts.includeDocker ?? defaultIncludeDocker(stack),
      sonarProjectKey: this.sonarProjectKey(owner, repo),
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    };

    const scaffoldFiles = buildProjectScaffold(scaffoldOptions);

    // Scaffold pushes are strict on purpose: a repo missing package.json,
    // jest.config.ts, or eslint.config.mjs is born with permanently red
    // checks. Failing here lets the caller's compensation path delete the
    // half-created repo so every repo that survives provisioning starts with
    // a fully green pipeline.
    for (const file of scaffoldFiles) {
      await this.pushWorkflowFile(
        accessToken,
        owner,
        repo,
        file.path,
        file.content,
        'chore: initialize project scaffold',
      );
    }

    // Always push README.md (.gitignore is included in the scaffold above)
    const readmeContent = this.buildGeneratedRepoReadme({
      projectName,
      stack,
      ...(repoShape ? { repoShape } : {}),
      ...(frontendStack ? { frontendStack } : {}),
      ...(frontendServiceName ? { frontendServiceName } : {}),
      ...(backendServiceName ? { backendServiceName } : {}),
    });

    await this.pushWorkflowFile(
      accessToken,
      owner,
      repo,
      'README.md',
      readmeContent,
      'chore: add project metadata',
    );
  }

  /**
   * Create two separate GitHub repositories (backend + frontend) each with
   * starter files, a workflow file, protected branches, and a DB row.
   */
  private async createMultiRepoProject(
    userId: string,
    _userLogin: string,
    repositoryCreationToken: string,
    provisioningToken: string,
    provisioningOwnerLogin: string | undefined,
    dto: CreateProjectDto,
  ): Promise<CreateProjectResponse> {
    if (!dto.multiRepoConfig) {
      throw new UnprocessableEntityException(
        'multiRepoConfig is required for multi-repo shape',
      );
    }

    const { backend, frontend } = dto.multiRepoConfig;

    // Derive repo names — avoid double-suffixing if caller already appended -be
    const beRepoName = dto.repoName.endsWith('-be')
      ? dto.repoName
      : `${dto.repoName}-be`;
    const feRepoName = beRepoName.replace(/-be$/, '-fe');
    const effectiveDeploymentProvisioning =
      this.withDefaultCreateDeploymentProvisioning({
        request: dto.deploymentProvisioning,
        projectTypeId: backend.projectTypeId,
        serviceName: backend.serviceName,
        repoName: beRepoName,
        servicePath: '.',
      });

    // ── Backend repository ──────────────────────────────────────────────────

    const backendTemplateId = this.resolveTemplateId(
      backend.projectTypeId,
      backend.workflowRecipeId,
    );
    // Each repo carries a flat standalone scaffold, so the workflow always
    // runs at the repo root — slot servicePaths like 'backend/' only apply to
    // single-repo shapes and would point at a directory that does not exist.
    const {
      workflowFiles: backendWorkflowFiles,
      outputFileName: backendOutputFileName,
    } = await this.buildWorkflowBundle({
      templateId: backendTemplateId,
      serviceName: backend.serviceName,
      servicePath: '.',
      nodeVersion: dto.nodeVersion,
      coverageThreshold: dto.coverageThreshold,
      // Each multi-repo repository carries the standalone scaffold, tests/
      // included, at its root.
      hasTestsDirectory: true,
      deploymentProvider: this.extractDeploymentProvider(
        effectiveDeploymentProvisioning,
        'backend',
      ),
      deploymentTargets: this.resolveDeploymentWorkflowTargets(
        effectiveDeploymentProvisioning,
        ['backend', 'standalone'],
        '.',
      ),
    });

    const {
      repoUrl: beRepoUrl,
      ownerLogin,
      repoName: actualBeRepoName,
    } = await this.githubService.createRepo(
      repositoryCreationToken,
      {
        repoName: beRepoName,
        private: dto.visibility === 'private',
      },
      provisioningOwnerLogin,
    );

    const beRepoFullName = `${ownerLogin}/${actualBeRepoName}`;
    const backendWorkflowPath =
      backendWorkflowFiles[0]?.path ??
      `.github/workflows/${backendOutputFileName}`;

    let backendRow: ProvisionedProjectRow | undefined;
    let backendCommitSha = '';
    let backendCommitUrl: string | null = null;
    let backendProvisioningComplete = false;
    try {
      await this.pushStarterFiles(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        {
          projectName: backend.serviceName || actualBeRepoName,
          stack: backend.projectTypeId,
          repoShape: 'standalone',
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
        },
      );

      // Persist + token + secrets before the workflow push so the first
      // access-gate run can authenticate (see createProject for rationale).
      backendRow = await this.createProjectRow({
        userId,
        workspaceId: await this.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        ),
        repoFullName: beRepoFullName,
        templateId: backendTemplateId,
        serviceName: backend.serviceName,
        workflowPath: backendWorkflowPath,
        status: 'provisioned',
        repoUrl: beRepoUrl,
        visibility: dto.visibility,
        repoShape: normalizeRepoShape(dto.repoShape),
        projectTypeId: backend.projectTypeId,
        workflowRecipeId: backend.workflowRecipeId ?? null,
        projectOptions: {
          ...this.repositoryOwnershipMetadata(dto, ownerLogin),
          ...(dto.tests ? { tests: dto.tests } : {}),
          workflowFiles: this.workflowFileMetadata(backendWorkflowFiles),
        },
      });

      const backendCiToken = await this.ciService.issueProjectToken(
        backendRow.id,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_TOKEN',
        backendCiToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.installSonarSecrets(
        provisioningToken,
        ownerLogin,
        actualBeRepoName,
      );

      ({ commitSha: backendCommitSha, commitUrl: backendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          backendWorkflowFiles,
        ));
      await this.projectsRepository.updateStatus(
        backendRow.id,
        'provisioned',
        backendCommitSha,
        backendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          branch,
        );
      }

      backendProvisioningComplete = true;
    } catch (error) {
      if (!backendProvisioningComplete) {
        await this.compensateFailedProvision(
          provisioningToken,
          ownerLogin,
          actualBeRepoName,
          backendRow?.id,
          userId,
        );
      }
      throw error;
    }

    if (!backendRow) {
      // Unreachable: a backend failure is rethrown from the catch above.
      throw new UnprocessableEntityException(
        'Backend repository provisioning did not complete',
      );
    }

    // ── Frontend repository (non-fatal on failure) ──────────────────────────

    let feRepoFullName: string | undefined;
    let feRepoUrl: string | undefined;
    let feRepoCreated: { owner: string; repo: string } | undefined;
    let feRow: ProvisionedProjectRow | undefined;
    let feProvisioningComplete = false;

    try {
      const frontendTemplateId = this.resolveTemplateId(
        frontend.projectTypeId,
        frontend.workflowRecipeId,
      );
      const {
        workflowFiles: frontendWorkflowFiles,
        outputFileName: frontendOutputFileName,
      } = await this.buildWorkflowBundle({
        templateId: frontendTemplateId,
        serviceName: frontend.serviceName,
        servicePath: '.',
        nodeVersion: dto.nodeVersion,
        coverageThreshold: dto.coverageThreshold,
        hasTestsDirectory: true,
        deploymentTargets: this.resolveDeploymentWorkflowTargets(
          effectiveDeploymentProvisioning,
          ['frontend'],
          '.',
        ),
      });

      const {
        repoUrl: resolvedFeRepoUrl,
        ownerLogin: feOwnerLogin,
        repoName: actualFeRepoName,
      } = await this.githubService.createRepo(
        repositoryCreationToken,
        {
          repoName: feRepoName,
          private: dto.visibility === 'private',
        },
        provisioningOwnerLogin,
      );

      feRepoCreated = { owner: feOwnerLogin, repo: actualFeRepoName };
      feRepoFullName = `${feOwnerLogin}/${actualFeRepoName}`;
      feRepoUrl = resolvedFeRepoUrl;

      await this.pushStarterFiles(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        {
          projectName: frontend.serviceName || actualFeRepoName,
          stack: frontend.projectTypeId,
          repoShape: 'standalone',
          ...(dto.tests?.['docker'] !== undefined && {
            includeDocker: dto.tests['docker'],
          }),
        },
      );

      const frontendWorkflowPath =
        frontendWorkflowFiles[0]?.path ??
        `.github/workflows/${frontendOutputFileName}`;

      feRow = await this.createProjectRow({
        userId,
        workspaceId: await this.resolveWorkspaceIdForCreate(
          userId,
          dto.workspaceId,
        ),
        repoFullName: feRepoFullName,
        templateId: frontendTemplateId,
        serviceName: frontend.serviceName,
        workflowPath: frontendWorkflowPath,
        status: 'provisioned',
        repoUrl: feRepoUrl,
        visibility: dto.visibility,
        repoShape: normalizeRepoShape(dto.repoShape),
        projectTypeId: frontend.projectTypeId,
        workflowRecipeId: frontend.workflowRecipeId ?? null,
        projectOptions: {
          ...this.repositoryOwnershipMetadata(dto, feOwnerLogin),
          workflowFiles: this.workflowFileMetadata(frontendWorkflowFiles),
        },
      });

      const frontendCiToken = await this.ciService.issueProjectToken(feRow.id);
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_TOKEN',
        frontendCiToken.token,
      );
      await this.githubService.setActionsSecretStrict(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
        'ALPHACI_REPORT_URL',
        ALPHACI_REPORT_URL,
      );
      await this.installSonarSecrets(
        provisioningToken,
        feOwnerLogin,
        actualFeRepoName,
      );

      const { commitSha: frontendCommitSha, commitUrl: frontendCommitUrl } =
        await this.pushWorkflowFiles(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          frontendWorkflowFiles,
        );
      await this.projectsRepository.updateStatus(
        feRow.id,
        'provisioned',
        frontendCommitSha,
        frontendCommitUrl,
      );

      // `develop` remains available but unprotected and does not run CI.
      for (const branch of ['develop', 'uat'] as const) {
        await this.githubService.createBranch(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          branch,
          'main',
        );
      }

      for (const branch of ['uat', 'main'] as const) {
        await this.githubService.applyBranchProtection(
          provisioningToken,
          feOwnerLogin,
          actualFeRepoName,
          branch,
        );
      }

      feProvisioningComplete = true;
    } catch (err) {
      this.logger.warn(
        `Multi-repo project created but frontend repo provisioning failed: ${String(err)}`,
      );
      // Roll back a half-created frontend repo so a retry can reuse its name;
      // the backend repo is fully provisioned and is still returned.
      if (!feProvisioningComplete && feRepoCreated) {
        await this.compensateFailedProvision(
          provisioningToken,
          feRepoCreated.owner,
          feRepoCreated.repo,
          feRow?.id,
          userId,
        );
        feRepoFullName = undefined;
        feRepoUrl = undefined;
      }
    }

    // Each repository provisions its own hosting slot: the backend repo gets
    // the Render target, the frontend repo (when it survived creation) gets
    // the Vercel target. Both use the centralized platform credentials.
    const provisioningResults: DeploymentProvisioningResult[] = [
      await this.provisionDeploymentTargets({
        projectId: backendRow.id,
        userId,
        repoFullName: beRepoFullName,
        githubAccessToken: provisioningToken,
        request: effectiveDeploymentProvisioning,
        slots: ['backend'],
      }),
    ];
    if (feRow && feRepoFullName) {
      provisioningResults.push(
        await this.provisionDeploymentTargets({
          projectId: feRow.id,
          userId,
          repoFullName: feRepoFullName,
          githubAccessToken: provisioningToken,
          request: effectiveDeploymentProvisioning,
          slots: ['frontend'],
        }),
      );

      // The per-repo provisioning passes cannot see each other's targets, so
      // cross-link the backend and frontend services here: the frontend gets
      // the backend's API URL, the backend gets the frontend origin for CORS.
      try {
        await this.projectDeploymentProvisioningService.crossLinkServiceUrls({
          userId,
          request: effectiveDeploymentProvisioning,
          groups: [
            { projectId: backendRow.id, result: provisioningResults[0]! },
            { projectId: feRow.id, result: provisioningResults[1]! },
          ],
        });
      } catch (error) {
        this.logger.warn(
          `Multi-repo cross-service env injection failed: ${String(error)}`,
        );
      }
    }

    return {
      id: backendRow.id,
      repoFullName: beRepoFullName,
      repoUrl: beRepoUrl,
      status: 'provisioned',
      workflowPath: backendWorkflowPath,
      workflowFiles: this.workflowFileMetadata(backendWorkflowFiles),
      githubCommitSha: backendCommitSha,
      githubCommitUrl: backendCommitUrl,
      projectTypeId: backend.projectTypeId,
      workflowRecipeId: backend.workflowRecipeId ?? '',
      additionalWorkflowPaths: [],
      ...(feRepoFullName !== undefined && {
        secondaryRepoFullName: feRepoFullName,
      }),
      ...(feRepoUrl !== undefined && { secondaryRepoUrl: feRepoUrl }),
      deploymentProvisioning:
        this.combineDeploymentProvisioningResults(provisioningResults),
    };
  }

  private parseRepoFullName(repoFullName: string): [string, string] {
    const parts = repoFullName.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnprocessableEntityException(
        `Invalid repoFullName '${repoFullName}'. Expected format: "owner/repo"`,
      );
    }

    return [parts[0], parts[1]];
  }

  private deriveOutputFileName(
    serviceName: string,
    templateId: string,
  ): string {
    const normalized = serviceName
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '');

    return `${normalized || 'service'}-${templateId}.yml`;
  }

  private ensureObject(
    parent: Record<string, unknown>,
    key: string,
  ): Record<string, unknown> {
    const existing = parent[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      parent[key] = next;
      return next;
    }

    return existing as Record<string, unknown>;
  }

  private setInputDefault(
    inputs: Record<string, unknown>,
    key: string,
    value: string | number,
    type: 'string' | 'number',
  ): void {
    const existing = inputs[key];
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      inputs[key] = {
        description: `Auto-generated default for ${key}`,
        required: false,
        type,
        default: value,
      };
    } else {
      const record = existing as Record<string, unknown>;
      record['default'] = value;
      if (!record['type']) {
        record['type'] = type;
      }
    }
  }

  private applyEnhancements(
    withConfig: Record<string, unknown>,
    enhancements: Array<
      | 'strictProductionApproval'
      | 'enableUatApproval'
      | 'disablePlaywright'
      | 'disableK6'
    >,
  ): void {
    for (const enhancement of enhancements) {
      switch (enhancement) {
        case 'disablePlaywright':
          withConfig['run-playwright'] = false;
          break;
        case 'disableK6':
          withConfig['run-k6'] = false;
          break;
        case 'enableUatApproval':
          withConfig['require-uat-approval'] = true;
          break;
        case 'strictProductionApproval':
          withConfig['require-production-approval'] = true;
          break;
        default:
          break;
      }
    }
  }

  private async loadCiTokenStatus(
    projectId: string,
  ): Promise<ProjectTokenStatus | null> {
    if (!this.ciTokensRepository) {
      return null;
    }

    return this.ciTokensRepository.findProjectTokenStatus(projectId);
  }

  private async loadOwnedProjectForWorkflowSettings(
    projectId: string,
    userId: string,
  ): Promise<{ row: ProvisionedProjectRow; project: ProvisionedProject }> {
    const row = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!row) {
      throw new NotFoundException('Project not found');
    }

    return {
      row,
      project: this.toProvisionedProject(row),
    };
  }

  private async resolveDefaultWorkspaceId(
    userId: string,
  ): Promise<string | null> {
    const workspaces = await this.workspacesService?.getMyWorkspaces(userId);
    return workspaces?.items[0]?.id ?? null;
  }

  /**
   * Workspace a newly-created project belongs to. When the caller creates from
   * inside a group (the "Create project" form passes that group's id), the
   * project is owned by that group — but only if the caller actually belongs to
   * it (or is a global admin), so a project can't be smuggled into a group the
   * caller has no access to. Otherwise it falls back to the caller's default
   * (personal) workspace.
   */
  private async resolveWorkspaceIdForCreate(
    userId: string,
    workspaceId?: string | null,
  ): Promise<string | null> {
    if (!workspaceId) {
      return this.resolveDefaultWorkspaceId(userId);
    }
    const allowed = await this.projectsRepository.canCreateInWorkspace(
      userId,
      workspaceId,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'You are not a member of the selected group.',
      );
    }
    return workspaceId;
  }

  /**
   * Single choke point for creating a provisioned_projects row.
   *
   * Wraps ProjectsRepository.create so every create path — single service,
   * microservices backend/frontend, multi-repo, and the existing-repo setup
   * flow — also gets its hierarchy link. Previously only repositories created
   * through the create-system path had a hierarchy.repositories row, which
   * meant a form-created group project could never have a developer assigned
   * to it (assignments reference hierarchy.repositories).
   *
   * The link is best-effort and never throws: the GitHub repo, branches, and
   * workflow commit have all already succeeded by this point, and failing here
   * would report a working project as a failure — and let the compensation
   * path delete it.
   */
  private async createProjectRow(
    input: Parameters<ProjectsRepository['create']>[0],
  ): Promise<Awaited<ReturnType<ProjectsRepository['create']>>> {
    const row = await this.projectsRepository.create(input);

    await this.hierarchyProjectLinkService?.ensureLink({
      projectId: row.id,
      workspaceId: input.workspaceId ?? null,
      name: input.serviceName,
      repoFullName: input.repoFullName,
      visibility: input.visibility ?? null,
      createdBy: input.userId,
      projectStatus: input.status ?? 'provisioning',
    });

    return row;
  }

  /**
   * Best-effort cleanup after a provisioning failure: removes the half-created
   * DB row and the orphaned GitHub repo so a retry with the same name can
   * succeed. Never throws — compensation failures are logged so they cannot
   * mask the original provisioning error.
   */
  private async compensateFailedProvision(
    accessToken: string,
    owner: string,
    repo: string,
    projectId: string | undefined,
    userId: string,
  ): Promise<void> {
    if (projectId) {
      try {
        await this.projectsRepository.deleteByIdAndUser(projectId, userId);
      } catch (error) {
        this.logger.warn(
          `Compensation: failed to delete project row ${projectId}: ${String(error)}`,
        );
      }
    }
    await this.githubService.deleteRepo(accessToken, owner, repo);
  }

  private async assertWithinQuota(
    userId: string,
    limitCode: UsageLimitCode,
    increment: number,
    projectId: string | null,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(
        userId,
        limitCode,
        increment,
      );
    } catch (error) {
      await this.recordProductEvent({
        userId,
        projectId,
        eventCode: 'quota_blocked',
        title: 'Quota blocked action',
        body: `Quota ${limitCode} blocked this action.`,
        metadata: {
          limitCode,
          increment,
        },
      });
      throw error;
    }
  }

  /**
   * Role gate for project-mutating actions. Defaults to the existing
   * permissive set (lead/delegated_lead/member) when no override is given, so
   * plain callers are unaffected; pass a narrower `roles` list (e.g.
   * ['admin', 'delegated_lead']) for actions with real external side effects, such as
   * deleting the linked GitHub repository. Mirrors
   * DeploymentTargetsService.assertProjectMutationAccess. No-ops when
   * workspaceAccessService isn't wired in (e.g. some test doubles), matching
   * the optional-injection pattern used throughout this service.
   */
  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
    roles: WorkspaceRole[] = ['admin', 'delegated_lead', 'member'],
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(
      projectId,
      userId,
      roles,
    );
  }

  private async recordProductEvent(input: {
    userId: string;
    projectId: string | null;
    eventCode: string;
    title: string;
    body: string;
    metadata: Record<string, unknown>;
  }): Promise<void> {
    await this.auditEventsService?.recordProjectEvent({
      actorUserId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      message: input.title,
      metadata: input.metadata,
    });
    await this.notificationEventsService?.record({
      userId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      title: input.title,
      body: input.body,
    });
  }

  private projectSyncSnapshotsEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.projectSyncSnapshots.enabled ?? false;
  }

  private workflowSettingsPreviewEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.workflowSettingsPreview.enabled ?? false;
  }

  private workflowUpdatePrEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.workflowUpdatePr.enabled ?? false;
  }

  private ciRunTrackingEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.ciRunTracking?.enabled ?? false;
  }

  private deploymentHistoryEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.deploymentHistory?.enabled ?? false;
  }

  private driftDetectionEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.driftDetection?.enabled ?? false;
  }

  private auditEventsEnabled(): boolean {
    const config = this.configService?.getOrThrow<AppConfig>('app');
    return config?.auditEvents?.enabled ?? false;
  }

  private timestampForBranch(date = new Date()): string {
    return date.toISOString().replaceAll(/\D/g, '').slice(0, 14);
  }

  private buildWorkflowUpdatePullRequestBody(
    preview: WorkflowSettingsPreviewResponse,
  ): string {
    const fileList = preview.workflowFiles
      .map((file) => `- ${file.path}`)
      .join('\n');
    const changedSettings = [
      `Node version: ${preview.settings.nodeVersion}`,
      `Coverage threshold: ${String(preview.settings.coverageThreshold)}`,
      `Service path: ${preview.settings.servicePath}`,
      `Central workflow ref: ${preview.settings.centralWorkflowRef}`,
    ].join('\n');

    return [
      'This PR updates the ALPHACI workflow configuration for this project.',
      '',
      'Changed settings:',
      changedSettings,
      '',
      'Generated workflow files:',
      fileList,
      '',
      'Runtime environment values are not included.',
    ].join('\n');
  }

  private normalizeWorkflowSettings(
    row: ProvisionedProjectRow,
    stored: ProjectWorkflowSettingsRowValue | null,
  ): WorkflowSettings {
    const storedSettings = stored?.settings ?? {};
    const projectOptions = row.project_options ?? {};
    const checks = this.readChecks(projectOptions, storedSettings);

    return {
      projectId: row.id,
      templateId:
        this.readString(storedSettings['templateId']) ?? row.template_id,
      projectTypeId:
        this.readNullableString(storedSettings['projectTypeId']) ??
        row.project_type_id,
      workflowRecipeId:
        this.readNullableString(storedSettings['workflowRecipeId']) ??
        row.workflow_recipe_id,
      serviceName:
        this.readString(storedSettings['serviceName']) ?? row.service_name,
      servicePath:
        this.readString(storedSettings['servicePath']) ??
        this.readString(projectOptions['servicePath']) ??
        '.',
      nodeVersion:
        this.readString(storedSettings['nodeVersion']) ??
        this.readString(projectOptions['nodeVersion']) ??
        '24',
      packageManager: 'npm',
      coverageThreshold:
        this.readNumber(storedSettings['coverageThreshold']) ??
        this.readNumber(projectOptions['coverageThreshold']) ??
        80,
      centralWorkflowRef:
        this.readString(storedSettings['centralWorkflowRef']) ??
        resolveDefaultCentralWorkflowRef(),
      checks,
    };
  }

  private mergeWorkflowSettings(
    base: WorkflowSettings,
    request: WorkflowSettingsPreviewRequest,
  ): WorkflowSettings {
    return {
      ...base,
      ...(request.templateId !== undefined && {
        templateId: request.templateId,
      }),
      ...(request.projectTypeId !== undefined && {
        projectTypeId: request.projectTypeId,
      }),
      ...(request.workflowRecipeId !== undefined && {
        workflowRecipeId: request.workflowRecipeId,
      }),
      ...(request.serviceName !== undefined && {
        serviceName: request.serviceName,
      }),
      ...(request.servicePath !== undefined && {
        servicePath: request.servicePath,
      }),
      ...(request.nodeVersion !== undefined && {
        nodeVersion: request.nodeVersion,
      }),
      packageManager: 'npm',
      ...(request.coverageThreshold !== undefined && {
        coverageThreshold: request.coverageThreshold,
      }),
      ...(request.centralWorkflowRef !== undefined && {
        centralWorkflowRef: request.centralWorkflowRef,
      }),
      checks: {
        ...base.checks,
        ...(request.checks ?? {}),
      },
    };
  }

  private validateWorkflowSettingsPreview(
    settings: WorkflowSettings,
    request: WorkflowSettingsPreviewRequest,
  ): WorkflowSettingsPreviewResponse['validationWarnings'] {
    const warnings: WorkflowSettingsPreviewResponse['validationWarnings'] = [];

    if (
      !Number.isInteger(settings.coverageThreshold) ||
      settings.coverageThreshold < 0 ||
      settings.coverageThreshold > 100
    ) {
      warnings.push({
        field: 'coverageThreshold',
        message: 'Coverage threshold must be between 0 and 100.',
      });
    }

    if (
      request.packageManager !== undefined &&
      request.packageManager !== 'npm'
    ) {
      warnings.push({
        field: 'packageManager',
        message: 'Only npm workflow previews are supported in this phase.',
      });
    }

    if (!/^[0-9]{2}$/.test(settings.nodeVersion)) {
      warnings.push({
        field: 'nodeVersion',
        message: 'Node version must be a two-digit major version.',
      });
    }

    return warnings;
  }

  private buildWorkflowPreviewDiff(
    currentFiles: WorkflowFileMetadata[],
    previewFiles: StagedWorkflowFile[],
  ): WorkflowSettingsPreviewResponse['diffSummary'] {
    const currentPaths = new Set(currentFiles.map((file) => file.path));

    return previewFiles.map((file) => ({
      path: file.path,
      status:
        currentPaths.size === 0
          ? 'new'
          : currentPaths.has(file.path)
            ? 'changed'
            : 'new',
    }));
  }

  private readChecks(
    projectOptions: Record<string, unknown>,
    storedSettings: Record<string, unknown>,
  ): WorkflowSettings['checks'] {
    const storedChecks =
      typeof storedSettings['checks'] === 'object' &&
      storedSettings['checks'] !== null &&
      !Array.isArray(storedSettings['checks'])
        ? (storedSettings['checks'] as Record<string, unknown>)
        : {};
    const optionTests =
      typeof projectOptions['tests'] === 'object' &&
      projectOptions['tests'] !== null &&
      !Array.isArray(projectOptions['tests'])
        ? (projectOptions['tests'] as Record<string, unknown>)
        : {};

    return {
      lint:
        this.readBoolean(storedChecks['lint']) ??
        this.readBoolean(optionTests['lint']) ??
        true,
      unit:
        this.readBoolean(storedChecks['unit']) ??
        this.readBoolean(optionTests['unit']) ??
        true,
      build:
        this.readBoolean(storedChecks['build']) ??
        this.readBoolean(optionTests['build']) ??
        true,
      security:
        this.readBoolean(storedChecks['security']) ??
        this.readBoolean(optionTests['security']) ??
        true,
    };
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private readNullableString(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private buildLocalSnapshotFindings(
    overview: ProjectOverviewResponse,
  ): ProjectDashboardSnapshotFinding[] {
    const findings: ProjectDashboardSnapshotFinding[] = [];

    if (overview.workflow.stageCount === 0) {
      findings.push({
        code: 'workflow_files_missing',
        severity: 'warning',
        message: 'No workflow file metadata is tracked yet.',
        source: 'local_snapshot',
      });
    }

    if (overview.deploymentTargets.count === 0) {
      findings.push({
        code: 'deployment_target_not_provisioned',
        severity: 'warning',
        message: 'No deployment targets are configured.',
        source: 'local_snapshot',
      });
    }

    if (overview.ciAuth.status === 'missing') {
      findings.push({
        code: 'ci_token_missing',
        severity: 'warning',
        message: 'No project CI token is tracked.',
        source: 'local_snapshot',
      });
    }

    if (overview.ciAuth.status === 'revoked') {
      findings.push({
        code: 'ci_token_revoked',
        severity: 'warning',
        message: 'Project CI token is revoked.',
        source: 'local_snapshot',
      });
    }

    if (overview.environment.count === 0) {
      findings.push({
        code: 'env_metadata_empty',
        severity: 'warning',
        message: 'No env var metadata is tracked yet.',
        source: 'local_snapshot',
      });
    }

    for (const check of overview.health.checks) {
      if (check.status === 'error') {
        findings.push({
          code: check.key,
          severity: 'error',
          message: check.message,
          source: 'local_snapshot',
        });
      }
    }

    return findings;
  }

  private toCiAuthOverview(token: ProjectTokenStatus | null): {
    status: 'active' | 'revoked' | 'missing';
    tokenPresent: boolean;
    tokenPrefix: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    revokedAt: string | null;
  } {
    if (!token) {
      return {
        status: 'missing',
        tokenPresent: false,
        tokenPrefix: null,
        createdAt: null,
        updatedAt: null,
        revokedAt: null,
      };
    }

    return {
      status: token.status,
      tokenPresent: true,
      tokenPrefix: token.tokenPrefix,
      createdAt: token.createdAt,
      updatedAt: token.updatedAt,
      revokedAt: token.revokedAt,
    };
  }

  private buildOverviewHealth(input: {
    project: ProvisionedProject;
    workflowFiles: WorkflowFileMetadata[];
    ciAuth: ProjectOverviewResponse['ciAuth'];
    deploymentTargets: DeploymentTargetSummary[];
    envMetadata: EnvVarMetadata[];
  }): ProjectOverviewResponse['health'] {
    const checks: ProjectOverviewResponse['health']['checks'] = [
      {
        key: 'project_status',
        label: 'Project status',
        status: input.project.status === 'failed' ? 'error' : 'ok',
        message:
          input.project.status === 'failed'
            ? (input.project.failureReason ?? 'Project provisioning failed.')
            : `Project is ${input.project.status}.`,
      },
      {
        key: 'workflow_bundle',
        label: 'Workflow bundle',
        status: input.workflowFiles.length > 0 ? 'ok' : 'warning',
        message:
          input.workflowFiles.length > 0
            ? `${input.workflowFiles.length} workflow file${input.workflowFiles.length === 1 ? '' : 's'} tracked.`
            : 'No workflow file metadata is tracked yet.',
      },
      {
        key: 'ci_token',
        label: 'CI token',
        status: input.ciAuth.status === 'active' ? 'ok' : 'warning',
        message:
          input.ciAuth.status === 'active'
            ? 'Project CI token is active.'
            : input.ciAuth.status === 'revoked'
              ? 'Project CI token is revoked.'
              : 'No project CI token is tracked.',
      },
      {
        key: 'deployment_targets',
        label: 'Deployment targets',
        status: input.deploymentTargets.length > 0 ? 'ok' : 'warning',
        message:
          input.deploymentTargets.length > 0
            ? `${input.deploymentTargets.length} deployment target${input.deploymentTargets.length === 1 ? '' : 's'} tracked.`
            : 'No deployment targets are configured.',
      },
      {
        key: 'env_metadata',
        label: 'Environment metadata',
        status: input.envMetadata.some((item) => item.status === 'failed')
          ? 'warning'
          : 'ok',
        message:
          input.envMetadata.length > 0
            ? `${input.envMetadata.length} env var key${input.envMetadata.length === 1 ? '' : 's'} tracked.`
            : 'No env var metadata is tracked yet.',
      },
    ];
    const summary = checks.some((check) => check.status === 'error')
      ? 'error'
      : checks.some((check) => check.status === 'warning')
        ? 'warning'
        : 'ok';

    return { summary, checks };
  }

  private toProvisionedProject(row: ProvisionedProjectRow): ProvisionedProject {
    const workflowFiles = Array.isArray(row.project_options?.['workflowFiles'])
      ? (row.project_options['workflowFiles'] as WorkflowFileMetadata[])
      : null;

    return {
      id: row.id,
      repoFullName: row.repo_full_name,
      templateId: row.template_id,
      serviceName: row.service_name,
      workflowPath: row.workflow_path,
      workflowFiles,
      status: row.status,
      githubCommitSha: row.github_commit_sha,
      githubCommitUrl: row.github_commit_url,
      failureReason: row.failure_reason,
      repoUrl: row.repo_url,
      visibility: row.visibility,
      repoShape: row.repo_shape,
      projectTypeId: row.project_type_id,
      workflowRecipeId: row.workflow_recipe_id,
      projectOptions: row.project_options,
      workspaceId: row.workspace_id ?? null,
      isOwner: row.is_owner,
    };
  }

  private workflowFileMetadata(
    workflowFiles: StagedWorkflowFile[],
  ): WorkflowFileMetadata[] {
    return workflowFiles.map((file) => ({
      stage: file.stage,
      name: file.name,
      path: file.path,
      gated: file.gated,
    }));
  }
}
