import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { AuditEventsService } from '../audit/audit-events.service';
import { NotificationEventsService } from '../notifications/index.js';
import { ProjectsRepository } from '../projects/projects.repository';
import {
  DeploymentTargetsRepository,
  type UpdateDeploymentTargetMetadataInput,
} from './deployment-targets.repository';
import { DeploymentStrategyResolver } from './deployment-strategy.resolver';
import type { CreateDeploymentTargetDto } from './dto/create-deployment-target.dto';
import type { DetachDeploymentTargetDto } from './dto/detach-deployment-target.dto';
import { EnvTokenEncryptionService } from './encryption.service';
import type {
  DeploymentTargetSummary,
  EnvProvider,
  EnvTargetSlot,
  RenderEnvironmentName,
} from './env-provisioning.types';
import { ProviderClientRegistry } from './provider-clients/provider-client.registry';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { RenderCostPolicyService } from './render-cost-policy.service';
import { UsageQuotaService } from '../usage/usage-quota.service';
import type { UsageLimitCode } from '../usage/usage.types';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';
import type { WorkspaceRole } from '../workspaces/workspaces.repository';

export interface DeploymentTargetLogEntry {
  timestamp: string;
  message: string;
  level: string;
}

@Injectable()
export class DeploymentTargetsService {
  private readonly logger = new Logger(DeploymentTargetsService.name);
  private readonly renderCostPolicy: RenderCostPolicyService;

  constructor(
    private readonly projectsRepository: ProjectsRepository,
    private readonly deploymentTargetsRepository: DeploymentTargetsRepository,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly clientRegistry: ProviderClientRegistry,
    private readonly configService: ConfigService,
    private readonly deploymentStrategyResolver: DeploymentStrategyResolver,
    renderCostPolicyService?: RenderCostPolicyService,
    @Optional()
    private readonly usageQuotaService?: UsageQuotaService,
    @Optional()
    private readonly workspaceAccessService?: WorkspaceAccessService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly notificationEventsService?: NotificationEventsService,
  ) {
    this.renderCostPolicy =
      renderCostPolicyService ?? new RenderCostPolicyService(configService);
  }

  async listDeploymentTargets(projectId: string, userId: string) {
    await this.getProjectOrThrow(projectId, userId);
    const targets =
      await this.deploymentTargetsRepository.listDeploymentTargets(projectId);

    // Enrich with copyable links: the live service URL and the provider
    // dashboard, so the UI never has to re-derive provider URL conventions.
    return targets.map((target) => ({
      ...target,
      publicUrl: this.targetPublicUrl(target),
      dashboardUrl: this.providerDashboardUrl(target),
    }));
  }

  /**
   * The public URL the deployed service answers on. Prefers the URL the
   * provider returned at creation (Render stores it in providerMetadata);
   * falls back to each provider's deterministic naming convention.
   */
  private targetPublicUrl(target: DeploymentTargetSummary): string | null {
    if (target.provider === 'render') {
      const metadataUrl = target.providerMetadata?.['renderServiceUrl'];
      if (typeof metadataUrl === 'string' && metadataUrl.trim()) {
        return metadataUrl.trim();
      }
      return target.providerProjectName
        ? `https://${target.providerProjectName}.onrender.com`
        : null;
    }

    if (target.provider === 'vercel') {
      return target.providerProjectName
        ? `https://${target.providerProjectName}.vercel.app`
        : null;
    }

    return null;
  }

