import { Injectable, Logger } from '@nestjs/common';

import { HierarchyProjectLinkRepository } from './hierarchy-project-link.repository';

export interface EnsureProjectLinkInput {
  projectId: string;
  workspaceId: string | null;
  /** service_name, falling back to the repo name. */
  name: string;
  repoFullName: string;
  visibility?: string | null;
  createdBy: string;
  projectStatus: string;
}

/**
 * Gives a GROUP-owned provisioned project its hierarchy.repositories row, so
 * developers can be assigned to it and the GitHub team sync has something to
 * hang off.
 *
 * Without this, only repositories created through the create-system path are
 * assignable: form-created projects have no hierarchy row, and
 * hierarchy.repository_assignments references hierarchy.repositories.
 *
 * Best-effort by design. Provisioning a project is a long, multi-step,
 * partially-irreversible operation (GitHub repo, branches, secrets, workflow
 * commit) that has already succeeded by the time this runs. Failing the whole
 * request because a secondary bookkeeping row could not be written would turn
 * a working project into a reported failure — and the compensation path would
 * then delete a perfectly good repository. Failures are logged; the migration
 * backfill and a re-link are the recovery paths.
 */
@Injectable()
export class HierarchyProjectLinkService {
  private readonly logger = new Logger(HierarchyProjectLinkService.name);

  constructor(private readonly repository: HierarchyProjectLinkRepository) {}

  /**
   * Read-only lookup of an ALREADY-linked hierarchy repository id.
   *
   * The assignment UI lives on hierarchy.repositories, but every other surface
   * addresses a project by its provisioned_projects id. This is the one hop
   * between them, so the project page can offer a route into the assignment
   * panel. Returns null when the project has no link (personal workspace, or
   * created before the link existed) — the caller then hides the entry point
   * rather than offering a URL that would 404. Never throws.
   */
  async getLinkedRepositoryId(projectId: string): Promise<string | null> {
    try {
      return await this.repository.findLinkedRepositoryId(projectId);
    } catch (error) {
      this.logger.warn(
        `Could not resolve the hierarchy link for project ${projectId}: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Returns the hierarchy repository id, or null when no link was needed or
   * possible. Never throws.
   */
  async ensureLink(input: EnsureProjectLinkInput): Promise<string | null> {
    // Personal workspace (or none) — there is no hierarchy tree to attach to,
    // and inventing one would put private work inside a group structure.
    if (!input.workspaceId) return null;

    try {
      if (!(await this.repository.isTeamWorkspace(input.workspaceId))) {
        return null;
      }

      const existing = await this.repository.findLinkedRepositoryId(
        input.projectId,
      );
      if (existing) return existing;

      const name = input.name.trim() || input.repoFullName.split('/').at(-1);
      if (!name) return null;

      return await this.repository.link({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        name,
        repoFullName: input.repoFullName,
        visibility: input.visibility === 'public' ? 'public' : 'private',
        createdBy: input.createdBy,
        projectStatus: input.projectStatus,
      });
    } catch (error) {
      this.logger.warn(
        `Could not link project ${input.projectId} into the hierarchy: ${
          error instanceof Error ? error.message : JSON.stringify(error)
        }`,
      );
      return null;
    }
  }
}
