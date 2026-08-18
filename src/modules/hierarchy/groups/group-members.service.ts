import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventsService } from '../../audit/audit-events.service';
import { HierarchyAccessService } from '../hierarchy-access.service';
import { HIERARCHY_EVENT_CODES, type GrantableRole } from '../hierarchy.types';
import { GroupsRepository, type GroupMemberRecord } from './groups.repository';

/**
 * Adding people to a group.
 *
 * Membership is granted DIRECTLY by a group lead — there is no invitation,
 * no pending state, and nothing for the recipient to accept. The person is a
 * member the moment the lead adds them (product decision 2026-08-18, replacing
 * the previous invite/accept/decline flow).
 *
 * The person must already have an AlphaCI account in the approved internal
 * directory. That gate is unchanged: a GitHub org member who has never signed
 * in has no row to attach a membership to, so they must sign in once first.
 */
@Injectable()
export class GroupMembersService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly auditEventsService: AuditEventsService,
  ) {}

  async addMember(
    groupId: string,
    actorUserId: string,
    input: { userId: string; role?: GrantableRole },
  ): Promise<GroupMemberRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      actorUserId,
    );

    // Ownership only moves via transfer, so 'admin' is never grantable here —
    // the same rule the invitation flow enforced.
    const role: GrantableRole = input.role ?? 'member';

    const target = await this.groupsRepository.findInternalUserById(
      input.userId,
    );
    if (!target) {
      throw new NotFoundException(
        'User not found in the approved internal directory',
      );
    }

    const existing = await this.groupsRepository.findActiveMembership(
      groupId,
      input.userId,
    );
    if (existing) {
      throw new BadRequestException(
        'User is already an active member of this Group',
      );
    }

    await this.groupsRepository.addMemberDirect(
      groupId,
      input.userId,
      role,
      actorUserId,
    );

    // Re-read through listMembers so the response carries the same shape the
    // member table already renders (login, name, avatar, status) rather than a
    // bare membership row the UI would have to special-case.
    const members = await this.groupsRepository.listMembers(groupId);
    const member = members.find((row) => row.userId === input.userId);
    if (!member) {
      // The insert reported success but the row is not readable back — surface
      // it rather than returning a hollow object the UI would render as a
      // half-added member.
      throw new BadRequestException('Member could not be added');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId,
      eventCode: HIERARCHY_EVENT_CODES.memberAdded,
      message: `Member added with role ${role}`,
      metadata: { groupId, addedUserId: input.userId, role },
    });

    return member;
  }
}