  async createDeploymentTarget(
    projectId: string,
    userId: string,
    dto: CreateDeploymentTargetDto,
  ) {
    await this.assertProjectMutationAccess(projectId, userId);
    const project = await this.getProjectOrThrow(projectId, userId);
    await this.assertWithinQuota(userId, projectId, 'deployment_targets');
    this.assertOwnershipModeAllowed(dto);
    this.assertProviderSlotAllowed(dto.provider, dto.slot);
    if (dto.ownershipMode === 'flowci_managed' && dto.provider === 'render') {
      await this.assertWithinQuota(
        userId,
        projectId,
        'managed_render_services',
      );
    }
    if (dto.ownershipMode === 'flowci_managed' && dto.provider === 'vercel') {
      await this.assertWithinQuota(
        userId,
        projectId,
        'managed_vercel_projects',
      );
    }
    // Platform-wide capacity guard: managed targets share one Render/Vercel
    // account, so cap the aggregate across all users (per-user quotas above
    // cannot protect the shared account). Runs even if per-user quotas are off.
    if (dto.ownershipMode === 'flowci_managed') {
      await this.usageQuotaService?.assertManagedFleetCapacity(dto.provider);
    }
    const tokenInput: {
      ownershipMode: string;
      providerConnectionId?: string;
    } = { ownershipMode: dto.ownershipMode };
    if (dto.providerConnectionId) {
      tokenInput.providerConnectionId = dto.providerConnectionId;
    }
    const providerAuth = await this.resolveProviderToken(
      dto.provider,
      userId,
      tokenInput,
    );
    const deploymentStrategy = this.deploymentStrategyResolver.resolve({
      provider: dto.provider,
      ownershipMode: dto.ownershipMode,
      action: dto.action,
      renderDeployMethod: dto.renderDeployMethod,
    });
    const vercelScope = this.resolveVercelScope(
      dto.provider,
      dto.ownershipMode,
      providerAuth.connectionMetadata,
    );
    const renderDefaults = this.resolveRenderDefaults(dto);

    const target =
      dto.action === 'create'
        ? await this.clientRegistry.getClient(dto.provider).createTarget({
            token: providerAuth.token,
            repoFullName: project.repo_full_name,
            projectName: this.requireString(dto.projectName, 'projectName'),
            branchName: dto.branchName?.trim() || 'uat',
            ...(dto.rootDirectory?.trim()
              ? { rootDirectory: dto.rootDirectory.trim() }
              : {}),
            ...(dto.buildCommand?.trim()
              ? { buildCommand: dto.buildCommand.trim() }
              : {}),
            ...(dto.startCommand?.trim()
              ? { startCommand: dto.startCommand.trim() }
              : {}),
            deploymentStrategy,
            ...(renderDefaults.renderServiceType
              ? { renderServiceType: renderDefaults.renderServiceType }
              : {}),
            ...(renderDefaults.renderRuntime
              ? { renderRuntime: renderDefaults.renderRuntime }
              : {}),
            ...(renderDefaults.renderInstanceType
              ? { renderInstanceType: renderDefaults.renderInstanceType }
              : {}),
            ...(renderDefaults.renderRegion
              ? { renderRegion: renderDefaults.renderRegion }
              : {}),
            ...(renderDefaults.renderEnvironmentName
              ? { renderEnvironmentName: renderDefaults.renderEnvironmentName }
              : {}),
            ...(renderDefaults.dockerContext
              ? { dockerContext: renderDefaults.dockerContext }
              : {}),
            ...(renderDefaults.dockerfilePath
              ? { dockerfilePath: renderDefaults.dockerfilePath }
              : {}),
            ...(dto.imageUrl?.trim() ? { imageUrl: dto.imageUrl.trim() } : {}),
            ...(vercelScope.vercelTeamId
              ? { vercelTeamId: vercelScope.vercelTeamId }
              : {}),
            ...(vercelScope.vercelOrgId
              ? { vercelOrgId: vercelScope.vercelOrgId }
              : {}),
            ...(vercelScope.vercelTeamSlug
              ? { vercelTeamSlug: vercelScope.vercelTeamSlug }
              : {}),
          })
        : {
            id: this.requireString(dto.providerProjectId, 'providerProjectId'),
            name: this.requireString(
              dto.providerProjectName,
              'providerProjectName',
            ),
            provider: dto.provider,
            metadata: this.registerExistingMetadata(dto, renderDefaults),
          };

    const created =
      await this.deploymentTargetsRepository.createDeploymentTarget({
        projectId,
        slot: dto.slot,
        ownershipMode: dto.ownershipMode,
        provider: dto.provider,
        providerConnectionId:
          dto.ownershipMode === 'byo'
            ? (dto.providerConnectionId ?? null)
            : null,
        providerProjectId: target.id,
        providerProjectName: target.name,
        repoFullName: project.repo_full_name,
        branchName: dto.branchName?.trim() || 'uat',
        rootDirectory: dto.rootDirectory?.trim() || null,
        buildCommand: dto.buildCommand?.trim() || null,
        startCommand: dto.startCommand?.trim() || null,
        renderServiceType: renderDefaults.renderServiceType,
        renderInstanceType: renderDefaults.renderInstanceType,
        renderRegion: renderDefaults.renderRegion,
        renderEnvironmentName: renderDefaults.renderEnvironmentName,
        dockerContext: renderDefaults.dockerContext,
        dockerfilePath: renderDefaults.dockerfilePath,
        imageUrl: dto.imageUrl?.trim() || null,
        environmentMap: dto.environmentMap ?? {},
        deploymentStrategy,
        providerMetadata: {
          ...(target.metadata ?? {}),
          ...(renderDefaults.renderRuntime
            ? { renderRuntime: renderDefaults.renderRuntime }
            : {}),
        },
      });
    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_created',
      title: 'Deployment target created',
      body: `${created.providerProjectName} was attached to this project.`,
      metadata: {
        targetId: created.id,
        provider: created.provider,
        slot: created.slot,
      },
    });
    return created;
  }

  updateProviderMetadata(
    targetId: string,
    providerMetadata: Record<string, unknown>,
    status?: 'active' | 'missing' | 'failed',
  ) {
    return this.deploymentTargetsRepository.updateProviderMetadata(
      targetId,
      providerMetadata,
      status,
    );
  }

  async updateDeploymentTargetMetadata(
    projectId: string,
    targetId: string,
    userId: string,
    input: UpdateDeploymentTargetMetadataInput,
  ) {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    await this.assertProjectMutationAccess(projectId, userId);
    const existingTarget = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );
    if (input.slot !== undefined) {
      this.assertProviderSlotAllowed(existingTarget.provider, input.slot);
    }
    const target =
      await this.deploymentTargetsRepository.updateDeploymentTargetMetadataForUser(
        projectId,
        targetId,
        userId,
        this.normalizeMetadataUpdate(input),
      );
    if (!target) {
      throw new NotFoundException('Deployment target not found');
    }

    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_updated',
      title: 'Deployment target updated',
      body: `${target.providerProjectName} metadata was updated.`,
      metadata: {
        targetId: target.id,
        provider: target.provider,
        slot: target.slot,
      },
    });
    return target;
  }

  async syncDeploymentTarget(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<{
    mode: 'provider_live' | 'local_metadata';
    status: DeploymentTargetSummary['status'];
    findings: Array<{
      code: string;
      severity: 'warning' | 'error';
      message: string;
    }>;
    target: DeploymentTargetSummary;
  }> {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    await this.assertProjectMutationAccess(projectId, userId);
    let target = await this.getOwnedTargetOrThrow(projectId, targetId, userId);
    const findings: Array<{
      code: string;
      severity: 'warning' | 'error';
      message: string;
    }> = [];

    if (!target.providerProjectId?.trim()) {
      findings.push({
        code: 'provider_project_id_missing',
        severity: 'warning',
        message: 'Provider project ID is not tracked for this target.',
      });
    }
    if (!target.branchName?.trim()) {
      findings.push({
        code: 'target_branch_missing',
        severity: 'warning',
        message: 'Branch metadata is not tracked for this target.',
      });
    }

    let mode: 'provider_live' | 'local_metadata' = 'local_metadata';
    if (target.providerProjectId?.trim()) {
      try {
        const { token } = await this.resolveProviderToken(
          target.provider,
          userId,
          this.tokenResolutionInputFor(target),
        );
        const status = await this.clientRegistry.getClient(target.provider).getTargetStatus({
          token,
          targetId: target.providerProjectId,
          ...this.vercelScopeFor(target),
        });
        mode = 'provider_live';
        if (!status.exists) {
          findings.push({
            code: 'provider_resource_missing',
            severity: 'error',
            message: `The ${target.provider} resource for this target no longer exists — it may have been deleted outside ALPHACI.`,
          });
        }
        // Backfill provider-specific fields (e.g. Render's ownerId) the live
        // check discovered but this target was never given — most commonly
        // targets registered via "use existing target" rather than created
        // by ALPHACI. This is what lets real log fetching self-heal on the
        // next sync instead of requiring a one-off registration-time fix.
        const discovered = Object.entries(status.metadata ?? {}).filter(
          ([key, value]) => Boolean(value) && !target.providerMetadata?.[key],
        );
        if (discovered.length > 0) {
          target = await this.deploymentTargetsRepository.updateProviderMetadata(
            target.id,
            { ...target.providerMetadata, ...Object.fromEntries(discovered) },
          );
        }
      } catch {
        mode = 'local_metadata';
        findings.push({
          code: 'provider_live_check_failed',
          severity: 'warning',
          message: `Could not reach ${target.provider} to verify live status — showing locally tracked metadata only.`,
        });
      }
    }

    const response = {
      mode,
      status: findings.length > 0 ? 'missing' : target.status,
      findings,
      target,
    };
    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_synced',
      title: 'Deployment target synced',
      body: `${target.providerProjectName} metadata was checked.`,
      metadata: {
        targetId: target.id,
        provider: target.provider,
        status: response.status,
        mode,
        findingCount: findings.length,
      },
    });
    return response;
  }

  async detachDeploymentTarget(
    projectId: string,
    targetId: string,
    userId: string,
    options?: DetachDeploymentTargetDto,
  ): Promise<{
    detached: true;
    providerResourceDeleted: boolean;
    providerDeleteError?: string;
  }> {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    const requiresProviderDelete = options?.deleteProviderResource === true;
    await this.assertProjectMutationAccess(
      projectId,
      userId,
      requiresProviderDelete
        ? ['admin', 'delegated_lead']
        : ['admin', 'delegated_lead', 'member'],
    );
    // Load the target row before deleting anything locally — we need
    // providerProjectId/provider/ownershipMode/providerConnectionId to
    // attempt the live provider delete below, and the row disappears once
    // deleteDeploymentTargetForUser runs.
    const target = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );

    let providerResourceDeleted = false;
    let providerDeleteError: string | undefined;
    if (requiresProviderDelete && target.providerProjectId?.trim()) {
      try {
        const { token } = await this.resolveProviderToken(
          target.provider,
          userId,
          this.tokenResolutionInputFor(target),
        );
        const result = await this.clientRegistry
          .getClient(target.provider)
          .deleteTarget({ token, targetId: target.providerProjectId });
        providerResourceDeleted = result.deleted;
      } catch (error) {
        // A failed provider call must never block the local detach — the
        // user should never be stuck unable to detach because a third-party
        // API had a bad moment.
        providerDeleteError = this.truncateErrorMessage(error);
      }
    }

    const deleted =
      await this.deploymentTargetsRepository.deleteDeploymentTargetForUser(
        projectId,
        targetId,
        userId,
      );
    if (!deleted) {
      throw new NotFoundException('Deployment target not found');
    }

    const body = providerResourceDeleted
      ? `${target.providerProjectName} and its live ${target.provider} resource were both removed.`
      : providerDeleteError
        ? `${target.providerProjectName} was detached from ALPHACI; local tracking removed, but the live resource could not be deleted automatically.`
        : 'Deployment target metadata was removed from ALPHACI.';

    await this.recordTargetEvent({
      userId,
      projectId,
      eventCode: 'deployment_target_detached',
      title: 'Deployment target detached',
      body,
      metadata: {
        targetId,
        deleteProviderResourceRequested: requiresProviderDelete,
        providerResourceDeleted,
        ...(providerDeleteError ? { providerDeleteError } : {}),
      },
    });
    return {
      detached: true,
      providerResourceDeleted,
      ...(providerDeleteError ? { providerDeleteError } : {}),
    };
  }

  async getDeploymentTargetActions(
    projectId: string,
    targetId: string,
    userId: string,
  ) {
    if (!this.projectTargetManagementEnabled()) {
      throw new BadRequestException('Project target management is disabled');
    }

    const target = await this.getOwnedTargetOrThrow(
      projectId,
      targetId,
      userId,
    );

    return {
      targetId: target.id,
      provider: target.provider,
      actions: {
        // Capability descriptor, not an outcome: mirrors what
        // syncDeploymentTarget will *attempt* — a live provider check when a
        // providerProjectId is tracked (outcome still depends on live
        // reachability at call time), or a local-metadata-only check when
        // there's nothing to look up against.
        sync: {
          enabled: true,
          mode: target.providerProjectId?.trim()
            ? ('provider_live' as const)
            : ('local_metadata' as const),
        },
        detach: {
          enabled: true,
        },
        reinstallDeploymentSecrets: {
          enabled: false,
          reason: 'Provider activation required',
        },
        openProviderDashboard: {
          enabled: this.providerDashboardUrl(target) !== null,
          url: this.providerDashboardUrl(target),
        },
        openProviderConsole: {
          enabled: this.providerConsoleUrl(target) !== null,
          url: this.providerConsoleUrl(target),
        },
      },
    };
  }

  private async getProjectOrThrow(projectId: string, userId: string) {
    const project = await this.projectsRepository.findByIdAndUser(
      projectId,
      userId,
    );
    if (!project) {
      throw new NotFoundException('Project not found');
    }

    return project;
  }

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

  private truncateErrorMessage(error: unknown, maxLength = 300): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > maxLength
      ? `${message.slice(0, maxLength)}...`
      : message;
  }

  private tokenResolutionInputFor(target: DeploymentTargetSummary): {
    ownershipMode: string;
    providerConnectionId?: string;
  } {
    return {
      ownershipMode: target.ownershipMode,
      ...(target.providerConnectionId
        ? { providerConnectionId: target.providerConnectionId }
        : {}),
    };
  }

  private async assertWithinQuota(
    userId: string,
    projectId: string,
    limitCode: UsageLimitCode,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(userId, limitCode);
    } catch (error) {
      await this.recordTargetEvent({
        userId,
        projectId,
        eventCode: 'quota_blocked',
        title: 'Quota blocked action',
        body: `Quota ${limitCode} blocked this action.`,
        metadata: { limitCode },
      });
      throw error;
    }
  }

  /**
   * Enforce the single ownership mode this deployment offers (see
   * capabilities.controller and ENV_PROVISIONING_OWNERSHIP_MODE):
   *  - 'flowci_managed' (internal): deployments are centralized on the
   *    organization's Render/Vercel; bring-your-own is not available.
   *  - 'byo' (external/sold): managed hosting is archived; users connect their
   *    own provider accounts.
   */
  private assertOwnershipModeAllowed(dto: CreateDeploymentTargetDto): void {
    const configuredMode =
      this.configService.getOrThrow<AppConfig>('app').envProvisioning
        .ownershipMode;

    if (configuredMode === 'flowci_managed') {
      if (dto.ownershipMode !== 'flowci_managed') {
        throw new BadRequestException(
          `This workspace centralizes deployments on the organization's ${dto.provider} account. Bring-your-own ${dto.provider} hosting is not available here.`,
        );
      }
      return;
    }

    if (dto.ownershipMode === 'flowci_managed') {
      throw new BadRequestException(
        `Managed ${dto.provider} hosting is archived. Connect your own ${dto.provider} account and use BYO hosting for new targets.`,
      );
    }
  }

  private assertProviderSlotAllowed(
    provider: EnvProvider,
    slot: EnvTargetSlot,
  ): void {
    if (provider === 'render' && slot !== 'backend') {
      throw new BadRequestException(
        'Render deployment targets are backend-only. Choose the backend slot for Render.',
      );
    }

    if (provider === 'vercel' && slot !== 'frontend') {
      throw new BadRequestException(
        'Vercel deployment targets are frontend-only. Choose the frontend slot for Vercel.',
      );
    }
  }

  private async recordTargetEvent(input: {
    userId: string;
    projectId: string;
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
    try {
      await this.notificationEventsService?.record({
        userId: input.userId,
        projectId: input.projectId,
        eventCode: input.eventCode,
        title: input.title,
        body: input.body,
      });
    } catch (error) {
      // A notification failure must never surface as a failure of the
      // mutation that already committed (e.g. detach already deleted the
      // row) — mirrors AuditEventsService.recordProjectEvent's
      // self-protecting try/catch, which notificationEventsService.record()
      // itself does not have.
      this.logger.warn(
        `Notification event '${input.eventCode}' was not recorded: ${String(error)}`,
      );
    }
  }

  private async getOwnedTargetOrThrow(
    projectId: string,
    targetId: string,
    userId: string,
  ): Promise<DeploymentTargetSummary> {
    await this.getProjectOrThrow(projectId, userId);
    const target =
      await this.deploymentTargetsRepository.findDeploymentTargetForUser(
        targetId,
        userId,
      );
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Deployment target not found');
    }

    return target;
  }

  private projectTargetManagementEnabled(): boolean {
    const config = this.configService.getOrThrow<AppConfig>('app');
    return config.projectTargetManagement?.enabled ?? false;
  }

  private normalizeMetadataUpdate(
    input: UpdateDeploymentTargetMetadataInput,
  ): UpdateDeploymentTargetMetadataInput {
    const normalized: UpdateDeploymentTargetMetadataInput = {};
    if (input.slot !== undefined) {
      normalized.slot = this.requireTargetSlot(input.slot);
    }
    if (input.providerProjectName !== undefined) {
      normalized.providerProjectName = this.requireString(
        input.providerProjectName,
        'providerProjectName',
      );
    }
    if (input.branchName !== undefined) {
      normalized.branchName = this.requireString(
        input.branchName,
        'branchName',
      );
    }
    if (input.rootDirectory !== undefined) {
      normalized.rootDirectory = input.rootDirectory?.trim() || null;
    }
    if (input.buildCommand !== undefined) {
      normalized.buildCommand = input.buildCommand?.trim() || null;
    }
    if (input.startCommand !== undefined) {
      normalized.startCommand = input.startCommand?.trim() || null;
    }
    if (input.renderEnvironmentName !== undefined) {
      normalized.renderEnvironmentName =
        input.renderEnvironmentName === null
          ? null
          : this.requireRenderEnvironment(input.renderEnvironmentName);
    }

    return normalized;
  }

  private requireTargetSlot(value: unknown): EnvTargetSlot {
    if (value === 'backend' || value === 'frontend' || value === 'standalone') {
      return value;
    }

    throw new BadRequestException(
      'slot must be backend, frontend, or standalone',
    );
  }

  private requireRenderEnvironment(value: unknown): RenderEnvironmentName {
    if (value === 'test' || value === 'uat' || value === 'production') {
      return value;
    }

    throw new BadRequestException(
      'renderEnvironmentName must be test, uat, or production',
    );
  }

  private providerDashboardUrl(target: DeploymentTargetSummary): string | null {
    if (target.provider === 'vercel') {
      const teamSlug =
        typeof target.providerMetadata['vercelTeamSlug'] === 'string'
          ? target.providerMetadata['vercelTeamSlug'].trim()
          : '';
      return teamSlug
        ? `https://vercel.com/${teamSlug}/${target.providerProjectName}`
        : `https://vercel.com/dashboard/project/${target.providerProjectId}`;
    }

    if (target.provider === 'render') {
      return `https://dashboard.render.com/web/${target.providerProjectId}`;
    }

    return null;
  }

  private providerConsoleUrl(target: DeploymentTargetSummary): string | null {
    if (target.provider === 'vercel') {
      const teamSlug =
        typeof target.providerMetadata['vercelTeamSlug'] === 'string'
          ? target.providerMetadata['vercelTeamSlug'].trim()
          : '';
      return teamSlug
        ? `https://vercel.com/${teamSlug}/${target.providerProjectName}/deployments`
        : `https://vercel.com/dashboard/project/${target.providerProjectId}/deployments`;
    }

    if (target.provider === 'render') {
      return `https://dashboard.render.com/web/${target.providerProjectId}/logs`;
    }

    return null;
  }

  private async resolveProviderToken(
    provider: EnvProvider,
    userId: string,
    input: {
      ownershipMode: string;
      providerConnectionId?: string;
    },
  ): Promise<{ token: string; connectionMetadata: Record<string, unknown> }> {
    if (input.ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const token =
        provider === 'render'
          ? config.envProvisioning.flowciManaged.renderToken
          : config.envProvisioning.flowciManaged.vercelToken;
      if (!token) {
        throw new BadRequestException(
          `ALPHACI-managed ${provider} token is not configured`,
        );
      }

      return { token, connectionMetadata: {} };
    }

    if (!input.providerConnectionId) {
      throw new BadRequestException('providerConnectionId is required');
    }
    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        input.providerConnectionId,
        userId,
      );
    if (!connection || connection.provider !== provider) {
      throw new NotFoundException('Provider connection not found');
    }

    return {
      token: this.encryptionService.decrypt(connection.encryptedToken),
      connectionMetadata: connection.metadata,
    };
  }

  private resolveVercelScope(
    provider: EnvProvider,
    ownershipMode: string,
    connectionMetadata: Record<string, unknown>,
  ): {
    vercelOrgId?: string;
    vercelTeamId?: string;
    vercelTeamSlug?: string;
  } {
    if (provider !== 'vercel') {
      return {};
    }

    if (ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const teamId =
        config.envProvisioning.flowciManaged.vercelTeamId?.trim() ?? '';
      const teamSlug =
        config.envProvisioning.flowciManaged.vercelTeamSlug?.trim() ?? '';
      if (!teamId) {
        throw new BadRequestException(
          'ALPHACI_VERCEL_TEAM_ID is required for ALPHACI-managed Vercel deployment targets',
        );
      }

      return {
        vercelOrgId: teamId,
        vercelTeamId: teamId,
        ...(teamSlug ? { vercelTeamSlug: teamSlug } : {}),
      };
    }

    const teamId =
      typeof connectionMetadata['teamId'] === 'string'
        ? connectionMetadata['teamId'].trim()
        : '';
    const teamSlug =
      typeof connectionMetadata['teamSlug'] === 'string'
        ? connectionMetadata['teamSlug'].trim()
        : '';
    const orgId =
      typeof connectionMetadata['orgId'] === 'string'
        ? connectionMetadata['orgId'].trim()
        : '';

    if (!orgId && !teamId) {
      throw new BadRequestException(
        'Vercel provider connection is missing org metadata. Reconnect the Vercel account before provisioning deployment targets.',
      );
    }

    return {
      vercelOrgId: orgId || teamId,
      ...(teamId ? { vercelTeamId: teamId } : {}),
      ...(teamSlug ? { vercelTeamSlug: teamSlug } : {}),
    };
  }

  private resolveRenderDefaults(dto: CreateDeploymentTargetDto): {
    renderServiceType: CreateDeploymentTargetDto['renderServiceType'] | null;
    renderRuntime: CreateDeploymentTargetDto['renderRuntime'] | null;
    renderInstanceType: string | null;
    renderRegion: string | null;
    renderEnvironmentName:
      | CreateDeploymentTargetDto['renderEnvironmentName']
      | null;
    dockerContext: string | null;
    dockerfilePath: string | null;
  } {
    if (dto.provider !== 'render') {
      return {
        renderServiceType: null,
        renderRuntime: null,
        renderInstanceType: null,
        renderRegion: null,
        renderEnvironmentName: null,
        dockerContext: null,
        dockerfilePath: null,
      };
    }

    const defaults = this.renderCostPolicy.resolveDefaults({
      ownershipMode: dto.ownershipMode,
      serviceType: dto.renderServiceType,
      instanceType: dto.renderInstanceType,
      region: dto.renderRegion,
    });
    const rootDirectory = dto.rootDirectory?.trim() || '.';
    const dockerContext =
      dto.dockerContext?.trim() ||
      (rootDirectory === '.' ? '.' : rootDirectory);

    return {
      renderServiceType: defaults.serviceType,
      renderRuntime: dto.renderRuntime ?? 'node',
      renderInstanceType: defaults.instanceType,
      renderRegion: defaults.region,
      renderEnvironmentName:
        dto.renderEnvironmentName ?? this.environmentFromBranch(dto.branchName),
      dockerContext,
      dockerfilePath: dto.dockerfilePath?.trim() || 'Dockerfile',
    };
  }

  private environmentFromBranch(
    branchName: string | undefined,
  ): CreateDeploymentTargetDto['renderEnvironmentName'] {
    const branch = branchName?.trim();
    if (branch === 'main') {
      return 'production';
    }
    if (branch === 'uat' || branch === 'production') {
      return branch;
    }

    return 'test';
  }

  private registerExistingMetadata(
    dto: CreateDeploymentTargetDto,
    renderDefaults: ReturnType<
      DeploymentTargetsService['resolveRenderDefaults']
    >,
  ): Record<string, unknown> {
    if (dto.provider !== 'render') {
      return {};
    }

    return {
      deploymentStrategy: 'render_existing_service',
      renderServiceType: renderDefaults.renderServiceType,
      renderRuntime: renderDefaults.renderRuntime,
      renderInstanceType: renderDefaults.renderInstanceType,
      renderRegion: renderDefaults.renderRegion,
      renderEnvironmentName: renderDefaults.renderEnvironmentName,
      dockerContext: renderDefaults.dockerContext,
      dockerfilePath: renderDefaults.dockerfilePath,
    };
  }

  private requireString(value: string | undefined, field: string): string {
    if (!value?.trim()) {
      throw new BadRequestException(`${field} is required`);
    }

    return value.trim();
  }

  async getDeploymentTargetLogs(
    projectId: string,
    targetId: string,
    userId: string,
    filters?: { type?: string; startTime?: string; endTime?: string },
  ): Promise<{
    logs: DeploymentTargetLogEntry[];
    source: 'live' | 'simulated';
    reason?: string;
  }> {
    const target =
      await this.deploymentTargetsRepository.findDeploymentTargetForUser(
        targetId,
        userId,
      );
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Deployment target not found');
    }

    const client = this.clientRegistry.getClient(target.provider);
    if (!client.getLogs) {
      return {
        source: 'simulated',
        reason: `Live log fetching is not supported for ${target.provider}.`,
        logs: this.getMockLogs(target),
      };
    }

    try {
      const { token } = await this.resolveProviderToken(
        target.provider,
        userId,
        {
          ownershipMode: target.ownershipMode,
          ...(target.providerConnectionId
            ? { providerConnectionId: target.providerConnectionId }
            : {}),
        },
      );
      const ownerId =
        target.providerMetadata?.['renderOwnerId'] ??
        target.providerMetadata?.['ownerId'];
      const logs = await client.getLogs({
        token,
        targetId: target.providerProjectId,
        ...filters,
        ...(typeof ownerId === 'string' && ownerId.trim()
          ? { renderOwnerId: ownerId }
          : {}),
        ...this.vercelScopeFor(target),
      });
      // An empty array here is a legitimate live result (a quiet deployment
      // with no recent log lines) — getLogs() throws instead of returning []
      // for cases that aren't actually "live", like a missing Render owner
      // ID, so reaching this point at all means the fetch succeeded.
      return { source: 'live', logs };
    } catch (err) {
      this.logger.warn(
        `Failed to retrieve ${target.provider} logs: ${(err as Error).message}`,
      );
      return {
        source: 'simulated',
        reason: (err as Error).message,
        logs: this.getMockLogs(target),
      };
    }
  }

  private vercelScopeFor(
    target: DeploymentTargetSummary,
  ): { vercelTeamId?: string; vercelTeamSlug?: string } {
    const teamId = target.providerMetadata?.['vercelTeamId'];
    const slug = target.providerMetadata?.['vercelTeamSlug'];
    return {
      ...(typeof teamId === 'string' && teamId.trim()
        ? { vercelTeamId: teamId.trim() }
        : {}),
      ...(typeof slug === 'string' && slug.trim()
        ? { vercelTeamSlug: slug.trim() }
        : {}),
    };
  }

  private getMockLogs(
    target: DeploymentTargetSummary,
  ): DeploymentTargetLogEntry[] {
    const now = new Date();
    const offsetDate = (secondsAgo: number) => {
      return new Date(now.getTime() - secondsAgo * 1000).toISOString();
    };

    if (target.provider === 'vercel') {
      return [
        {
          timestamp: offsetDate(70),
          message:
            ' ready   - started server on 0.0.0.0:3000, url: http://localhost:3000',
          level: 'info',
        },
        {
          timestamp: offsetDate(68),
          message: ' info    - Loaded env from /app/.env',
          level: 'info',
        },
        {
          timestamp: offsetDate(60),
          message:
            ' event   - compiled client and server successfully in 835ms (192 modules)',
          level: 'info',
        },
        {
          timestamp: offsetDate(50),
          message: ' info    - [request] GET / 200 in 89ms',
          level: 'info',
        },
        {
          timestamp: offsetDate(40),
          message: ' info    - [request] GET /api/capabilities 200 in 12ms',
          level: 'info',
        },
        {
          timestamp: offsetDate(30),
          message:
            ' warn    - [warning] Large page data detected in /projects/[projectId] (120kb)',
          level: 'warn',
        },
        {
          timestamp: offsetDate(15),
          message:
            ' error   - [problem] Failed to proxy socket connection: connection timeout at /api/ws',
          level: 'error',
        },
      ];
    }

    const dateStr = now.toLocaleDateString('en-US');
    return [
      {
        timestamp: offsetDate(90),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [RouterExplorer] Mapped {/api/v1/capabilities, GET} route +1ms`,
        level: 'info',
      },
      {
        timestamp: offsetDate(88),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [NestApplication] Nest application successfully started +402ms`,
        level: 'info',
      },
      {
        timestamp: offsetDate(86),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:40 AM     LOG [Bootstrap] Application running on 0.0.0.0:10000`,
        level: 'info',
      },
      {
        timestamp: offsetDate(75),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:12:41 AM    WARN [AllExceptionsFilter] HTTP 404 on HEAD /: Cannot HEAD /`,
        level: 'warn',
      },
      {
        timestamp: offsetDate(65),
        message: `==> Your service is live 🚀`,
        level: 'system',
      },
      {
        timestamp: offsetDate(64),
        message: `==> Available at your primary URL https://${target.providerProjectName || 'flowci-be-test'}.onrender.com`,
        level: 'system',
      },
      {
        timestamp: offsetDate(60),
        message: `==> //////////////////////////////////////////////////////`,
        level: 'system',
      },
      {
        timestamp: offsetDate(30),
        message: `[87zbn] [Nest] 1  - ${dateStr}, 9:13:27 AM    WARN [CatalogService] Could not fetch central-workflow tags from GitHub; falling back to the default ref only; GitHub tags request failed with status 403`,
        level: 'warn',
      },
    ];
  }
}
