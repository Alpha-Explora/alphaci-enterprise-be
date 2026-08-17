import { ConfigService } from '@nestjs/config';

import type {
  AppConfig,
  GithubTeamRoleSyncMode,
} from '../../config/app.config';
import type { AuditEventsService } from '../audit/audit-events.service';
import type {
  AppRole,
  AppRoleSource,
  PlatformAdminsRepository,
} from '../admin/platform-admins.repository';
import type { GithubService } from './github.service';
import { GithubTeamRoleService } from './github-team-role.service';

const LEAD_TEAM = 'team-lead';
const DEV_TEAM = 'developers';

function makeConfigService(mode: GithubTeamRoleSyncMode): ConfigService {
  const config = {
    github: {
      enforcedOrg: 'Alpha-Explora',
      teamRoleSync: mode,
      leadTeamSlug: LEAD_TEAM,
      developerTeamSlug: DEV_TEAM,
    },
  } as unknown as AppConfig;

  return {
    getOrThrow: () => config,
  } as unknown as ConfigService;
}

/**
 * `memberships` maps team slug -> true (member) / false (not) / null
 * (unreadable — the case that must never demote anyone).
 */
function makeGithubService(memberships: Record<string, boolean | null>): {
  service: GithubService;
  getTeamMembership: jest.Mock;
} {
  const getTeamMembership = jest.fn(
    (teamSlug: string): Promise<boolean | null> =>
      Promise.resolve(memberships[teamSlug] ?? null),
  );
  const service = {
    on: jest.fn(),
    getTeamMembership,
    createInstallationAccessToken: jest.fn(() => Promise.resolve('tok')),
  } as unknown as GithubService;
  return { service, getTeamMembership };
}

function makeRepository(current: { role: AppRole; source: AppRoleSource }): {
  repository: PlatformAdminsRepository;
  setAppRole: jest.Mock;
  setAppRoleSource: jest.Mock;
} {
  const setAppRole = jest.fn(() => Promise.resolve());
  const setAppRoleSource = jest.fn(() => Promise.resolve());
  const repository = {
    findAppRoleWithSource: jest.fn(() => Promise.resolve(current)),
    findUserIdByGithubLogin: jest.fn(() => Promise.resolve('user-1')),
    setAppRole,
    setAppRoleSource,
  } as unknown as PlatformAdminsRepository;
  return { repository, setAppRole, setAppRoleSource };
}

function makeAudit(): AuditEventsService {
  return {
    recordProjectEvent: jest.fn(() => Promise.resolve()),
  } as unknown as AuditEventsService;
}

function build(options: {
  mode?: GithubTeamRoleSyncMode;
  memberships?: Record<string, boolean | null>;
  current?: { role: AppRole; source: AppRoleSource };
}) {
  const { service: githubService, getTeamMembership } = makeGithubService(
    options.memberships ?? {},
  );
  const { repository, setAppRole, setAppRoleSource } = makeRepository(
    options.current ?? { role: 'member', source: 'github_team' },
  );
  const service = new GithubTeamRoleService(
    makeConfigService(options.mode ?? 'enforce'),
    githubService,
    repository,
    makeAudit(),
  );
  return { service, setAppRole, setAppRoleSource, getTeamMembership };
}

