import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type {
  AppConfig,
  GithubTeamRoleSyncMode,
} from '../../config/app.config';
import { AuditEventsService } from '../audit/audit-events.service';
import {
  PlatformAdminsRepository,
  type AppRole,
} from '../admin/platform-admins.repository';
import {
  GithubService,
  TEAM_MEMBERSHIP_CHANGED_EVENT,
  type TeamMembershipChangedEvent,
} from './github.service';

/**
 * Outcome of a sync attempt. `unknown` is deliberately distinct from
 * `unchanged`: the first means GitHub could not be read (and nothing was
 * touched), the second means GitHub was read and already agreed.
 */
/** Sonar S6551-safe stringification of an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unknown error';
}

export type RoleSyncOutcome =
  | { status: 'disabled' }
  | { status: 'pinned'; role: AppRole }
  | { status: 'unknown' }
  | { status: 'unchanged'; role: AppRole }
  | { status: 'updated'; from: AppRole; to: AppRole };

/**
 * Derives identity.app_users.app_role from GitHub org team membership.
 *
 * Mapping (Alpha-Explora):
 *   org owner            → 'admin'   (login path only — needs the user token)
 *   member of `team-lead`   → 'lead'    (may create projects)
 *   member of `developers`  → 'member'  (assigned work only)
 *   in the org, neither team → 'member'
 *
 * Four safety rules, in priority order — every one of them exists to make a
 * GitHub outage or a permission gap harmless rather than destructive:
 *
 *  1. A user pinned to app_role_source = 'manual' is never touched.
 *  2. An UNREADABLE team check (null, not false) changes nothing. A transient
 *     403/5xx must never be read as "not a member" — that would demote the
 *     whole org on one bad response.
 *  3. An existing 'admin' is never auto-downgraded. Admin is org-owner and
 *     Console territory; the webhook path cannot even see ownership.
 *  4. Nothing happens at all unless GITHUB_TEAM_ROLE_SYNC opts in.
 */
@Injectable()
export class GithubTeamRoleService {
  private readonly logger = new Logger(GithubTeamRoleService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly githubService: GithubService,
    private readonly platformAdminsRepository: PlatformAdminsRepository,
    private readonly auditEventsService: AuditEventsService,
  ) {
    // Fire-and-forget, matching ProjectsService's repository.deleted listener:
    // handleWebhook() has already ack'd the delivery to GitHub by the time this
    // runs, so a failure is logged rather than thrown. The periodic worker
    // (Phase 4b) is the backstop for anything dropped here.
    this.githubService.on(
      TEAM_MEMBERSHIP_CHANGED_EVENT,
      (event: TeamMembershipChangedEvent) => {
        this.handleMembershipEvent(event).catch((error: unknown) => {
          this.logger.warn(
            `Failed to process membership webhook for ${event.login}: ${describeError(error)}`,
          );
        });
      },
    );
  }

  /**
   * Only the two configured role teams matter. A membership change on any
   * other org team (including the per-repository `{repo}-developers` access
   * teams this product creates itself) must not touch app_role — otherwise
   * granting someone repo access would silently re-role them.
   */
  private async handleMembershipEvent(
    event: TeamMembershipChangedEvent,
  ): Promise<void> {
    if (this.mode !== 'enforce') return;

    const { leadTeamSlug, developerTeamSlug } = this.config.github;
    const slug = event.teamSlug.toLowerCase();
    if (
      slug !== leadTeamSlug.toLowerCase() &&
      slug !== developerTeamSlug.toLowerCase()
    ) {
      return;
    }

    await this.syncFromMembershipEvent({
      login: event.login,
      installationId: event.installationId,
    });
  }

  get mode(): GithubTeamRoleSyncMode {
    return this.config.github.teamRoleSync;
  }

  get enabled(): boolean {
    return this.mode !== 'off';
  }

  /**
   * Reads both team memberships and returns the role they imply.
   *
   * Returns null when the answer is genuinely unknown — either team check came
   * back unreadable AND no positive membership was established. A positive
   * `team-lead` hit short-circuits, so a broken `developers` read can never
   * block a promotion.
   */
  async resolveRoleFromTeams(
    login: string,
    token: string,
  ): Promise<AppRole | null> {
    const { leadTeamSlug, developerTeamSlug } = this.config.github;

    const inLeadTeam = await this.githubService.getTeamMembership(
      leadTeamSlug,
      login,
      token,
    );
    if (inLeadTeam === true) return 'lead';

    const inDeveloperTeam = await this.githubService.getTeamMembership(
      developerTeamSlug,
      login,
      token,
    );
    if (inDeveloperTeam === true) return 'member';

    // Both answered "no" → the user is in the org but on neither role team.
    // 'member' is the correct floor: they can sign in and see what they are
    // assigned, but cannot create.
    if (inLeadTeam === false && inDeveloperTeam === false) return 'member';

    // At least one check was unreadable and neither was a positive hit.
    return null;
  }

