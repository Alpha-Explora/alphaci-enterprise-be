import { ForbiddenException } from '@nestjs/common';

import { GroupsService } from './groups.service';
import { HierarchyAccessService } from '../hierarchy-access.service';
import type { GroupsRepository } from './groups.repository';
import type { AuditEventsService } from '../../audit/audit-events.service';
import type { GithubSyncService } from '../github-sync/github-sync.service';
import type { GithubService } from '../../github/github.service';
import type { AssignmentsRepository } from '../assignments/assignments.repository';

const WORKSPACE = 'workspace-1';
const USER = 'user-1';

function makeAccess(overrides: Partial<HierarchyAccessService> = {}) {
  return {
    getAppRole: jest.fn().mockResolvedValue('lead'),
    isPlatformAdmin: jest.fn().mockResolvedValue(false),
    assertGroupRole: jest.fn().mockResolvedValue({}),
    assertGroupMembership: jest.fn().mockResolvedValue({}),
    assertCanCreateTeamInWorkspace: jest.fn().mockResolvedValue(undefined),
    assertGroupManagerOrPlatformAdmin: jest
      .fn()
      .mockResolvedValue({ viaPlatformAdmin: false, membership: {} }),
    ...overrides,
  } as unknown as HierarchyAccessService;
}

function makeService(options: {
  access?: HierarchyAccessService;
  repository?: Partial<GroupsRepository>;
}) {
  const repository = {
    createGroup: jest.fn().mockResolvedValue({
      id: 'team-1',
      name: 'Team',
      description: null,
      businessUnit: null,
      status: 'active',
      archivedAt: null,
      archivedBy: null,
      createdAt: 'now',
      memberCount: 1,
      systemCount: 0,
    }),
    listTeamsForWorkspace: jest.fn().mockResolvedValue([]),
    countTeams: jest.fn().mockResolvedValue(0),
    findGroupById: jest.fn().mockResolvedValue({ id: WORKSPACE, name: 'WS' }),
    deleteGroup: jest.fn().mockResolvedValue(true),
    findParentWorkspaceId: jest.fn().mockResolvedValue(null),
    ...options.repository,
  } as unknown as GroupsRepository;

  const service = new GroupsService(
    repository,
    options.access ?? makeAccess(),
    {
      listActiveForGroup: jest.fn().mockResolvedValue([]),
    } as unknown as AssignmentsRepository,
    { requestRevoke: jest.fn() } as unknown as GithubSyncService,
    {
      listOrganizationMembers: jest.fn().mockResolvedValue([]),
    } as unknown as GithubService,
    {
      recordProjectEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as AuditEventsService,
  );
  return { service, repository };
}

describe('workspace / team nesting', () => {
  describe('creating a team', () => {
    it('requires manager rights on the target workspace, not just the global tier', async () => {
      const access = makeAccess({
        assertCanCreateTeamInWorkspace: jest
          .fn()
          .mockRejectedValue(new ForbiddenException()),
      } as Partial<HierarchyAccessService>);
      const { service, repository } = makeService({ access });

      await expect(
        service.createGroup(USER, {
          name: 'Team',
          parentWorkspaceId: WORKSPACE,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.createGroup).not.toHaveBeenCalled();
    });

    it('passes the parent through so the row is stored as a team', async () => {
      const { service, repository } = makeService({});

      await service.createGroup(USER, {
        name: 'Team',
        parentWorkspaceId: WORKSPACE,
      });

      expect(repository.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ parentWorkspaceId: WORKSPACE }),
      );
    });

    it('creates a top-level workspace when no parent is given', async () => {
      const { service, repository } = makeService({});

      await service.createGroup(USER, { name: 'Workspace' });

      expect(repository.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({ parentWorkspaceId: null }),
      );
    });

    it('refuses a plain member creating a top-level workspace', async () => {
      const access = makeAccess({
        getAppRole: jest.fn().mockResolvedValue('member'),
      } as Partial<HierarchyAccessService>);
      const { service, repository } = makeService({ access });

      await expect(
        service.createGroup(USER, { name: 'Workspace' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.createGroup).not.toHaveBeenCalled();
    });
  });

  describe('deleting a workspace', () => {
    it('is blocked while it still holds teams', async () => {
      // Cascading would destroy several teams' membership from one click, and
      // the raw FK violation underneath is not a sentence anyone can act on.
      const { service, repository } = makeService({
        repository: { countTeams: jest.fn().mockResolvedValue(2) },
      });

      await expect(service.deleteGroup(WORKSPACE, USER)).rejects.toThrow(
        /still contains 2 teams/,
      );
      expect(repository.deleteGroup).not.toHaveBeenCalled();
    });

    it('goes ahead when it holds none', async () => {
      const { service, repository } = makeService({});
      await expect(service.deleteGroup(WORKSPACE, USER)).resolves.toEqual({
        id: WORKSPACE,
        deleted: true,
      });
      expect(repository.deleteGroup).toHaveBeenCalledWith(WORKSPACE);
    });
  });
});