describe('GithubTeamRoleService', () => {
  describe('resolveRoleFromTeams', () => {
    it('maps team-lead membership to lead', async () => {
      const { service } = build({ memberships: { [LEAD_TEAM]: true } });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'lead',
      );
    });

    it('maps developers membership to member', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [DEV_TEAM]: true },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'member',
      );
    });

    it('falls to member when the user is in the org but neither team', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: false, [DEV_TEAM]: false },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'member',
      );
    });

    it('returns null (unknown) when a check is unreadable and none matched', async () => {
      const { service } = build({
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: false },
      });
      await expect(
        service.resolveRoleFromTeams('ada', 'tok'),
      ).resolves.toBeNull();
    });

    it('short-circuits on a lead hit so a broken developers read cannot block promotion', async () => {
      const { service, getTeamMembership } = build({
        memberships: { [LEAD_TEAM]: true, [DEV_TEAM]: null },
      });
      await expect(service.resolveRoleFromTeams('ada', 'tok')).resolves.toBe(
        'lead',
      );
      expect(getTeamMembership).toHaveBeenCalledTimes(1);
    });
  });

  describe('syncRoleForUser safety rules', () => {
    it('does nothing unless the mode is enforce', async () => {
      for (const mode of ['off', 'seed'] as GithubTeamRoleSyncMode[]) {
        const { service, setAppRole } = build({
          mode,
          memberships: { [LEAD_TEAM]: true },
        });
        await expect(
          service.syncRoleForUser({
            userId: 'user-1',
            login: 'ada',
            token: 'tok',
            trigger: 'test',
          }),
        ).resolves.toEqual({ status: 'disabled' });
        expect(setAppRole).not.toHaveBeenCalled();
      }
    });

    it('never touches a user pinned to manual', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'member', source: 'manual' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'pinned', role: 'member' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('leaves the role untouched when GitHub is unreadable', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: null, [DEV_TEAM]: null },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'unknown' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('never auto-downgrades an admin', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: false, [DEV_TEAM]: true },
        current: { role: 'admin', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'test',
        }),
      ).resolves.toEqual({ status: 'unchanged', role: 'admin' });
      expect(setAppRole).not.toHaveBeenCalled();
    });

    it('promotes a developer added to team-lead', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'member', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'member', to: 'lead' });
      expect(setAppRole).toHaveBeenCalledWith('user-1', 'lead', 'github_team');
    });

    it('demotes a lead removed from team-lead — the security-relevant direction', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: false, [DEV_TEAM]: true },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'webhook:membership',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'lead', to: 'member' });
      expect(setAppRole).toHaveBeenCalledWith(
        'user-1',
        'member',
        'github_team',
      );
    });

    it('treats an org owner as admin without reading teams', async () => {
      const { service, setAppRole, getTeamMembership } = build({
        current: { role: 'member', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          isOrgOwner: true,
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'updated', from: 'member', to: 'admin' });
      expect(getTeamMembership).not.toHaveBeenCalled();
      expect(setAppRole).toHaveBeenCalledWith('user-1', 'admin', 'github_team');
    });

    it('writes nothing when the derived role already matches', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
        current: { role: 'lead', source: 'github_team' },
      });
      await expect(
        service.syncRoleForUser({
          userId: 'user-1',
          login: 'ada',
          token: 'tok',
          trigger: 'login',
        }),
      ).resolves.toEqual({ status: 'unchanged', role: 'lead' });
      expect(setAppRole).not.toHaveBeenCalled();
    });
  });

  describe('resolveSeedRole', () => {
    it('returns null when sync is off so the caller keeps legacy seeding', async () => {
      const { service } = build({
        mode: 'off',
        memberships: { [LEAD_TEAM]: true },
      });
      await expect(
        service.resolveSeedRole('ada', 'tok', false),
      ).resolves.toBeNull();
    });

    it('seeds lead from team membership under seed mode', async () => {
      const { service } = build({
        mode: 'seed',
        memberships: { [LEAD_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', false)).resolves.toBe(
        'lead',
      );
    });

    it('prefers org ownership over team membership', async () => {
      const { service } = build({
        mode: 'enforce',
        memberships: { [DEV_TEAM]: true },
      });
      await expect(service.resolveSeedRole('ada', 'tok', true)).resolves.toBe(
        'admin',
      );
    });
  });

  describe('membership webhook filtering', () => {
    it('ignores teams that are not one of the two configured role teams', async () => {
      const { service, setAppRole } = build({
        memberships: { [LEAD_TEAM]: true },
      });
      // A per-repository access team (`{repo}-developers`) must never re-role
      // anyone — granting repo access is not a promotion.
      await service.syncFromMembershipEvent({
        login: 'ada',
        installationId: 1,
      });
      expect(setAppRole).toHaveBeenCalled();
      setAppRole.mockClear();

      // Emulate the listener's slug filter via the public event contract.
      const listener = (
        service as unknown as {
          handleMembershipEvent: (event: {
            action: string;
            login: string;
            teamSlug: string;
            installationId: number;
          }) => Promise<void>;
        }
      ).handleMembershipEvent.bind(service);

      await listener({
        action: 'added',
        login: 'ada',
        teamSlug: 'some-repo-developers',
        installationId: 1,
      });
      expect(setAppRole).not.toHaveBeenCalled();
    });
  });
});
