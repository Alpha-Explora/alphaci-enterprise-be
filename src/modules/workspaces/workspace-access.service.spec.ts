import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

import { WorkspaceAccessService } from './workspace-access.service';
import type { WorkspacesRepository } from './workspaces.repository';

describe('WorkspaceAccessService', () => {
  const repository = {
    findMembership: jest.fn(),
    findProjectMembership: jest.fn(),
    countOwners: jest.fn(),
  } as unknown as jest.Mocked<WorkspacesRepository>;

  let service: WorkspaceAccessService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new WorkspaceAccessService(repository);
  });

  it('allows owners to manage members', async () => {
    repository.findMembership.mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'admin',
    });

    await expect(
      service.assertWorkspaceRole('workspace-1', 'user-1', ['admin', 'delegated_lead']),
    ).resolves.toEqual({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'admin',
    });
  });

  it('blocks developers from managing members', async () => {
    repository.findMembership.mockResolvedValue({
      workspaceId: 'workspace-1',
      userId: 'user-1',
      role: 'member',
    });

    await expect(
      service.assertWorkspaceRole('workspace-1', 'user-1', ['admin', 'delegated_lead']),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('throws not found when the user is not a workspace member', async () => {
    repository.findMembership.mockResolvedValue(null);

    await expect(
      service.assertWorkspaceRole('workspace-1', 'user-1', ['viewer']),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns null for legacy projects without workspace membership', async () => {
    repository.findProjectMembership.mockResolvedValue(null);

    await expect(
      service.assertProjectRole('project-1', 'user-1', ['viewer']),
    ).resolves.toBeNull();
  });

  it('blocks demoting the last owner', async () => {
    repository.countOwners.mockResolvedValue(1);

    await expect(
      service.assertCanChangeOwnerRole(
        'workspace-1',
        { workspaceId: 'workspace-1', userId: 'owner-1', role: 'admin' },
        'delegated_lead',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('blocks removing the last owner', async () => {
    repository.countOwners.mockResolvedValue(1);

    await expect(
      service.assertCanRemoveMember('workspace-1', {
        workspaceId: 'workspace-1',
        userId: 'owner-1',
        role: 'admin',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
