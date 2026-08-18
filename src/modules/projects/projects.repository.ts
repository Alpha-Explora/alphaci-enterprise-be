import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

/**
 * Role-aware visibility predicate for a provisioned project (table aliased `pp`).
 * `userParam` is a positional placeholder literal (e.g. '$1') — NOT user input,
 * so interpolating it carries no injection risk. A project is visible when the
 * viewer is:
 *   - a GLOBAL admin (app_role 'admin', or any platform_admins row) — sees all;
 *   - the project owner;
 *   - ANY active member of the owning group/workspace; or
 *   - actively assigned to the hierarchy repository linked to the project.
 *
 * THE MEMBERSHIP RULE CHANGED ON 2026-08-18. It previously required the
 * manager tier ('admin' | 'delegated_lead'), so a developer added to a team saw
 * an empty Repositories section until someone assigned them a repository one at
 * a time — which made adding somebody to a team look like it had not worked.
 * Being in a team now means seeing that team's work.
 *
 * WHAT THIS DOES NOT GRANT. Visibility is not authority and it is not GitHub
 * access:
 *   - every destructive and management path takes a separate role array (see
 *     the `restrictToRoles` branch below) and is unchanged;
 *   - push access to the repository still comes from a repository ASSIGNMENT,
 *     which is what drives the GitHub team sync. A member who can see a project
 *     here may still have no rights on GitHub.
 * It does mean an ordinary team member can now read their team's code, pull
 * requests and pipeline logs through the project workspace — which is the point
 * of a shared team workspace, and the reason a personal workspace never has
 * other members in it.
 */
function projectVisibilitySql(userParam: string): string {
  return `
    EXISTS (SELECT 1 FROM identity.app_users vu
             WHERE vu.id = ${userParam} AND vu.app_role = 'admin')
    OR EXISTS (SELECT 1 FROM identity.platform_admins vpa
                WHERE vpa.user_id = ${userParam})
    OR pp.user_id = ${userParam}
    OR EXISTS (
      SELECT 1 FROM orgs.workspace_members vm
       WHERE vm.workspace_id = pp.workspace_id
         AND vm.user_id = ${userParam}
         AND vm.member_status = 'active'
    )
    OR EXISTS (
      SELECT 1
        FROM hierarchy.repositories vhr
        JOIN hierarchy.repository_assignments vra ON vra.repository_id = vhr.id
       WHERE vhr.provisioned_project_id = pp.id
         AND vra.user_id = ${userParam}
         AND vra.status IN ('active', 'pending')
    )`;
}

export type ProvisionedProjectStatus =
  | 'provisioning'
  | 'provisioned'
  | 'failed'
  | 'orphaned';

