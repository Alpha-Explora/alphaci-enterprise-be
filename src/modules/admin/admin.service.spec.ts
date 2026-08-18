import { BadRequestException, ForbiddenException } from '@nestjs/common';

import { AdminService } from './admin.service';
import type { AdminRepository } from './admin.repository';
import type { AuditEventsRepository } from '../audit/audit-events.repository';
import type { FeedbackService } from '../feedback/feedback.service';
import type {
  AppRole,
  PlatformAdminsRepository,
  PlatformRole,
} from './platform-admins.repository';

const SUPER = 'super-admin-id';
const TARGET = 'target-id';

function build(options: {
  /** Platform role per user id — absent means an ordinary user. */
  platformRoles?: Record<string, PlatformRole>;
  targetAppRole?: AppRole;
}) {
  const platformRoles = options.platformRoles ?? {};
  const setAppRole = jest.fn(() => Promise.resolve());
  const setAppRoleSource = jest.fn(() => Promise.resolve());

  const platformAdminsRepository = {
    findRole: jest.fn((userId: string) =>
      Promise.resolve(platformRoles[userId] ?? null),
    ),
    findAppRole: jest.fn(() =>
      Promise.resolve(options.targetAppRole ?? 'member'),
    ),
    setAppRole,
    setAppRoleSource,
  } as unknown as PlatformAdminsRepository;

  const adminRepository = {
    findUserById: jest.fn(() => Promise.resolve({ id: TARGET })),
  } as unknown as AdminRepository;

  const service = new AdminService(
    adminRepository,
    platformAdminsRepository,
    {
      create: jest.fn(() => Promise.resolve()),
    } as unknown as AuditEventsRepository,
    {} as unknown as FeedbackService,
  );

  return { service, setAppRole, setAppRoleSource };
}

describe('AdminService role changes', () => {
  describe('setAppRole', () => {
    it('lets a super-admin move another super-admin off Admin', async () => {
      // The old rule froze a super-admin at 'admin'. It bought no safety:
      // PlatformAdminGuard returns on the platform role before it ever reads
      // app_role, so Console access survives the change.
      const { service, setAppRole } = build({
        platformRoles: { [SUPER]: 'super_admin', [TARGET]: 'super_admin' },
        targetAppRole: 'admin',
      });

      await service.setAppRole(SUPER, TARGET, 'lead');
      expect(setAppRole).toHaveBeenCalledWith(TARGET, 'lead');
    });

    it('still reserves Admin-tier changes for the super-admin', async () => {
      const { service, setAppRole } = build({
        platformRoles: { 'plain-admin': 'admin' },
        targetAppRole: 'admin',
      });

      await expect(
        service.setAppRole('plain-admin', TARGET, 'member'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('still blocks an admin stripping their own Admin role', async () => {
      const { service, setAppRole } = build({
        platformRoles: { [SUPER]: 'super_admin' },
        targetAppRole: 'admin',
      });

      await expect(
        service.setAppRole(SUPER, SUPER, 'member'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('lets a regular admin shuffle the lower tiers', async () => {
      const { service, setAppRole } = build({
        platformRoles: { 'plain-admin': 'admin' },
        targetAppRole: 'member',
      });

      await service.setAppRole('plain-admin', TARGET, 'lead');
      expect(setAppRole).toHaveBeenCalledWith(TARGET, 'lead');
    });
  });

  describe('resetAppRoleToGithub', () => {
    it('lets a super-admin be unpinned so GitHub teams drive their role', async () => {
      const { service, setAppRoleSource } = build({
        platformRoles: { [SUPER]: 'super_admin', [TARGET]: 'super_admin' },
        targetAppRole: 'lead',
      });

      await service.resetAppRoleToGithub(SUPER, TARGET);
      expect(setAppRoleSource).toHaveBeenCalledWith(TARGET, 'github_team');
    });

    it('still reserves unpinning an Admin for the super-admin', async () => {
      const { service, setAppRoleSource } = build({
        platformRoles: { 'plain-admin': 'admin' },
        targetAppRole: 'admin',
      });

      await expect(
        service.resetAppRoleToGithub('plain-admin', TARGET),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(setAppRoleSource).not.toHaveBeenCalled();
    });
  });
});
