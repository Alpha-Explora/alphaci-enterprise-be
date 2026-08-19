import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { AuditEventsService } from '../audit/audit-events.service';
import { NotificationEventsService } from '../notifications/index.js';
import { DeploymentTargetsRepository } from './deployment-targets.repository';
import type { ProvisionEnvVarsDto } from './dto/provision-env-vars.dto';
import { EnvTokenEncryptionService } from './encryption.service';
import { EnvVarsRepository } from './env-vars.repository';
import type {
  DeploymentTargetSummary,
  EnvEnvironment,
  EnvProvider,
  EnvVarInput,
} from './env-provisioning.types';
import { ProviderClientRegistry } from './provider-clients/provider-client.registry';
import { ProviderConnectionsRepository } from './provider-connections.repository';
import { UsageQuotaService } from '../usage/usage-quota.service';
import type { UsageLimitCode } from '../usage/usage.types';
import { WorkspaceAccessService } from '../workspaces/workspace-access.service';

const ENVIRONMENTS: EnvEnvironment[] = ['test', 'uat', 'production'];
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{1,127}$/;
const MAX_ENV_VALUE_LENGTH = 16_384;

export interface ValidateEnvTextInput {
  deploymentTargetId: string;
  environment: EnvEnvironment;
  text: string;
}

export interface ValidateEnvTextResponse {
  keyCount: number;
  keys: string[];
  duplicates: string[];
  invalidKeys: string[];
  warnings: Array<{ code: string; message: string }>;
}

@Injectable()
export class EnvVarsService {
  constructor(
    private readonly envVarsRepository: EnvVarsRepository,
    private readonly deploymentTargetsRepository: DeploymentTargetsRepository,
    private readonly providerConnectionsRepository: ProviderConnectionsRepository,
    private readonly clientRegistry: ProviderClientRegistry,
    private readonly encryptionService: EnvTokenEncryptionService,
    private readonly configService: ConfigService,
    @Optional()
    private readonly usageQuotaService?: UsageQuotaService,
    @Optional()
    private readonly workspaceAccessService?: WorkspaceAccessService,
    @Optional()
    private readonly auditEventsService?: AuditEventsService,
    @Optional()
    private readonly notificationEventsService?: NotificationEventsService,
  ) {}

  async listEnvMetadata(projectId: string, userId: string) {
    return this.envVarsRepository.listEnvMetadataForUser(projectId, userId);
  }

  async validateEnvText(
    projectId: string,
    userId: string,
    input: ValidateEnvTextInput,
  ): Promise<ValidateEnvTextResponse> {
    if (!ENVIRONMENTS.includes(input.environment)) {
      throw new BadRequestException('Invalid environment');
    }
    await this.getOwnedTargetOrThrow(
      projectId,
      input.deploymentTargetId,
      userId,
    );

    const parsed = this.parseEnvText(input.text);
    const seen = new Set<string>();
    const keys: string[] = [];
    const duplicates = new Set<string>();
    const invalidKeys = new Set<string>();

    for (const entry of parsed) {
      if (!ENV_KEY_PATTERN.test(entry.key)) {
        invalidKeys.add(entry.key);
        continue;
      }
      if (seen.has(entry.key)) {
        duplicates.add(entry.key);
        continue;
      }
      seen.add(entry.key);
      keys.push(entry.key);
    }

    return {
      keyCount: parsed.length,
      keys,
      duplicates: [...duplicates],
      invalidKeys: [...invalidKeys],
      warnings: [],
    };
  }

  async provisionEnvVars(
    projectId: string,
    userId: string,
    dto: ProvisionEnvVarsDto,
  ) {
    if (dto.deploymentTargetId === undefined) {
      throw new BadRequestException('deploymentTargetId is required');
    }
    if (!ENVIRONMENTS.includes(dto.environment)) {
      throw new BadRequestException('Invalid environment');
    }
    this.validateVars(dto.vars);
    await this.assertProjectMutationAccess(projectId, userId);

    const target = await this.getOwnedTargetOrThrow(
      projectId,
      dto.deploymentTargetId,
      userId,
    );
    const existingKeyCount =
      await this.envVarsRepository.countExistingActiveKeys({
        deploymentTargetId: target.id,
        environment: dto.environment,
        keys: dto.vars.map((variable) => variable.key),
      });
    const newKeyCount = dto.vars.length - existingKeyCount;
    if (newKeyCount > 0) {
      await this.assertWithinQuota(userId, projectId, 'env_keys', newKeyCount);
    }

    const token = await this.resolveProviderToken(target, userId);
    const result = await this.clientRegistry
      .getClient(target.provider)
      .upsertEnvironmentVariables({
        token,
        targetId: target.providerProjectId,
        environment: dto.environment,
        vars: dto.vars,
      });

    await this.envVarsRepository.upsertEnvMetadataBatch({
      projectId,
      deploymentTargetId: target.id,
      environment: dto.environment,
      provider: target.provider,
      provisionedBy: userId,
      entries: [
        ...result.provisioned.map((entry) => ({
          key: entry.key,
          status: entry.status,
          errorSummary: null,
        })),
        ...result.failed.map((entry) => ({
          key: entry.key,
          status: entry.status,
          errorSummary: this.sanitizeError(entry.errorSummary),
        })),
      ],
    });

    await this.recordEnvEvent({
      userId,
      projectId,
      eventCode: 'env_vars_provisioned',
      title: 'Environment variables provisioned',
      body: `${dto.vars.length} environment variable key${dto.vars.length === 1 ? '' : 's'} sent to ${target.provider}.`,
      metadata: {
        deploymentTargetId: target.id,
        environment: dto.environment,
        keyCount: dto.vars.length,
        provisionedCount: result.provisioned.length,
        failedCount: result.failed.length,
      },
    });
    return result;
  }