export interface ProvisionedProjectRow {
  id: string;
  user_id: string;
  repo_full_name: string;
  template_id: string;
  service_name: string;
  workflow_path: string;
  status: ProvisionedProjectStatus;
  github_commit_sha: string | null;
  github_commit_url: string | null;
  failure_reason: string | null;
  repo_url: string | null;
  visibility: string | null;
  repo_shape: string | null;
  project_type_id: string | null;
  workflow_recipe_id: string | null;
  project_options: Record<string, unknown> | null;
  workspace_id?: string | null;
  is_example?: boolean;
  /**
   * Viewer-relative: true only when the querying user is the actual row
   * owner (`pp.user_id = viewer`), not merely able to see the row via
   * admin/manager visibility. Only populated by queries that compute it
   * against a specific viewer (currently `listByUser`) — undefined
   * elsewhere, so callers must not assume it is always present.
   */
  is_owner?: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateProvisionedProjectInput {
  userId: string;
  repoFullName: string;
  templateId: string;
  serviceName: string;
  workflowPath: string;
  status: ProvisionedProjectStatus;
  githubCommitSha?: string | null;
  githubCommitUrl?: string | null;
  failureReason?: string | null;
  repoUrl?: string | null;
  visibility?: string | null;
  repoShape?: string | null;
  projectTypeId?: string | null;
  workflowRecipeId?: string | null;
  projectOptions?: Record<string, unknown> | null;
  workflowSha256?: string | null;
  workspaceId?: string | null;
}

@Injectable()
export class ProjectsRepository {
  private readonly logger = new Logger(ProjectsRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  async create(
    data: CreateProvisionedProjectInput,
  ): Promise<ProvisionedProjectRow> {
    const query = `
      INSERT INTO projects.provisioned_projects (
        user_id,
        repo_full_name,
        template_id,
        service_name,
        workflow_path,
        workflow_sha256,
        workflow_content_sha,
        status,
        github_commit_sha,
        github_commit_url,
        failure_reason,
        metadata,
        provisioned_at,
        failed_at,
        owner_login,
        repo_name,
        github_repository_url,
        visibility,
        repo_shape,
        project_type_id,
        workflow_recipe_id,
        workflow_template_id,
        project_options,
        workspace_id,
        is_example
      )
      VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20,
        $21, $22, $23, $24, $25
      )
      RETURNING
        id,
        user_id,
        repo_full_name,
        template_id,
        service_name,
        workflow_path,
        status,
        github_commit_sha,
        github_commit_url,
        failure_reason,
        github_repository_url AS repo_url,
        visibility,
        repo_shape,
        project_type_id,
        workflow_recipe_id,
        project_options,
        workspace_id,
        is_example,
        created_at,
        updated_at;
    `;
    const { ownerLogin, repoName } = this.splitRepoFullName(data.repoFullName);
    const workflowSha256 =
      data.workflowSha256 ?? this.computeWorkflowHash(data);
    const projectOptions = data.projectOptions ?? {};
    const metadata = {
      repoUrl: data.repoUrl ?? null,
      projectOptions,
    };

    const result = await this.databaseService.query<ProvisionedProjectRow>(
      query,
      [
        data.userId,
        data.repoFullName,
        data.templateId,
        data.serviceName,
        data.workflowPath,
        workflowSha256,
        data.githubCommitSha ?? null,
        data.status,
        data.githubCommitSha ?? null,
        data.githubCommitUrl ?? null,
        data.failureReason ?? null,
        JSON.stringify(metadata),
        data.status === 'provisioned' ? new Date().toISOString() : null,
        data.status === 'failed' ? new Date().toISOString() : null,
        ownerLogin,
        repoName,
        data.repoUrl ?? null,
        data.visibility ?? null,
        data.repoShape ?? null,
        data.projectTypeId ?? null,
        data.workflowRecipeId ?? null,
        data.templateId,
        JSON.stringify(projectOptions),
        data.workspaceId ?? null,
        false,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('provisioned_projects INSERT returned no row');
    }

    return row;
  }

  async listByUser(
    userId: string,
    limit = 50,
    workspaceId?: string | null,
  ): Promise<ProvisionedProjectRow[]> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(100, Math.trunc(limit)))
      : 25;

    const workspaceFilter = workspaceId ? 'AND pp.workspace_id = $3' : '';
    const values = workspaceId
      ? [userId, safeLimit, workspaceId]
      : [userId, safeLimit];

    const result = await this.databaseService.query<ProvisionedProjectRow>(
      `
        SELECT
          pp.id,
          pp.user_id,
          pp.repo_full_name,
          pp.template_id,
          pp.service_name,
          pp.workflow_path,
          pp.status,
          pp.github_commit_sha,
          pp.github_commit_url,
          pp.failure_reason,
          pp.github_repository_url AS repo_url,
          pp.visibility,
          pp.repo_shape,
          pp.project_type_id,
          pp.workflow_recipe_id,
          pp.project_options,
          pp.workspace_id,
          pp.is_example,
          (pp.user_id = $1) AS is_owner,
          pp.created_at,
          pp.updated_at
        FROM projects.provisioned_projects AS pp
        WHERE (${projectVisibilitySql('$1')})
        ${workspaceFilter}
        ORDER BY pp.created_at DESC
        LIMIT $2;
      `,
      values,
    );

    return result.rows;
  }

