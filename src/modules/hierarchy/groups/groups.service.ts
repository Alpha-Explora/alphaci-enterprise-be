import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventsService } from '../../audit/audit-events.service';
import { GithubService } from '../../github/github.service';
import { AssignmentsRepository } from '../assignments/assignments.repository';
import { GithubSyncService } from '../github-sync/github-sync.service';
import { HierarchyAccessService } from '../hierarchy-access.service';
import { HIERARCHY_EVENT_CODES } from '../hierarchy.types';
import {
  GroupsRepository,
  type GroupMemberRecord,
  type GroupRecord,
  type InternalUserDirectoryEntry,
} from './groups.repository';
import type { UpdateGroupDto } from '../dto/update-group.dto';
import type { UpdateMemberRoleDto } from '../dto/update-member-role.dto';

@Injectable()
export class GroupsService {
  constructor(
    private readonly groupsRepository: GroupsRepository,
    private readonly accessService: HierarchyAccessService,
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly githubSyncService: GithubSyncService,
    private readonly githubService: GithubService,
    private readonly auditEventsService: AuditEventsService,
  ) {}

  async createGroup(
    userId: string,
    input: { name: string; description?: string; businessUnit?: string },
  ): Promise<GroupRecord> {
    // Only global Leads and Admins may create groups (Members cannot).
    const appRole = await this.accessService.getAppRole(userId);
    if (
      appRole === 'member' &&
      !(await this.accessService.isPlatformAdmin(userId))
    ) {
      throw new ForbiddenException('Only Leads and Admins can create groups');
    }

    const group = await this.groupsRepository.createGroup({
      name: input.name,
      description: input.description ?? null,
      businessUnit: input.businessUnit ?? null,
      creatorUserId: userId,
    });

    await this.auditEventsService.recordProjectEvent({
      workspaceId: group.id,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupCreated,
      message: `Group "${group.name}" created`,
      metadata: { groupId: group.id },
    });

    return { ...group, role: 'admin' };
  }

