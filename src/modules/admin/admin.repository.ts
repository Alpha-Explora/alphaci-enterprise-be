import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import type { AppRole, AppRoleSource } from './platform-admins.repository';

export interface AdminUserListRow {
  id: string;
  login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  provider: string;
  created_at: string;
  last_login_at: string | null;
  archived_at: string | null;
  onboarding_completed_at: string | null;
  app_role: AppRole;
  app_role_source: AppRoleSource;
  project_count: number;
  error_count: number;
}

export interface AdminUserProjectRow {
  id: string;
  repo_full_name: string;
  service_name: string | null;
  status: string;
  is_example: boolean;
  created_at: string;
}

export interface AdminUserWorkflowRow {
  id: string;
  template_name: string;
  stack: string;
  service_name: string;
  created_at: string;
}

export interface AdminUserErrorRow {
  id: string;
  repo_full_name: string;
  branch: string;
  run_id: string;
  stage: string;
  status: string;
  friendly_messages: unknown;
  created_at: string;
}

export interface AdminUserSubscriptionRow {
  plan: string;
  plan_code: string;
  status: string;
  current_period_end: string | null;
}

export interface AdminUserActivityRow {
  id: string;
  event_code: string;
  message: string;
  created_at: string;
}

export interface ListUsersOptions {
  search?: string;
  limit: number;
  offset: number;
}

/**
 * Read-only, cross-user data access for the admin views. Every query is fully
 * schema-qualified and NEVER selects secret-bearing columns (provider tokens,
 * encrypted env values, CI token secrets). Secrets are excluded at the source
 * here; the redaction layer in admin-user.view.ts is the second line of defense.
 */
@Injectable()
export class AdminRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async countUsers(search?: string): Promise<number> {
    const { clause, params } = this.buildSearchClause(search, 1);
    const result = await this.databaseService.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM identity.app_users AS u ${clause};`,
      params,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async listUsers(options: ListUsersOptions): Promise<AdminUserListRow[]> {
    const { clause, params } = this.buildSearchClause(options.search, 1);
    const limitParam = `$${params.length + 1}`;
    const offsetParam = `$${params.length + 2}`;

    const result = await this.databaseService.query<AdminUserListRow>(
      `
        SELECT
          u.id, u.login, u.display_name, u.email, u.avatar_url, u.provider,
          u.created_at, u.last_login_at, u.archived_at, u.onboarding_completed_at,
          u.app_role,
          u.app_role_source,
          COALESCE(p.project_count, 0)::int AS project_count,
          COALESCE(e.error_count, 0)::int   AS error_count
        FROM identity.app_users AS u
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS project_count
          FROM projects.provisioned_projects
          WHERE is_example = false
          GROUP BY user_id
        ) AS p ON p.user_id = u.id
        LEFT JOIN (
          SELECT user_id, COUNT(*) AS error_count
          FROM workflow.ci_run_reports
          WHERE status = 'failure'
          GROUP BY user_id
        ) AS e ON e.user_id = u.id
        ${clause}
        ORDER BY u.created_at DESC
        LIMIT ${limitParam} OFFSET ${offsetParam};
      `,
      [...params, options.limit, options.offset],
    );
    return result.rows;
  }

  async findUserById(userId: string): Promise<AdminUserListRow | null> {
    const result = await this.databaseService.query<AdminUserListRow>(
      `
        SELECT
          u.id, u.login, u.display_name, u.email, u.avatar_url, u.provider,
          u.created_at, u.last_login_at, u.archived_at, u.onboarding_completed_at,
          u.app_role,
          u.app_role_source,
          (SELECT COUNT(*)::int FROM projects.provisioned_projects
             WHERE user_id = u.id AND is_example = false) AS project_count,
          (SELECT COUNT(*)::int FROM workflow.ci_run_reports
             WHERE user_id = u.id AND status = 'failure') AS error_count
        FROM identity.app_users AS u
        WHERE u.id = $1
        LIMIT 1;
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async listUserProjects(userId: string): Promise<AdminUserProjectRow[]> {
    const result = await this.databaseService.query<AdminUserProjectRow>(
      `
        SELECT id, repo_full_name, service_name, status, is_example, created_at
        FROM projects.provisioned_projects
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100;
      `,
      [userId],
    );
    return result.rows;
  }

  async listUserWorkflows(userId: string): Promise<AdminUserWorkflowRow[]> {
    const result = await this.databaseService.query<AdminUserWorkflowRow>(
      `
        SELECT id, template_name, stack, service_name, created_at
        FROM workflow.workflow_generations
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 100;
      `,
      [userId],
    );
    return result.rows;
  }

  async listUserErrors(
    userId: string,
    limit = 100,
  ): Promise<AdminUserErrorRow[]> {
    const result = await this.databaseService.query<AdminUserErrorRow>(
      `
        SELECT id, repo_full_name, branch, run_id::text AS run_id, stage, status,
               friendly_messages, created_at
        FROM workflow.ci_run_reports
        WHERE user_id = $1 AND status = 'failure'
        ORDER BY created_at DESC
        LIMIT $2;
      `,
      [userId, limit],
    );
    return result.rows;
  }

  async findUserSubscription(
    userId: string,
  ): Promise<AdminUserSubscriptionRow | null> {
    const result = await this.databaseService.query<AdminUserSubscriptionRow>(
      `
        SELECT plan, plan_code, status, current_period_end
        FROM billing.user_subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async listUserActivity(
    userId: string,
    limit = 50,
  ): Promise<AdminUserActivityRow[]> {
    const result = await this.databaseService.query<AdminUserActivityRow>(
      `
        SELECT id, event_code, message, created_at
        FROM audit.audit_events
        WHERE actor_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2;
      `,
      [userId, limit],
    );
    return result.rows;
  }

  async listAdminAccessLog(limit = 100): Promise<AdminUserActivityRow[]> {
    const result = await this.databaseService.query<AdminUserActivityRow>(
      `
        SELECT id, event_code, message, created_at
        FROM audit.audit_events
        WHERE event_code LIKE 'admin.%'
        ORDER BY created_at DESC
        LIMIT $1;
      `,
      [limit],
    );
    return result.rows;
  }

  /**
   * Builds a parameterized ILIKE search clause over login / display_name / email.
   * startIndex is the first positional parameter to use ($1, $2, ...).
   */
  private buildSearchClause(
    search: string | undefined,
    startIndex: number,
  ): { clause: string; params: unknown[] } {
    const trimmed = search?.trim();
    if (!trimmed) {
      return { clause: '', params: [] };
    }
    const p = `$${startIndex}`;
    return {
      clause: `WHERE (u.login ILIKE ${p} OR u.display_name ILIKE ${p} OR u.email ILIKE ${p})`,
      params: [`%${trimmed}%`],
    };
  }
}