  /**
   * Applies the derived role to a user, honouring every safety rule above.
   * Safe to call on any path; it no-ops unless sync is enabled.
   */
  async syncRoleForUser(input: {
    userId: string;
    login: string;
    token: string;
    /** Set at login when the user owns the enforced org — an upgrade only. */
    isOrgOwner?: boolean;
    /** Free-text provenance for the audit trail, e.g. 'login' or 'webhook'. */
    trigger: string;
  }): Promise<RoleSyncOutcome> {
    if (this.mode !== 'enforce') return { status: 'disabled' };

    const { role: currentRole, source } =
      await this.platformAdminsRepository.findAppRoleWithSource(input.userId);

    // Rule 1 — a deliberate Console decision wins until explicitly reset.
    if (source === 'manual') return { status: 'pinned', role: currentRole };

    const derived = input.isOrgOwner
      ? 'admin'
      : await this.resolveRoleFromTeams(input.login, input.token);

    // Rule 2 — unreadable means untouched.
    if (derived === null) {
      this.logger.warn(
        `Team role sync for ${input.login} (${input.trigger}): GitHub unreadable, leaving app_role='${currentRole}' unchanged.`,
      );
      return { status: 'unknown' };
    }

    // Rule 3 — never auto-downgrade an admin.
    if (currentRole === 'admin' && derived !== 'admin') {
      return { status: 'unchanged', role: currentRole };
    }

    if (derived === currentRole) return { status: 'unchanged', role: derived };

    await this.platformAdminsRepository.setAppRole(
      input.userId,
      derived,
      'github_team',
    );

    // Automatic role changes MUST be auditable — without this, a user's
    // capabilities can change with no record of why, which is undebuggable.
    await this.recordRoleChange({
      userId: input.userId,
      login: input.login,
      from: currentRole,
      to: derived,
      trigger: input.trigger,
    });

    this.logger.log(
      `Team role sync for ${input.login} (${input.trigger}): app_role ${currentRole} → ${derived}.`,
    );
    return { status: 'updated', from: currentRole, to: derived };
  }

  /**
   * Role to seed on a brand-new account. Used under both 'seed' and 'enforce';
   * returns null when sync is off or GitHub could not be read, letting the
   * caller fall back to the legacy org-ownership seed.
   */
  async resolveSeedRole(
    login: string,
    token: string,
    isOrgOwner: boolean,
  ): Promise<AppRole | null> {
    if (!this.enabled) return null;
    if (isOrgOwner) return 'admin';
    return this.resolveRoleFromTeams(login, token);
  }

  /**
   * Webhook entry point. GitHub's `membership` event carries the org
   * installation id, so we mint an installation token rather than depending on
   * the affected user having their own installation — a developer being added
   * to a team usually has none.
   */
  async syncFromMembershipEvent(input: {
    login: string;
    installationId: number;
  }): Promise<RoleSyncOutcome> {
    if (this.mode !== 'enforce') return { status: 'disabled' };

    const userId = await this.platformAdminsRepository.findUserIdByGithubLogin(
      input.login,
    );
    if (!userId) {
      // Org member who has never signed into AlphaCI — nothing to update. They
      // pick up the right role from the seed on their first login.
      return { status: 'unknown' };
    }

    let token: string;
    try {
      token = await this.githubService.createInstallationAccessToken(
        input.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Membership webhook for ${input.login}: could not mint an installation token: ${describeError(error)}`,
      );
      return { status: 'unknown' };
    }

    return this.syncRoleForUser({
      userId,
      login: input.login,
      token,
      trigger: 'webhook:membership',
    });
  }

  private async recordRoleChange(input: {
    userId: string;
    login: string;
    from: AppRole;
    to: AppRole;
    trigger: string;
  }): Promise<void> {
    // recordProjectEvent is the swallow-on-failure wrapper (its name is
    // historical — it takes any audit event). An audit write must never block
    // the role change itself.
    await this.auditEventsService.recordProjectEvent({
      actorUserId: null,
      eventCode: 'user.app_role.synced',
      message: `app_role ${input.from} → ${input.to} from GitHub teams (${input.trigger})`,
      metadata: {
        targetUserId: input.userId,
        login: input.login,
        from: input.from,
        to: input.to,
        trigger: input.trigger,
        source: 'github_team',
      },
    });
  }

  private get config(): AppConfig {
    return this.configService.getOrThrow<AppConfig>('app');
  }
}