  async getMyGroups(userId: string): Promise<GroupRecord[]> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      return this.groupsRepository.listAllGroups();
    }
    return this.groupsRepository.listForUser(userId);
  }

  async getGroup(groupId: string, userId: string): Promise<GroupRecord> {
    if (await this.accessService.isPlatformAdmin(userId)) {
      const group = await this.groupsRepository.findGroupById(groupId);
      if (!group) {
        throw new NotFoundException('Group not found');
      }
      return { ...group, role: 'admin' };
    }
    const membership = await this.accessService.assertGroupMembership(
      groupId,
      userId,
    );
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    return { ...group, role: membership.role };
  }

  async updateGroup(
    groupId: string,
    userId: string,
    dto: UpdateGroupDto,
  ): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin', 'delegated_lead'],
    );
    const group = await this.groupsRepository.updateGroup(groupId, dto);
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupUpdated,
      message: `Group "${group.name}" updated`,
      metadata: { groupId, changes: dto },
    });

    return group;
  }

  async archiveGroup(groupId: string, userId: string): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.setArchiveStatus(
      groupId,
      'archived',
      userId,
    );
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupArchived,
      message: `Group "${group.name}" archived`,
      metadata: { groupId },
    });

    return group;
  }

  /**
   * Hard-deletes a Group. Restricted to the Group's top tier ('admin' = the
   * "Lead" product label) or a platform admin — the same gate archiving uses,
   * since delete is strictly more destructive. Cascades handle members /
   * invitations / systems; any provisioned repositories are detached to
   * "individual" (workspace_id → NULL), never destroyed (see
   * GroupsRepository.deleteGroup).
   */
  async deleteGroup(
    groupId: string,
    userId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    // Record the intent BEFORE the row (and its cascaded audit rows) disappear.
    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupDeleted,
      message: `Group "${group.name}" deleted`,
      metadata: { groupId, name: group.name },
    });

    const deleted = await this.groupsRepository.deleteGroup(groupId);
    if (!deleted) {
      throw new NotFoundException('Group not found');
    }

    return { id: groupId, deleted: true };
  }

  async reopenGroup(groupId: string, userId: string): Promise<GroupRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin'],
    );
    const group = await this.groupsRepository.setArchiveStatus(
      groupId,
      'active',
      userId,
    );
    if (!group) {
      throw new NotFoundException('Group not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.groupReopened,
      message: `Group "${group.name}" reopened`,
      metadata: { groupId },
    });

    return group;
  }

  /**
   * Platform-admin-only (enforced by PlatformAdminGuard at the controller).
   * Promotes newManagerUserId to owner, demotes every other current owner to
   * admin — a Group can never lose its final active manager (source plan
   * §4.4/§11).
   */
  async transferManager(
    groupId: string,
    actingUserId: string,
    newManagerUserId: string,
  ): Promise<GroupRecord> {
    const group = await this.groupsRepository.findGroupById(groupId);
    if (!group) {
      throw new NotFoundException('Group not found');
    }
    const target = await this.groupsRepository.findActiveMembership(
      groupId,
      newManagerUserId,
    );
    if (!target) {
      throw new BadRequestException(
        'The new manager must already be an active member of the Group',
      );
    }

    const transfer = await this.groupsRepository.transferLeadGuarded(
      groupId,
      newManagerUserId,
    );
    if (!transfer) {
      throw new BadRequestException(
        'The new manager must already be an active member of the Group',
      );
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: actingUserId,
      eventCode: HIERARCHY_EVENT_CODES.groupManagerTransferred,
      message: `Group lead transferred to ${newManagerUserId}`,
      metadata: {
        groupId,
        newManagerUserId,
        previousRole: transfer.previousRole,
      },
    });

    return group;
  }

  async listMembers(
    groupId: string,
    userId: string,
  ): Promise<GroupMemberRecord[]> {
    if (!(await this.accessService.isPlatformAdmin(userId))) {
      await this.accessService.assertGroupMembership(groupId, userId);
    }
    return this.groupsRepository.listMembers(groupId);
  }

  /**
   * Roster for the invite picker, sourced from the enforced GitHub
   * organization (Alpha-Explora). Every org member is returned; those without
   * an AlphaCI account are flagged `hasAccount: false` so the UI can show them
   * disabled ("hasn't signed in yet"). Members already active in the Group are
   * omitted. Falls back to the local internal directory when the org roster is
   * unavailable (stub mode / no installation token / missing Members:Read).
   */
  async searchEligibleInternalUsers(
    groupId: string,
    userId: string,
    search: string,
  ): Promise<InternalUserDirectoryEntry[]> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(groupId, userId);
    const normalized = search.trim();

    const orgMembers = await this.githubService.listOrganizationMembers(userId);
    if (orgMembers.length === 0) {
      // Graceful fallback: no org roster available (stub mode / no token /
      // missing Members:Read) — use the local account directory. An empty
      // search returns the full directory so the picker is pre-populated
      // with existing members rather than blank until the user types.
      return this.groupsRepository.searchEligibleInternalUsers(
        groupId,
        normalized,
      );
    }

    const accounts = await this.groupsRepository.findAccountsByLogins(
      groupId,
      orgMembers.map((member) => member.login),
    );
    const accountByLogin = new Map(
      accounts.map((account) => [account.login.toLowerCase(), account]),
    );
    const term = normalized.toLowerCase();

    return (
      orgMembers
        .map((member): InternalUserDirectoryEntry => {
          const account = accountByLogin.get(member.login.toLowerCase());
          return {
            id: account?.id ?? null,
            login: member.login,
            name: account?.name ?? member.login,
            email: account?.email ?? null,
            avatarUrl: account?.avatarUrl ?? member.avatarUrl,
            hasAccount: account !== undefined,
          };
        })
        // Drop people already active in this Group.
        .filter(
          (entry) =>
            !accountByLogin.get(entry.login.toLowerCase())?.isActiveMember,
        )
        // Apply the narrowing search over login + display name.
        .filter(
          (entry) =>
            term.length === 0 ||
            entry.login.toLowerCase().includes(term) ||
            (entry.name ?? '').toLowerCase().includes(term),
        )
        .slice(0, 50)
    );
  }

  async updateMemberRole(
    groupId: string,
    userId: string,
    memberId: string,
    dto: UpdateMemberRoleDto,
  ): Promise<GroupMemberRecord> {
    const { viaPlatformAdmin, membership } =
      await this.accessService.assertGroupManagerOrPlatformAdmin(
        groupId,
        userId,
        ['admin', 'delegated_lead'],
      );
    const target = await this.groupsRepository.findMemberById(
      groupId,
      memberId,
    );
    if (!target) {
      throw new NotFoundException('Member not found');
    }

    // A Lead promotes members to whichever tier they choose (Member,
    // Delegated lead, or Admin). Granting the top Admin/Lead tier is reserved
    // for an existing Admin (or a platform admin) — a Delegated lead cannot
    // mint an Admin above their own authority. The last-owner guard below
    // still prevents demoting the final Admin out of existence.
    if (
      dto.role === 'admin' &&
      !viaPlatformAdmin &&
      membership?.role !== 'admin'
    ) {
      throw new ForbiddenException(
        'Only a Group Admin can grant the Admin (Lead) role',
      );
    }

    // Race-free last-owner guard: changeMemberRoleGuarded holds a row lock
    // on every active owner of the Group for the duration of the check +
    // write, so two concurrent demotions of two different owners can no
    // longer both read "2 owners" and both proceed to zero (ciso finding,
    // plan §3.3 "last-manager protection ... race-condition safety").
    const { member: updated, blockedLastOwner } =
      await this.groupsRepository.changeMemberRoleGuarded(
        groupId,
        memberId,
        dto.role,
      );
    if (blockedLastOwner) {
      throw new BadRequestException('Group must keep at least one owner');
    }
    if (!updated) {
      throw new NotFoundException('Member not found');
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.memberRoleChanged,
      message: `Member role changed to ${dto.role}`,
      metadata: {
        groupId,
        memberId,
        targetUserId: target.userId,
        previousRole: target.role,
        newRole: dto.role,
      },
    });

    return updated;
  }

  /**
   * Offboarding event, not a hard delete. Cascades to a revoke job for every
   * active repository assignment this member holds anywhere in the Group
   * (plan §2.4, source §4/§11 "removing a member must immediately trigger
   * the repository-assignment access review").
   */
  async removeMember(
    groupId: string,
    userId: string,
    memberId: string,
    reason?: string,
  ): Promise<GroupMemberRecord> {
    await this.accessService.assertGroupManagerOrPlatformAdmin(
      groupId,
      userId,
      ['admin', 'delegated_lead'],
    );
    const target = await this.groupsRepository.findMemberById(
      groupId,
      memberId,
    );
    if (!target) {
      throw new NotFoundException('Member not found');
    }

    // Race-free last-owner guard — same locked check-then-act pattern as
    // updateMemberRole above (ciso finding, plan §3.3).
    const { member: removed, blockedLastOwner } =
      await this.groupsRepository.removeMemberGuarded(
        groupId,
        memberId,
        userId,
        reason,
      );
    if (blockedLastOwner) {
      throw new BadRequestException('Group must keep at least one owner');
    }
    if (!removed) {
      throw new NotFoundException('Member not found');
    }

    const assignments =
      await this.assignmentsRepository.listAssignedByUserWithinGroup(
        groupId,
        target.userId,
      );
    for (const assignment of assignments) {
      await this.githubSyncService.requestRevoke(assignment.id, userId);
    }

    await this.auditEventsService.recordProjectEvent({
      workspaceId: groupId,
      actorUserId: userId,
      eventCode: HIERARCHY_EVENT_CODES.memberRemoved,
      message: `Member removed from Group`,
      metadata: {
        groupId,
        memberId,
        targetUserId: target.userId,
        reason: reason ?? null,
        cascadedRevokeCount: assignments.length,
      },
    });

    return removed;
  }
}
