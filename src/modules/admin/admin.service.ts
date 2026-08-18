import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditEventsRepository } from '../audit/audit-events.repository';
import { FeedbackService } from '../feedback/feedback.service';
import type {
  FeedbackRecord,
  FeedbackStatus,
} from '../feedback/feedback.repository';
import { AdminRepository, type ListUsersOptions } from './admin.repository';
import {
  PlatformAdminsRepository,
  type AppRole,
  type PlatformAdminRecord,
  type PlatformRole,
} from './platform-admins.repository';
import {
  toAdminUserDetail,
  toAdminUserListItem,
  type AdminUserDetail,
  type AdminUserListItem,
} from './admin-user.view';

const DEFAULT_PAGE_SIZE = 25;

export interface AdminUsersPage {
  items: AdminUserListItem[];
  total: number;
  limit: number;
  offset: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly adminRepository: AdminRepository,
    private readonly platformAdminsRepository: PlatformAdminsRepository,
    private readonly auditEventsRepository: AuditEventsRepository,
    private readonly feedbackService: FeedbackService,
  ) {}

  async listUsers(
    actorId: string,
    query: {
      search?: string | undefined;
      limit?: number | undefined;
      offset?: number | undefined;
    },
  ): Promise<AdminUsersPage> {
    const options: ListUsersOptions = {
      limit: query.limit ?? DEFAULT_PAGE_SIZE,
      offset: query.offset ?? 0,
      ...(query.search !== undefined && { search: query.search }),
    };

    const [rows, total] = await Promise.all([
      this.adminRepository.listUsers(options),
      this.adminRepository.countUsers(options.search),
    ]);

    await this.audit(actorId, 'admin.users.listed', 'Admin listed users', {
      search: options.search ?? null,
      returned: rows.length,
    });

    return {
      items: rows.map(toAdminUserListItem),
      total,
      limit: options.limit,
      offset: options.offset,
    };
  }

  async getUserDetail(
    actorId: string,
    targetUserId: string,
  ): Promise<AdminUserDetail> {
    const row = await this.adminRepository.findUserById(targetUserId);
    if (!row) {
      throw new NotFoundException('User not found');
    }

    const [subscription, projects, workflows, recentErrors, recentActivity] =
      await Promise.all([
        this.adminRepository.findUserSubscription(targetUserId),
        this.adminRepository.listUserProjects(targetUserId),
        this.adminRepository.listUserWorkflows(targetUserId),
        this.adminRepository.listUserErrors(targetUserId, 25),
        this.adminRepository.listUserActivity(targetUserId, 25),
      ]);

    await this.audit(actorId, 'admin.user.viewed', 'Admin viewed user detail', {
      targetUserId,
    });

    return toAdminUserDetail(row, {
      subscription,
      projects,
      workflows,
      recentErrors,
      recentActivity,
    });
  }

  async getUserErrors(actorId: string, targetUserId: string) {
    const exists = await this.adminRepository.findUserById(targetUserId);
    if (!exists) {
      throw new NotFoundException('User not found');
    }
    const errors = await this.adminRepository.listUserErrors(targetUserId, 100);
    await this.audit(
      actorId,
      'admin.user.errors_viewed',
      'Admin viewed user errors',
      { targetUserId, count: errors.length },
    );
    return { items: errors };
  }

  async listAdmins(): Promise<PlatformAdminRecord[]> {
    return this.platformAdminsRepository.list();
  }

  async grantRole(
    actorId: string,
    targetUserId: string,
    role: PlatformRole,
  ): Promise<void> {
    if (actorId === targetUserId) {
      throw new BadRequestException('You cannot change your own platform role');
    }
    const target = await this.adminRepository.findUserById(targetUserId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    await this.platformAdminsRepository.grant(targetUserId, role, actorId);
    await this.audit(
      actorId,
      'admin.role.granted',
      'Admin granted platform role',
      {
        targetUserId,
        role,
      },
    );
  }

  async revokeRole(actorId: string, targetUserId: string): Promise<void> {
    if (actorId === targetUserId) {
      throw new BadRequestException('You cannot revoke your own platform role');
    }
    const role = await this.platformAdminsRepository.findRole(targetUserId);
    if (role === null) {
      throw new NotFoundException('User is not a platform admin');
    }
    if (role === 'super_admin') {
      const superAdmins =
        await this.platformAdminsRepository.countSuperAdmins();
      if (superAdmins <= 1) {
        throw new BadRequestException(
          'Cannot revoke the last remaining super-admin',
        );
      }
    }

    await this.platformAdminsRepository.revoke(targetUserId);
    await this.audit(
      actorId,
      'admin.role.revoked',
      'Admin revoked platform role',
      {
        targetUserId,
      },
    );
  }

  /**
   * Sets a user's GLOBAL hierarchy role (Admin / Lead / Member) — the single
   * place roles are assigned. An admin cannot strip their own Admin role
   * (self-lockout guard).
   */
  async setAppRole(
    actorId: string,
    targetUserId: string,
    role: AppRole,
  ): Promise<void> {
    if (actorId === targetUserId && role !== 'admin') {
      throw new BadRequestException('You cannot remove your own Admin role');
    }
    const target = await this.adminRepository.findUserById(targetUserId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    // Admin-tier authorization (product decision 2026-07-14):
    //  - Promoting someone TO Admin, or demoting someone FROM Admin, is
    //    reserved for the super-admin. A regular Admin may still shuffle the
    //    lower Lead/Member tiers but cannot mint or unmake other Admins.
    //
    // A super-admin's app_role is NO LONGER frozen at 'admin' (2026-08-18).
    // That rule existed to stop the last Console holder locking everyone out,
    // but PlatformAdminGuard checks the platform role FIRST and returns before
    // it ever reads app_role — so the identity.platform_admins row, not
    // app_role, is what guarantees access. Freezing app_role therefore bought
    // no safety and only prevented a super-admin from also being an ordinary
    // Team lead in the hierarchy. The admin-tier gate below still applies, so
    // moving a super-admin off 'admin' remains a super-admin-only action.
    const [actorPlatformRole, targetCurrentRole] = await Promise.all([
      this.platformAdminsRepository.findRole(actorId),
      this.platformAdminsRepository.findAppRole(targetUserId),
    ]);

    const involvesAdminTier = role === 'admin' || targetCurrentRole === 'admin';
    if (involvesAdminTier && actorPlatformRole !== 'super_admin') {
      throw new ForbiddenException(
        'Only the super-admin can change Admin-level roles.',
      );
    }

    // Pins the user to app_role_source='manual' (the repository default), so a
    // later login or membership webhook cannot silently undo this decision.
    // Undone by resetAppRoleToGithub below.
    await this.platformAdminsRepository.setAppRole(targetUserId, role);
    await this.audit(actorId, 'admin.app_role.set', 'Admin set global role', {
      targetUserId,
      role,
      pinned: true,
    });
  }

  /**
   * Unpins a user so GitHub org team membership drives their role again.
   *
   * The role itself is left as-is until the next login or membership webhook
   * re-derives it: this endpoint has no GitHub token of its own, and inventing
   * one here would duplicate the resolution logic that already lives in
   * GithubTeamRoleService. Same authorization rules as setAppRole — unpinning
   * an Admin is an Admin-tier change and is therefore super-admin only, since
   * it can lead to that Admin being demoted on their next sign-in.
   */
  async resetAppRoleToGithub(
    actorId: string,
    targetUserId: string,
  ): Promise<void> {
    const target = await this.adminRepository.findUserById(targetUserId);
    if (!target) {
      throw new NotFoundException('User not found');
    }

    const [actorPlatformRole, targetCurrentRole] = await Promise.all([
      this.platformAdminsRepository.findRole(actorId),
      this.platformAdminsRepository.findAppRole(targetUserId),
    ]);

    if (targetCurrentRole === 'admin' && actorPlatformRole !== 'super_admin') {
      throw new ForbiddenException(
        'Only the super-admin can change Admin-level roles.',
      );
    }

    await this.platformAdminsRepository.setAppRoleSource(
      targetUserId,
      'github_team',
    );
    await this.audit(
      actorId,
      'admin.app_role.reset_to_github',
      'Admin reset global role to GitHub team sync',
      { targetUserId, previousRole: targetCurrentRole },
    );
  }

  async listFeedback(
    actorId: string,
    status?: FeedbackStatus,
  ): Promise<FeedbackRecord[]> {
    const items = await this.feedbackService.listAll(status);
    await this.audit(
      actorId,
      'admin.feedback.listed',
      'Admin listed feedback',
      {
        status: status ?? null,
        returned: items.length,
      },
    );
    return items;
  }

  async triageFeedback(
    actorId: string,
    feedbackId: string,
    input: { status?: FeedbackStatus; adminResponse?: string },
  ): Promise<FeedbackRecord> {
    const updated = await this.feedbackService.triage(feedbackId, {
      respondedBy: actorId,
      ...(input.status !== undefined && { status: input.status }),
      ...(input.adminResponse !== undefined && {
        adminResponse: input.adminResponse,
      }),
    });
    await this.audit(
      actorId,
      'admin.feedback.triaged',
      'Admin triaged feedback',
      { feedbackId, status: input.status ?? null },
    );
    return updated;
  }

  async getAccessLog(actorId: string) {
    const items = await this.adminRepository.listAdminAccessLog(100);
    await this.audit(
      actorId,
      'admin.access_log.viewed',
      'Admin viewed access log',
      {},
    );
    return { items };
  }

  /**
   * Always-on audit write. Deliberately uses the repository directly (not
   * AuditEventsService, which is gated behind a feature flag) — admin access
   * auditing must never be silently disabled. Failures are swallowed so an audit
   * write never breaks the admin action itself, but they are surfaced via the
   * repository's own error path.
   */
  private async audit(
    actorUserId: string,
    eventCode: string,
    message: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditEventsRepository.create({
        actorUserId,
        eventCode,
        message,
        metadata,
      });
    } catch {
      // Intentionally non-fatal: never let an audit failure block the read.
    }
  }
}
