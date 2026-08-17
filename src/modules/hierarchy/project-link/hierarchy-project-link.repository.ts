import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../database/database.service';

export interface LinkProjectInput {
  projectId: string;
  workspaceId: string;
  /** Display name for the system / delivery project / repository nodes. */
  name: string;
  repoFullName: string;
  visibility: 'private' | 'public';
  createdBy: string;
  /** provisioned_projects.status — maps to the repository row's status. */
  projectStatus: string;
}

/**
 * Writes the systems -> delivery_projects -> repositories chain that makes a
 * form-created GROUP project assignable.
 *
 * Deliberately raw SQL in one transaction rather than composing
 * SystemsService/DeliveryProjectsService/RepositoriesService: those perform
 * per-call authorization assertions (assertCanCreateInGroup and friends), and
 * this runs AFTER the caller has already been authorized to create the
 * project. Re-asserting there would be both redundant and wrong — the
 * assertions are written for a user action, not a system-initiated link.
 */
@Injectable()
export class HierarchyProjectLinkRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** True when the workspace is a Group (team), not a personal workspace. */
  async isTeamWorkspace(workspaceId: string): Promise<boolean> {
    const result = await this.databaseService.query<{ exists: boolean }>(
      `SELECT TRUE AS exists FROM orgs.workspaces WHERE id = $1 AND kind = 'team' LIMIT 1;`,
      [workspaceId],
    );
    return result.rows.length > 0;
  }

  /** Existing hierarchy repository id for this project, if already linked. */
  async findLinkedRepositoryId(projectId: string): Promise<string | null> {
    const result = await this.databaseService.query<{ id: string }>(
      `SELECT id FROM hierarchy.repositories WHERE provisioned_project_id = $1 LIMIT 1;`,
      [projectId],
    );
    return result.rows[0]?.id ?? null;
  }

  /**
   * Creates system -> delivery project -> repository for `projectId` and
   * returns the repository id.
   *
   * The whole chain is one transaction: a half-built tree (a system with no
   * repository) would show up in the group UI as an empty phantom project.
   * ON CONFLICT DO NOTHING on the final insert makes a concurrent double-link
   * lose harmlessly rather than violating the UNIQUE constraint — the second
   * caller re-reads the winner's row.
   */
  async link(input: LinkProjectInput): Promise<string | null> {
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const system = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.systems (group_id, name, owner_id, status)
            VALUES ($1, $2, $3, 'active')
            RETURNING id;
          `,
          [input.workspaceId, input.name, input.createdBy],
        );
        const systemId = system.rows[0]?.id;
        if (!systemId) throw new Error('System insert returned no row');

        const deliveryProject = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.delivery_projects (system_id, group_id, name, manager_id, status)
            VALUES ($1, $2, $3, $4, 'active')
            RETURNING id;
          `,
          [systemId, input.workspaceId, input.name, input.createdBy],
        );
        const deliveryProjectId = deliveryProject.rows[0]?.id;
        if (!deliveryProjectId) {
          throw new Error('Delivery project insert returned no row');
        }

        const repository = await client.query<{ id: string }>(
          `
            INSERT INTO hierarchy.repositories (
              delivery_project_id, group_id, name, repo_full_name,
              visibility, created_by, status, provisioned_project_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (provisioned_project_id) DO NOTHING
            RETURNING id;
          `,
          [
            deliveryProjectId,
            input.workspaceId,
            input.name,
            input.repoFullName,
            input.visibility,
            input.createdBy,
            input.projectStatus === 'provisioned' ? 'active' : 'pending',
            input.projectId,
          ],
        );

        const repositoryId = repository.rows[0]?.id;
        if (!repositoryId) {
          // Another writer linked this project first. Roll back our redundant
          // system/delivery-project rows rather than leaving them orphaned.
          await client.query('ROLLBACK');
          return null;
        }

        await client.query('COMMIT');
        return repositoryId;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}