  async deleteEnvMetadata(
    projectId: string,
    metadataId: string,
    userId: string,
  ): Promise<{ removed: true; key: string }> {
    await this.assertProjectMutationAccess(projectId, userId);
    const metadata = await this.envVarsRepository.findEnvMetadataForUser(
      metadataId,
      userId,
    );
    if (!metadata || metadata.projectId !== projectId) {
      throw new NotFoundException('Environment variable metadata not found');
    }

    const target = await this.getOwnedTargetOrThrow(
      projectId,
      metadata.deploymentTargetId,
      userId,
    );
    const token = await this.resolveProviderToken(target, userId);
    await this.clientRegistry
      .getClient(target.provider)
      .deleteEnvironmentVariable({
        token,
        targetId: target.providerProjectId,
        environment: metadata.environment,
        key: metadata.key,
      });

    const removed = await this.envVarsRepository.markEnvMetadataRemoved(
      metadataId,
      userId,
      null,
    );
    if (!removed) {
      throw new NotFoundException('Environment variable metadata not found');
    }

    await this.recordEnvEvent({
      userId,
      projectId,
      eventCode: 'env_var_removed',
      title: 'Environment variable removed',
      body: `${metadata.key} was removed from ${target.provider}.`,
      metadata: {
        metadataId,
        deploymentTargetId: target.id,
        environment: metadata.environment,
        key: metadata.key,
      },
    });
    return { removed: true, key: metadata.key };
  }

  private async assertProjectMutationAccess(
    projectId: string,
    userId: string,
  ): Promise<void> {
    await this.workspaceAccessService?.assertProjectRole(projectId, userId, [
      'admin',
      'delegated_lead',
      'member',
    ]);
  }

  private async assertWithinQuota(
    userId: string,
    projectId: string,
    limitCode: UsageLimitCode,
    increment: number,
  ): Promise<void> {
    try {
      await this.usageQuotaService?.assertWithinLimit(
        userId,
        limitCode,
        increment,
      );
    } catch (error) {
      await this.recordEnvEvent({
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

  private async recordEnvEvent(input: {
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
    await this.notificationEventsService?.record({
      userId: input.userId,
      projectId: input.projectId,
      eventCode: input.eventCode,
      title: input.title,
      body: input.body,
    });
  }

  private async getOwnedTargetOrThrow(
    projectId: string,
    deploymentTargetId: string,
    userId: string,
  ): Promise<DeploymentTargetSummary> {
    const target =
      await this.deploymentTargetsRepository.findDeploymentTargetForUser(
        deploymentTargetId,
        userId,
      );
    if (!target || target.projectId !== projectId) {
      throw new NotFoundException('Deployment target not found');
    }

    return target;
  }

  private parseEnvText(text: string): Array<{ key: string }> {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.replace(/^export\s+/, ''))
      .map((line) => {
        const separatorIndex = line.indexOf('=');
        return {
          key:
            separatorIndex === -1
              ? line.trim()
              : line.slice(0, separatorIndex).trim(),
        };
      })
      .filter((entry) => entry.key.length > 0);
  }

  private validateVars(vars: EnvVarInput[] | undefined): void {
    if (!Array.isArray(vars) || vars.length === 0) {
      throw new BadRequestException('At least one env var is required');
    }

    const seen = new Set<string>();
    for (const variable of vars) {
      if (!ENV_KEY_PATTERN.test(variable.key)) {
        throw new BadRequestException(`Invalid env var key: ${variable.key}`);
      }
      if (seen.has(variable.key)) {
        throw new BadRequestException(`Duplicate env var key: ${variable.key}`);
      }
      if (
        typeof variable.value !== 'string' ||
        variable.value.length > MAX_ENV_VALUE_LENGTH
      ) {
        throw new BadRequestException(
          `Invalid env var value for key: ${variable.key}`,
        );
      }
      seen.add(variable.key);
    }
  }

  private async resolveProviderToken(
    target: DeploymentTargetSummary,
    userId: string,
  ): Promise<string> {
    if (target.ownershipMode === 'flowci_managed') {
      const config = this.configService.getOrThrow<AppConfig>('app');
      const token = this.getManagedToken(
        target.provider,
        config.envProvisioning.flowciManaged,
      );
      if (!token) {
        throw new BadRequestException(
          `ALPHACI-managed ${target.provider} token is not configured`,
        );
      }

      return token;
    }

    if (!target.providerConnectionId) {
      throw new BadRequestException('Deployment target has no provider token');
    }
    const connection =
      await this.providerConnectionsRepository.findActiveProviderConnection(
        target.providerConnectionId,
        userId,
      );
    if (!connection || connection.provider !== target.provider) {
      throw new NotFoundException('Provider connection not found');
    }

    return this.encryptionService.decrypt(connection.encryptedToken);
  }

  private getManagedToken(
    provider: EnvProvider,
    config: AppConfig['envProvisioning']['flowciManaged'],
  ): string {
    return provider === 'render' ? config.renderToken : config.vercelToken;
  }

  private sanitizeError(error: string): string {
    return error.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 500);
  }
}
