import { BadRequestException, ForbiddenException } from '@nestjs/common';

import type { AuditEventsService } from '../../audit/audit-events.service';
import type { PlatformAdminsRepository } from '../../admin/platform-admins.repository';
import type { AssignmentsRepository } from '../assignments/assignments.repository';
import type { DeliveryProjectsRepository } from '../delivery-projects/delivery-projects.repository';
import type { GithubService } from '../../github/github.service';
import type { GithubSyncService } from '../github-sync/github-sync.service';
import { HierarchyAccessService } from '../hierarchy-access.service';
import type { RepositoriesRepository } from '../repositories/repositories.repository';
import type { SystemsRepository } from '../systems/systems.repository';
import { GroupsRepository, type GroupMemberRecord } from './groups.repository';
import { GroupsService } from './groups.service';

const owner: GroupMemberRecord = {
  id: 'member-owner',
  groupId: 'group-1',
  userId: 'owner-1',
  role: 'admin',
  memberStatus: 'active',
  login: 'owner-one',
  name: 'Owner One',
  email: null,
  avatarUrl: null,
  invitedBy: null,
  invitedAt: null,
  removedAt: null,
  removedBy: null,
  removalReason: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const developer: GroupMemberRecord = {
  id: 'member-dev',
  groupId: 'group-1',
  userId: 'dev-1',
  role: 'member',
  memberStatus: 'active',
  login: 'dev-one',
  name: 'Dev One',
  email: null,
  avatarUrl: null,
  invitedBy: null,
  invitedAt: null,
  removedAt: null,
  removedBy: null,
  removalReason: null,
  createdAt: '2026-01-01T00:00:00Z',
};

describe('GroupsService — role enforcement (hard constraint: developer -> 403 on management endpoints)', () => {
  let groupsRepository: jest.Mocked<GroupsRepository>;
  let accessService: HierarchyAccessService;
  let assignmentsRepository: jest.Mocked<AssignmentsRepository>;
  let githubSyncService: jest.Mocked<GithubSyncService>;
  let auditEventsService: jest.Mocked<AuditEventsService>;
  let service: GroupsService;

  beforeEach(() => {
    groupsRepository = {
      createGroup: jest.fn(),
      findActiveMembership: jest.fn(),
      findGroupById: jest.fn(),
      updateGroup: jest.fn(),
      setArchiveStatus: jest.fn(),
      findMemberById: jest.fn(),
      countActiveOwners: jest.fn(),
      updateMemberRole: jest.fn(),
      markMemberRemoved: jest.fn(),
      changeMemberRoleGuarded: jest.fn(),
      removeMemberGuarded: jest.fn(),
      listMembers: jest.fn(),
    } as unknown as jest.Mocked<GroupsRepository>;

    const platformAdminsRepository = {
      findRole: jest.fn().mockResolvedValue(null),
      findAppRole: jest.fn().mockResolvedValue('member'),
    } as unknown as jest.Mocked<PlatformAdminsRepository>;

    accessService = new HierarchyAccessService(
      groupsRepository,
      {} as unknown as SystemsRepository,
      {} as unknown as DeliveryProjectsRepository,
      {} as unknown as RepositoriesRepository,
      {} as unknown as AssignmentsRepository,
      platformAdminsRepository,
    );

    assignmentsRepository = {
      listAssignedByUserWithinGroup: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<AssignmentsRepository>;
    githubSyncService = {
      requestRevoke: jest.fn(),
    } as unknown as jest.Mocked<GithubSyncService>;
    auditEventsService = {
      record: jest.fn(),
      recordProjectEvent: jest.fn(),
    } as unknown as jest.Mocked<AuditEventsService>;
    const githubService = {
      listOrganizationMembers: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<GithubService>;

    service = new GroupsService(
      groupsRepository,
      accessService,
      assignmentsRepository,
      githubSyncService,
      githubService,
      auditEventsService,
    );
  });

  it('blocks a developer from updating group settings with 403', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'dev-1',
      role: 'member',
      memberId: developer.id,
    });

    await expect(
      service.updateGroup('group-1', 'dev-1', { name: 'New name' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(groupsRepository.updateGroup).not.toHaveBeenCalled();
  });

  it('blocks a developer from archiving a group with 403', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'dev-1',
      role: 'member',
      memberId: developer.id,
    });

    await expect(
      service.archiveGroup('group-1', 'dev-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks an admin (delegated manager) from archiving — only owner or platform admin may archive', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'admin-1',
      role: 'delegated_lead',
      memberId: 'member-admin',
    });

    await expect(
      service.archiveGroup('group-1', 'admin-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('blocks a developer from removing a group member with 403', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'dev-1',
      role: 'member',
      memberId: developer.id,
    });

    await expect(
      service.removeMember('group-1', 'dev-1', 'member-owner'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('allows an owner to update group settings', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.updateGroup.mockResolvedValue({
      id: 'group-1',
      name: 'New name',
      description: null,
      businessUnit: null,
      status: 'active',
      archivedAt: null,
      archivedBy: null,
      createdAt: '2026-01-01T00:00:00Z',
      memberCount: 1,
      systemCount: 0,
    });

    await expect(
      service.updateGroup('group-1', 'owner-1', { name: 'New name' }),
    ).resolves.toMatchObject({ name: 'New name' });
  });

  it('refuses to remove the last remaining owner (BadRequestException)', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.findMemberById.mockResolvedValue(owner);
    groupsRepository.removeMemberGuarded.mockResolvedValue({
      member: owner,
      blockedLastOwner: true,
    });

    await expect(
      service.removeMember('group-1', 'owner-1', 'member-owner'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(groupsRepository.markMemberRemoved).not.toHaveBeenCalled();
  });

  it('refuses to demote the last remaining owner via role change (BadRequestException, race-free guard)', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.findMemberById.mockResolvedValue(owner);
    groupsRepository.changeMemberRoleGuarded.mockResolvedValue({
      member: owner,
      blockedLastOwner: true,
    });

    await expect(
      service.updateMemberRole('group-1', 'owner-1', 'member-owner', {
        role: 'delegated_lead',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(groupsRepository.updateMemberRole).not.toHaveBeenCalled();
  });

  it('allows an owner to change a non-owner member role when other owners remain', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.findMemberById.mockResolvedValue(developer);
    groupsRepository.changeMemberRoleGuarded.mockResolvedValue({
      member: { ...developer, role: 'delegated_lead' },
      blockedLastOwner: false,
    });

    await expect(
      service.updateMemberRole('group-1', 'owner-1', 'member-dev', {
        role: 'delegated_lead',
      }),
    ).resolves.toMatchObject({ role: 'delegated_lead' });
    expect(groupsRepository.changeMemberRoleGuarded).toHaveBeenCalledWith(
      'group-1',
      'member-dev',
      'delegated_lead',
    );
  });

  it('allows an owner (Admin) to promote a member directly to Admin (co-lead)', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.findMemberById.mockResolvedValue(developer);
    groupsRepository.changeMemberRoleGuarded.mockResolvedValue({
      member: { ...developer, role: 'admin' },
      blockedLastOwner: false,
    });

    await expect(
      service.updateMemberRole('group-1', 'owner-1', 'member-dev', {
        role: 'admin',
      }),
    ).resolves.toMatchObject({ role: 'admin' });
    expect(groupsRepository.changeMemberRoleGuarded).toHaveBeenCalledWith(
      'group-1',
      'member-dev',
      'admin',
    );
  });

  it('blocks a delegated lead from granting the Admin role', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'delegated-1',
      role: 'delegated_lead',
      memberId: 'member-delegated',
    });
    groupsRepository.findMemberById.mockResolvedValue(developer);

    await expect(
      service.updateMemberRole('group-1', 'delegated-1', 'member-dev', {
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(groupsRepository.changeMemberRoleGuarded).not.toHaveBeenCalled();
  });

  it('cascades a revoke job for every active assignment the removed member holds in the group (plan §2.4/§9)', async () => {
    groupsRepository.findActiveMembership.mockResolvedValue({
      workspaceId: 'group-1',
      userId: 'owner-1',
      role: 'admin',
      memberId: owner.id,
    });
    groupsRepository.findMemberById.mockResolvedValue(developer);
    groupsRepository.removeMemberGuarded.mockResolvedValue({
      member: { ...developer, memberStatus: 'removed' },
      blockedLastOwner: false,
    });
    assignmentsRepository.listAssignedByUserWithinGroup.mockResolvedValue([
      {
        id: 'assignment-1',
        repositoryId: 'repo-1',
        userId: 'dev-1',
        accessLevel: 'write',
        desiredState: 'assigned',
        effectiveState: 'active',
        status: 'active',
        assignedBy: 'owner-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'assignment-2',
        repositoryId: 'repo-2',
        userId: 'dev-1',
        accessLevel: 'write',
        desiredState: 'assigned',
        effectiveState: 'pending',
        status: 'pending',
        assignedBy: 'owner-1',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);

    await service.removeMember(
      'group-1',
      'owner-1',
      'member-dev',
      'offboarded',
    );

    expect(githubSyncService.requestRevoke).toHaveBeenCalledTimes(2);
    expect(githubSyncService.requestRevoke).toHaveBeenCalledWith(
      'assignment-1',
      'owner-1',
    );
    expect(githubSyncService.requestRevoke).toHaveBeenCalledWith(
      'assignment-2',
      'owner-1',
    );
  });

  /* ── Group creation authorization ─────────────────────────────────────────
     Untested until now, and it is the only gate on creating a group. The
     controller previously layered an is_internal check on top, which blocked
     every role on a deployment with GITHUB_INTERNAL_ORG unset — nothing there
     can ever set the flag. These pin the policy so the role check stays the
     only one, and so re-adding a second gate breaks a test rather than a
     first-run install. */

  const created = {
    id: 'group-new',
    name: 'Team Blaine',
  } as unknown as Awaited<ReturnType<GroupsRepository['createGroup']>>;

  it.each(['admin', 'lead'] as const)(
    'lets a global %s create a group',
    async (appRole) => {
      jest.spyOn(accessService, 'getAppRole').mockResolvedValue(appRole);
      jest.spyOn(accessService, 'isPlatformAdmin').mockResolvedValue(false);
      groupsRepository.createGroup.mockResolvedValue(created);

      await expect(
        service.createGroup('user-1', { name: 'Team Blaine' }),
      ).resolves.toMatchObject({ id: 'group-new', role: 'admin' });

      expect(groupsRepository.createGroup).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Team Blaine',
          creatorUserId: 'user-1',
        }),
      );
    },
  );

  it('blocks a global member from creating a group with 403', async () => {
    jest.spyOn(accessService, 'getAppRole').mockResolvedValue('member');
    jest.spyOn(accessService, 'isPlatformAdmin').mockResolvedValue(false);

    await expect(
      service.createGroup('user-1', { name: 'Team Blaine' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(groupsRepository.createGroup).not.toHaveBeenCalled();
  });

  it('lets a platform admin create a group despite a member app_role', async () => {
    jest.spyOn(accessService, 'getAppRole').mockResolvedValue('member');
    jest.spyOn(accessService, 'isPlatformAdmin').mockResolvedValue(true);
    groupsRepository.createGroup.mockResolvedValue(created);

    await expect(
      service.createGroup('user-1', { name: 'Team Blaine' }),
    ).resolves.toMatchObject({ id: 'group-new', role: 'admin' });
  });

  it('does not consult is_internal when authorizing creation', async () => {
    // The regression guard. A brand-new user row after a database rebuild has
    // is_internal=false and no way to change it, so anything reading that flag
    // here locks out the very admin who has to create the first group.
    jest.spyOn(accessService, 'getAppRole').mockResolvedValue('admin');
    jest.spyOn(accessService, 'isPlatformAdmin').mockResolvedValue(false);
    groupsRepository.createGroup.mockResolvedValue(created);

    await expect(
      service.createGroup('internal-false-user', { name: 'Team Blaine' }),
    ).resolves.toMatchObject({ id: 'group-new', role: 'admin' });
  });
});
