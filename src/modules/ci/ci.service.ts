import { createHash, randomBytes } from 'node:crypto';

import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '../../config/app.config';
import { CiTokensRepository } from './ci-tokens.repository';
import type { CiValidationContextRow } from './ci-tokens.repository';

export interface IssueProjectTokenResult {
  token: string;
  tokenPrefix: string;
}

export interface ValidateRunInput {
  token: string;
  repoFullName: string;
  stage: string;
  workflowRunId?: string;
  headSha?: string;
}

export interface ValidateRunResult {
  authorized: true;
  projectId: string;
  repoFullName: string;
  stage: string;
}

@Injectable()
export class CiService {
  private readonly config: AppConfig;

  constructor(
    private readonly ciTokensRepository: CiTokensRepository,
    private readonly configService: ConfigService,
  ) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
  }

  async issueProjectToken(projectId: string): Promise<IssueProjectTokenResult> {
    const token = `aci_${randomBytes(32).toString('base64url')}`;
    const tokenPrefix = token.slice(0, 12);

    await this.ciTokensRepository.upsertProjectToken({
      projectId,
      tokenHash: this.hashToken(token),
      tokenPrefix,
    });

    return { token, tokenPrefix };
  }

  async validateRun(input: ValidateRunInput): Promise<ValidateRunResult> {
    const token = input.token.trim();
    const repoFullName = input.repoFullName.trim();
    const stage = input.stage.trim();

    if (!token) {
      throw new UnauthorizedException('CI token is required');
    }
    if (!repoFullName || !stage) {
      throw new ForbiddenException('Repository and stage are required');
    }

    const context = await this.ciTokensRepository.findValidationContext(
      this.hashToken(token),
      repoFullName,
    );

    if (!context || context.token_status !== 'active') {
      throw new ForbiddenException(
        'CI token is not authorized for this repository',
      );
    }
    if (context.project_status !== 'provisioned') {
      throw new ForbiddenException('Project is not provisioned');
    }
    if (!this.isEntitled(context)) {
      throw new ForbiddenException('Active subscription required');
    }

    return {
      authorized: true,
      projectId: context.project_id,
      repoFullName: context.repo_full_name,
      stage,
    };
  }

  /**
   * Entitlement for a pipeline run, mirroring SubscriptionService.getForUser.
   *
   * Pipelines are the product's core function, so this deliberately matches the
   * app-side rule rather than reading billing directly: when the gate is off
   * the deployment is contract-billed and every provisioned project may build,
   * and internal users are entitled without a billing row. Only when the gate
   * is on AND the owner is external does an active subscription matter.
   */
  private isEntitled(context: CiValidationContextRow): boolean {
    if (this.config.subscription.gateEnabled === false) return true;
    if (context.is_internal === true) return true;
    return context.subscription_status === 'active';
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
