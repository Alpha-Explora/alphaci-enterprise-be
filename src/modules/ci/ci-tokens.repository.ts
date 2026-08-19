import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export interface ProjectCiTokenInput {
  projectId: string;
  tokenHash: string;
  tokenPrefix: string;
}

export interface CiValidationContextRow {
  project_id: string;
  user_id: string;
  repo_full_name: string;
  project_status: 'provisioning' | 'provisioned' | 'failed';
  token_status: 'active' | 'revoked';
  subscription_status: 'inactive' | 'active' | 'canceled' | null;
  /**
   * Mirrors identity.app_users.is_internal. Internal users are fully entitled
   * without a billing row, exactly as SubscriptionService.getForUser treats
   * them — this column is what lets CI validation honour that same rule.
   * Null when the project's owner row is missing.
   */
  is_internal: boolean | null;
}

interface ProjectTokenStatusRow {
  status: 'active' | 'revoked';
  token_prefix: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ProjectTokenStatus {
  status: 'active' | 'revoked';
  tokenPrefix: string;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
}

@Injectable()
export class CiTokensRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async upsertProjectToken(data: ProjectCiTokenInput): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO ci.project_ci_tokens (
          project_id,
          token_hash,
          token_prefix,
          status
        )
        VALUES ($1, $2, $3, 'active')
        ON CONFLICT (project_id)
        DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          token_prefix = EXCLUDED.token_prefix,
          status = 'active',
          revoked_at = NULL,
          updated_at = NOW();
      `,
      [data.projectId, data.tokenHash, data.tokenPrefix],
    );
  }

  async findValidationContext(
    tokenHash: string,
    repoFullName: string,
  ): Promise<CiValidationContextRow | null> {
    const result = await this.databaseService.query<CiValidationContextRow>(
      `
        SELECT
          p.id AS project_id,
          p.user_id,
          p.repo_full_name,
          p.status AS project_status,
          t.status AS token_status,
          s.status AS subscription_status,
          u.is_internal
        FROM ci.project_ci_tokens t
        JOIN projects.provisioned_projects p ON p.id = t.project_id
        LEFT JOIN identity.app_users u ON u.id = p.user_id
        LEFT JOIN LATERAL (
          SELECT status
          FROM billing.user_subscriptions
          WHERE user_id = p.user_id
          ORDER BY created_at DESC
          LIMIT 1
        ) s ON true
        WHERE t.token_hash = $1
          AND p.repo_full_name = $2
        LIMIT 1;
      `,
      [tokenHash, repoFullName],
    );

    return result.rows[0] ?? null;
  }

  async revokeProjectTokens(projectId: string): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE ci.project_ci_tokens
        SET
          status = 'revoked',
          revoked_at = NOW(),
          updated_at = NOW()
        WHERE project_id = $1
          AND status = 'active';
      `,
      [projectId],
    );
  }

  async findProjectTokenStatus(
    projectId: string,
  ): Promise<ProjectTokenStatus | null> {
    const result = await this.databaseService.query<ProjectTokenStatusRow>(
      `
        SELECT
          status,
          token_prefix,
          created_at,
          updated_at,
          revoked_at
        FROM ci.project_ci_tokens
        WHERE project_id = $1
        LIMIT 1;
      `,
      [projectId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      status: row.status,
      tokenPrefix: row.token_prefix,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revokedAt: row.revoked_at,
    };
  }
}