  /**
   * `allowedRoles` is a fail-closed SQL-level gate, not just an app-layer
   * convenience: when provided, a caller whose workspace role isn't in the
   * list gets no row back at all (indistinguishable from "not found"),
   * regardless of whether any optional app-layer role-checking service is
   * wired in. Omitted (the default) preserves the original unrestricted
   * behavior — any workspace member, any role, can read — so every existing
   * 2-arg call site is unaffected. Callers that need a *tightened* role set
   * for a destructive/sensitive read (e.g. before an opt-in GitHub repo
   * delete) should pass an explicit allowedRoles list.
   */
  /**
   * May this user create a project inside the given workspace/group? True for
   * an active member of the workspace, or any global admin (app_role 'admin' or
   * a platform_admins row). Used to validate a group-scoped "Create project".
   */
  async canCreateInWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ allowed: boolean }>(
      `
        SELECT (
          EXISTS (
            SELECT 1 FROM orgs.workspace_members m
             WHERE m.workspace_id = $2 AND m.user_id = $1
               AND m.member_status = 'active'
          )
          OR EXISTS (SELECT 1 FROM identity.app_users u
                      WHERE u.id = $1 AND u.app_role = 'admin')
          OR EXISTS (SELECT 1 FROM identity.platform_admins pa
                      WHERE pa.user_id = $1)
        ) AS allowed;
      `,
      [userId, workspaceId],
    );
    return result.rows[0]?.allowed ?? false;
  }

  async findByIdAndUser(
    id: string,
    userId: string,
    allowedRoles?: string[],
  ): Promise<ProvisionedProjectRow | null> {
    const result = await this.databaseService.query<ProvisionedProjectRow>(
      `
        SELECT
          pp.id,
          pp.user_id,
          pp.repo_full_name,
          pp.template_id,
          pp.service_name,
          pp.workflow_path,
          pp.status,
          pp.github_commit_sha,
          pp.github_commit_url,
          pp.failure_reason,
          pp.github_repository_url AS repo_url,
          pp.visibility,
          pp.repo_shape,
          pp.project_type_id,
          pp.workflow_recipe_id,
          pp.project_options,
          pp.workspace_id,
          pp.is_example,
          pp.created_at,
          pp.updated_at
        FROM projects.provisioned_projects AS pp
        WHERE pp.id = $1
          AND (
            CASE WHEN $3::text[] IS NOT NULL THEN
              -- Restricted mode (e.g. destructive delete): owner OR a workspace
              -- member holding one of the explicitly allowed roles. Unchanged.
              pp.user_id = $2
              OR EXISTS (
                SELECT 1
                FROM orgs.workspace_members AS member
                WHERE member.workspace_id = pp.workspace_id
                  AND member.user_id = $2
                  AND member.role = ANY($3::text[])
              )
            ELSE
              -- Default read: same role-aware visibility as the dashboard list
              -- (global admin / owner / group manager / assigned member).
              ${projectVisibilitySql('$2')}
            END
          )
        LIMIT 1;
      `,
      [id, userId, allowedRoles ?? null],
    );

    return result.rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    status: ProvisionedProjectStatus,
    commitSha?: string | null,
    commitUrl?: string | null,
    failureReason?: string | null,
  ): Promise<void> {
    await this.databaseService.query(
      `
        UPDATE projects.provisioned_projects
        SET
          status             = $2,
          github_commit_sha  = COALESCE($3, github_commit_sha),
          github_commit_url  = COALESCE($4, github_commit_url),
          failure_reason     = COALESCE($5, failure_reason),
          updated_at         = NOW()
        WHERE id = $1;
      `,
      [id, status, commitSha ?? null, commitUrl ?? null, failureReason ?? null],
    );
  }

  /**
   * Hard-delete a provisioned_projects row by its primary key.
   * CASCADE takes care of ci.project_ci_tokens automatically.
   * Scoped to userId to prevent cross-user deletions.
   * Returns true if a row was deleted, false if not found or wrong user.
   *
   * `allowedRoles` defaults to the original permissive set (lead/delegated_lead/
   * member) so every existing 2-arg call site is unaffected. This is the
   * FINAL enforcement point for the delete itself — pass a tightened list
   * (e.g. ['admin', 'delegated_lead']) for destructive variants (opt-in GitHub repo
   * delete) so the restriction is enforced by the SQL statement that
   * actually performs the delete, independent of any optional app-layer
   * pre-check.
   */
  async deleteByIdAndUser(
    id: string,
    userId: string,
    allowedRoles: string[] = ['admin', 'delegated_lead', 'member'],
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        DELETE FROM projects.provisioned_projects
        WHERE id = $1
          AND (
            user_id = $2
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              WHERE member.workspace_id = projects.provisioned_projects.workspace_id
                AND member.user_id = $2
                AND member.role = ANY($3::text[])
            )
          )
        RETURNING id;
      `,
      [id, userId, allowedRoles],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Set status = 'orphaned' for all project IDs in the given set.
   * Only touches rows owned by userId.
   */
  async markOrphaned(ids: string[], userId: string): Promise<number> {
    if (ids.length === 0) return 0;

    // Build $2, $3, … placeholders for the id list ($1 = userId)
    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');

    const result = await this.databaseService.query(
      `
        UPDATE projects.provisioned_projects
        SET status = 'orphaned', updated_at = NOW()
        WHERE (
            user_id = $1
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              WHERE member.workspace_id = projects.provisioned_projects.workspace_id
                AND member.user_id = $1
                AND member.role IN ('admin', 'delegated_lead', 'member')
            )
          )
          AND id = ANY(ARRAY[${placeholders}]::uuid[])
          AND status <> 'orphaned';
      `,
      [userId, ...ids],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Reset orphaned status back to provisioned for repos that reappeared
   * or were re-verified. Scoped to userId.
   */
  async markReachable(ids: string[], userId: string): Promise<number> {
    if (ids.length === 0) return 0;

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');

    const result = await this.databaseService.query(
      `
        UPDATE projects.provisioned_projects
        SET status = 'provisioned', updated_at = NOW()
        WHERE (
            user_id = $1
            OR EXISTS (
              SELECT 1
              FROM orgs.workspace_members AS member
              WHERE member.workspace_id = projects.provisioned_projects.workspace_id
                AND member.user_id = $1
                AND member.role IN ('admin', 'delegated_lead', 'member')
            )
          )
          AND id = ANY(ARRAY[${placeholders}]::uuid[])
          AND status = 'orphaned';
      `,
      [userId, ...ids],
    );
    return result.rowCount ?? 0;
  }

  /**
   * Hard-deletes every provisioned project row whose repo_full_name matches
   * (case-insensitive). Used by two callers that both confirm — via the
   * GitHub API or a `repository` `deleted` webhook — that the repo is
   * actually gone, not just unreachable:
   *   - ProjectsService.handleRepositoryDeleted() (live webhook path)
   *   - ProjectsService.reconcileDeletedRepos() (scheduled backlog sweep)
   * GitHub reports both org-wide with no user context, so unlike
   * deleteByIdAndUser() this is NOT scoped to a userId; it matches purely on
   * repo_full_name across every owner. CASCADE to ci.project_ci_tokens
   * applies automatically — same table/FK as deleteByIdAndUser(). Returns
   * the id + user_id of each row it deleted so the caller can still emit a
   * per-owner audit/notification event.
   */
  async deleteByRepoFullName(
    repoFullName: string,
  ): Promise<Array<{ id: string; user_id: string }>> {
    const result = await this.databaseService.query<{
      id: string;
      user_id: string;
    }>(
      `
        DELETE FROM projects.provisioned_projects
        WHERE lower(repo_full_name) = lower($1)
        RETURNING id, user_id;
      `,
      [repoFullName],
    );
    return result.rows;
  }

  /**
   * Lists every tracked project system-wide (all users, all workspaces) —
   * just the columns needed to check GitHub and delete confirmed-gone rows.
   * Backs ProjectsService.reconcileDeletedRepos(), the scheduled sweep that
   * catches repos deleted on GitHub before the repository.deleted webhook
   * path existed.
   *
   * Capped at 5,000 rows in a single pass rather than following listByUser's
   * 100-row cap: this is a full-table reconciliation script run a few times
   * a day (see src/scripts/reconcile-deleted-repos.ts), not a
   * user-interactive request, so a higher ceiling is appropriate. 5,000 is
   * comfortably above current project volume; if the table grows past that,
   * switch this to batched keyset pagination rather than raising the cap
   * further.
   */
  async listAllRepoFullNames(): Promise<
    Array<{ id: string; repo_full_name: string; user_id: string }>
  > {
    const result = await this.databaseService.query<{
      id: string;
      repo_full_name: string;
      user_id: string;
    }>(
      `
        SELECT id, repo_full_name, user_id
        FROM projects.provisioned_projects
        ORDER BY created_at ASC
        LIMIT 5000;
      `,
    );
    return result.rows;
  }

  private splitRepoFullName(repoFullName: string): {
    ownerLogin: string | null;
    repoName: string | null;
  } {
    const [ownerLogin, repoName] = repoFullName.split('/');
    return {
      ownerLogin: ownerLogin?.trim() || null,
      repoName: repoName?.trim() || null,
    };
  }

  private computeWorkflowHash(data: CreateProvisionedProjectInput): string {
    return createHash('sha256')
      .update(
        [
          data.repoFullName,
          data.templateId,
          data.serviceName,
          data.workflowPath,
          data.githubCommitSha ?? '',
        ].join('\n'),
      )
      .digest('hex');
  }
}
