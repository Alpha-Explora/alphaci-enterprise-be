import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { PlatformAdminsRepository } from '../admin/platform-admins.repository';
import type { AssignmentsRepository } from './assignments/assignments.repository';
import type { DeliveryProjectsRepository } from './delivery-projects/delivery-projects.repository';
import type { GroupsRepository } from './groups/groups.repository';
import { HierarchyAccessService } from './hierarchy-access.service';
import type { RepositoriesRepository } from './repositories/repositories.repository';
import type { SystemsRepository } from './systems/systems.repository';

describe('HierarchyAccessService', () => {
  const groupsRepository = {
    findActiveMembership: jest.fn(),
    findGroupById: jest.fn(),
  } as unknown as jest.Mocked<GroupsRepository>;
  const systemsRepository = {
    findGroupIdForSystem: jest.fn(),
  } as unknown as jest.Mocked<SystemsRepository>;
  const deliveryProjectsRepository = {
    findGroupIdForDeliveryProject: jest.fn(),
  } as unknown as jest.Mocked<DeliveryProjectsRepository>;
  const repositoriesRepository = {
    findGroupIdForRepository: jest.fn(),
    findById: jest.fn(),
  } as unknown as jest.Mocked<RepositoriesRepository>;
  const assignmentsRepository = {
    findActiveForUserAndRepository: jest.fn(),
  } as unknown as jest.Mocked<AssignmentsRepository>;
  const platformAdminsRepository = {
    findRole: jest.fn(),
    findAppRole: jest.fn().mockResolvedValue('member'),
  } as unknown as jest.Mocked<PlatformAdminsRepository>;

  let service: HierarchyAccessService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new HierarchyAccessService(
      groupsRepository,
      systemsRepository,
      deliveryProjectsRepository,
      repositoriesRepository,
      assignmentsRepository,
      platformAdminsRepository,
    );
  });

  describe('assertGroupRole', () => {
    it('allows an owner to manage the group', async () => {
      groupsRepository.findActiveMembership.mockResolvedValue({
        workspaceId: 'group-1',
        userId: 'user-1',
        role: 'admin',
        memberId: 'member-1',
      });

      await expect(
        service.assertGroupRole('group-1', 'user-1', ['admin', 'delegated_lead']),
      ).resolves.toMatchObject({ role: 'admin' });
    });

    it('returns 403 (never a silent pass-through) when a developer calls an owner/admin-only action', async () => {
      groupsRepository.findActiveMembership.mockResolvedValue({
        workspaceId: 'group-1',
        userId: 'user-1',
        role: 'member',
        memberId: 'member-1',
      });

      await expect(
        service.assertGroupRole('group-1', 'user-1', ['admin', 'delegated_lead']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 — not 403 — for a caller who is not a member at all (existence-hiding, plan §2.0)', async () => {
      groupsRepository.findActiveMembership.mockResolvedValue(null);

      await expect(
        service.assertGroupRole('group-1', 'user-1', ['viewer']),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a viewer is blocked from a developer-or-higher action', async () => {
      groupsRepository.findActiveMembership.mockResolvedValue({
        workspaceId: 'group-1',
        userId: 'user-1',
        role: 'viewer',
        memberId: 'member-1',
      });

      await expect(
        service.assertGroupRole('group-1', 'user-1', [
          'admin',
          'delegated_lead',
          'member',
        ]),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertGroupManagerOrPlatformAdmin', () => {
    it('lets a platform admin bypass group membership entirely', async () => {
      platformAdminsRepository.findRole.mockResolvedValue('admin');
      groupsRepository.findGroupById.mockResolvedValue({
        id: 'group-1',
        name: 'Group',
        description: null,
        businessUnit: null,
        status: 'active',
        archivedAt: null,
        archivedBy: null,
        createdAt: '2026-01-01T00:00:00Z',
        memberCount: 1,
        systemCount: 0,
      });

      const result = await service.assertGroupManagerOrPlatformAdmin(
        'group-1',
        'admin-user',
      );
      expect(result.viaPlatformAdmin).toBe(true);
      expect(groupsRepository.findActiveMembership).not.toHaveBeenCalled();
    });

    it('404s for a platform admin when the group truly does not exist', async () => {
      platformAdminsRepository.findRole.mockResolvedValue('admin');
      groupsRepository.findGroupById.mockResolvedValue(null);

      await expect(
        service.assertGroupManagerOrPlatformAdmin(
          'missing-group',
          'admin-user',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('falls back to ordinary group-role checks for a non-platform-admin', async () => {
      platformAdminsRepository.findRole.mockResolvedValue(null);
      groupsRepository.findActiveMembership.mockResolvedValue({
        workspaceId: 'group-1',
        userId: 'user-1',
        role: 'member',
        memberId: 'member-1',
      });

      await expect(
        service.assertGroupManagerOrPlatformAdmin('group-1', 'user-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('assertActiveRepositoryAssignment — the single developer-facing choke point', () => {
    it('throws 404 when the repository does not exist (never leaks non-existence via 403)', async () => {
      repositoriesRepository.findById.mockResolvedValue(null);

      await expect(
        service.assertActiveRepositoryAssignment('repo-1', 'dev-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        assignmentsRepository.findActiveForUserAndRepository,
      ).not.toHaveBeenCalled();
    });

    it('throws 404 (identical to non-existence) when the repository exists but the caller has no active assignment', async () => {
      repositoriesRepository.findById.mockResolvedValue({
        id: 'repo-1',
        deliveryProjectId: 'dp-1',
        groupId: 'group-1',
        name: 'payments-api',
        repoFullName: 'acme/payments-api',
        githubRepoId: null,
        visibility: 'private',
        createdBy: 'pm-1',
        status: 'active',
        archivedAt: null,
        provisionedProjectId: 'pp-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        assignmentCount: 0,
        htmlUrl: 'https://github.com/acme/payments-api',
      });
      assignmentsRepository.findActiveForUserAndRepository.mockResolvedValue(
        null,
      );

      await expect(
        service.assertActiveRepositoryAssignment('repo-1', 'dev-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolves the assignment for a developer with a verified active grant', async () => {
      repositoriesRepository.findById.mockResolvedValue({
        id: 'repo-1',
        deliveryProjectId: 'dp-1',
        groupId: 'group-1',
        name: 'payments-api',
        repoFullName: 'acme/payments-api',
        githubRepoId: null,
        visibility: 'private',
        createdBy: 'pm-1',
        status: 'active',
        archivedAt: null,
        provisionedProjectId: 'pp-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        assignmentCount: 0,
        htmlUrl: 'https://github.com/acme/payments-api',
      });
      const assignment = {
        id: 'assignment-1',
        repositoryId: 'repo-1',
        userId: 'dev-1',
        accessLevel: 'write' as const,
        desiredState: 'assigned' as const,
        effectiveState: 'active' as const,
        status: 'active' as const,
        assignedBy: 'pm-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      assignmentsRepository.findActiveForUserAndRepository.mockResolvedValue(
        assignment,
      );

      await expect(
        service.assertActiveRepositoryAssignment('repo-1', 'dev-1'),
      ).resolves.toEqual(assignment);
    });

    it('404s when the repository is archived even if an assignment row exists (never active-repo bypass)', async () => {
      repositoriesRepository.findById.mockResolvedValue({
        id: 'repo-1',
        deliveryProjectId: 'dp-1',
        groupId: 'group-1',
        name: 'payments-api',
        repoFullName: 'acme/payments-api',
        githubRepoId: null,
        visibility: 'private',
        createdBy: 'pm-1',
        status: 'archived',
        archivedAt: '2026-01-02T00:00:00Z',
        provisionedProjectId: 'pp-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        assignmentCount: 0,
        htmlUrl: 'https://github.com/acme/payments-api',
      });

      await expect(
        service.assertActiveRepositoryAssignment('repo-1', 'dev-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        assignmentsRepository.findActiveForUserAndRepository,
      ).not.toHaveBeenCalled();
    });
  });
});
