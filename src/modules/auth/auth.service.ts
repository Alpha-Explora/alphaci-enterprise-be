import { randomInt, randomUUID } from 'node:crypto';

import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { AppConfig } from '../../config/app.config';
import type { SessionUser } from '../../common/interfaces/session-user.interface';
import { GithubTeamRoleService } from '../github/github-team-role.service';
import { OAuthStateRepository } from '../persistence/oauth-state.repository';
import { OutboxRepository } from '../persistence/outbox.repository';
import { SubscriptionsRepository } from '../persistence/subscriptions.repository';
import { UsersRepository } from '../persistence/users.repository';

interface GitHubTokenResponse {
  access_token?: string;
  error?: string;
}

interface GitHubUserResponse {
  id: number;
  login: string;
  name?: string;
  avatar_url?: string;
  email?: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

interface GitHubNormalizedUser {
  githubUserId: string;
  login: string;
  name?: string;
  avatarUrl?: string;
  email?: string;
}

/** Discriminated union returned by resolveAccountState. */
type AccountState =
  | { kind: 'active' | 'new'; user: SessionUser; accessToken: string }
  | {
      kind: 'archived';
      profile: GitHubNormalizedUser;
      accessToken: string;
      isInternal: boolean | null;
    }
  | {
      // The internal deployment (GITHUB_INTERNAL_ORG set) rejects sign-ins from
      // users who are not members of the company org. No session is created.
      //  - 'not_member': GitHub confirmed (404) the user is not an active
      //    member of the org.
      //  - 'invitation_pending': GitHub confirmed the user has been INVITED to
      //    the org but has not accepted the invitation yet. Denied, but the
      //    remedy is on the user (accept the invite), not the administrator —
      //    telling them to "ask to be added" would send them in a circle.
      //  - 'verification_failed': GitHub membership could not be confirmed
      //    (403, 5xx, network error) — denied fail-closed, but this is NOT the
      //    same as a confirmed non-member and should not tell the user to ask
      //    to be added to the org.
      kind: 'unauthorized';
      login: string;
      reason: 'not_member' | 'invitation_pending' | 'verification_failed';
    };

/** Result of checking GitHub org membership for the internal gate. */
type OrgMembershipCheck =
  | 'member'
  | 'not_member'
  | 'invitation_pending'
  | 'verification_failed';

export interface PendingAccountInfo {
  pending: true;
  login: string;
  archivedAt: string;
  purgeAt: string;
  retentionDays: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly config: AppConfig;
  private readonly returnToOrigins: Set<string>;
  private readonly returnToOriginPatterns: RegExp[];

  constructor(
    private readonly configService: ConfigService,
    private readonly usersRepository: UsersRepository,
    private readonly subscriptionsRepository: SubscriptionsRepository,
    private readonly outboxRepository: OutboxRepository,
    private readonly oauthStateRepository: OAuthStateRepository,
    private readonly githubTeamRoleService: GithubTeamRoleService,
  ) {
    this.config = this.configService.getOrThrow<AppConfig>('app');
    this.returnToOrigins = this.buildReturnToOrigins(
      this.config.frontendUrl,
      this.configService.get<string>('ALLOWED_ORIGINS'),
    );
    // The OAuth returnTo allow-list must mirror the CORS allow-list
    // (security.config.ts). CORS honors ALLOWED_ORIGIN_PATTERNS so that Vercel
    // preview deployments (e.g. https://cicd-workflow-<hash>.vercel.app) can
    // call the API; the post-login redirect must honor the SAME patterns or it
    // silently falls back to FRONTEND_URL and strands the user on the wrong
    // (often stale) frontend deployment.
    this.returnToOriginPatterns = this.buildReturnToOriginPatterns(
      this.configService.get<string>('ALLOWED_ORIGIN_PATTERNS'),
    );
  }

  async startGitHubAuth(request: Request, returnTo?: string): Promise<string> {
    const safeReturnTo = this.normalizeReturnTo(returnTo);

    if (!this.hasGitHubCredentials()) {
      return this.withQuery(safeReturnTo, 'auth', 'unavailable');
    }

    try {
      const state = randomUUID();

      // Store OAuth state in DB — eliminates the session cookie dependency for
      // state verification. The cookie race condition on cold starts is moot
      // because state lives in Supabase, not the session store.
      await this.oauthStateRepository.save(state, safeReturnTo, 'github');

      // Probabilistic cleanup: prune expired rows on ~5% of login starts.
      // This keeps the table lean without adding a cron dependency. The prune
      // is fire-and-forget (errors are caught inside pruneExpired) so it never
      // blocks or fails the login flow.
      if (randomInt(100) < 5) {
        void this.oauthStateRepository.pruneExpired();
      }

      return this.buildGitHubAuthorizationUrl(state);
    } catch (err) {
      this.logger.error(
        `OAuth start failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return this.withQuery(safeReturnTo, 'auth', 'failed');
    }
  }

  async handleGitHubCallback(
    request: Request,
    code?: string,
    state?: string,
  ): Promise<string> {
    return this.handleOAuthProviderCallback(request, code, state);
  }

  /**
   * Archive the authenticated user's account (soft-delete). All child data is
   * preserved via ON DELETE CASCADE being irrelevant here — FK children remain.
   * The session is destroyed after archiving so the user cannot continue using
   * a now-archived account.
   */
  async deleteAccount(request: Request): Promise<void> {
    const userId = request.session.userId ?? request.session.user?.id;
    if (!userId) {
      return;
    }

    // Soft-delete: set archived_at so the row is hidden but recoverable.
    // All child FK rows (projects, subscriptions, etc.) are preserved.
    await this.usersRepository.archiveById(userId);

    // Destroy session after archiving so we don't leave a dangling session
    // pointing at a now-archived user.
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        resolve();
      });
    });
  }

  async logout(request: Request): Promise<void> {
    delete request.session.githubAccessToken;
    await new Promise<void>((resolve, reject) => {
      request.session.destroy((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        resolve();
      });
    });
  }

  async getSessionUser(request: Request): Promise<SessionUser | null> {
    if (request.session.user) {
      return request.session.user;
    }

    if (!request.session.userId) {
      return null;
    }

    const user = await this.usersRepository.findById(request.session.userId);
    if (user) {
      request.session.user = user;
      request.session.userId = user.id;
    }

    return user;
  }

  async completeOnboarding(request: Request): Promise<void> {
    const user = await this.getSessionUser(request);
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }
    await this.usersRepository.markOnboardingComplete(user.id);
    // Keep the live session object in sync so a subsequent /auth/me call
    // (which may read from request.session.user without a DB round-trip)
    // immediately reflects the completed state.
    if (request.session.user) {
      request.session.user.onboardingCompleted = true;
    }
    await this.saveSession(request);
  }

  /**
   * GET /auth/account/pending
   *
   * Returns information about the archived account that triggered the
   * archived_choice redirect, so the FE can display restore/start-fresh UI.
   * No authentication required — the user is not logged in at this point.
   */
  async getPendingArchivedAccount(
    request: Request,
  ): Promise<PendingAccountInfo | { pending: false }> {
    const pending = request.session.pendingArchived;
    if (!pending) {
      return { pending: false };
    }

    const row = await this.usersRepository.findByGithubUserIdIncludingArchived(
      pending.githubUserId,
    );

    // The row must still be archived (user might have used another tab to
    // restore already). Fall back gracefully.
    const archivedAt = row?.archivedAt ?? null;
    if (!archivedAt) {
      return { pending: false };
    }

    const retentionDays = this.config.archivedAccountRetentionDays;
    const archivedDate = new Date(archivedAt);
    const purgeAt = new Date(archivedDate);
    purgeAt.setDate(purgeAt.getDate() + retentionDays);

    return {
      pending: true,
      login: pending.login,
      archivedAt,
      purgeAt: purgeAt.toISOString(),
      retentionDays,
    };
  }

  /**
   * POST /auth/account/restore
   *
   * Clears archived_at on the pending user's row and establishes a full
   * authenticated session. The pendingArchived payload is cleared afterwards.
   */
  async restoreArchivedAccount(request: Request): Promise<void> {
    const pending = request.session.pendingArchived;
    if (!pending) {
      throw new UnauthorizedException(
        'No pending archived account in this session',
      );
    }

    const restoredUser = await this.usersRepository.restoreByGithubUserId(
      pending.githubUserId,
      pending.isInternal,
    );

    await this.establishSession(request, restoredUser);
    request.session.githubAccessToken = pending.accessToken;
    delete request.session.pendingArchived;

    await this.saveSession(request);
  }

  /**
   * POST /auth/account/start-fresh
   *
   * Hard-deletes the old archived row (cascade removes children), then inserts
   * a brand-new active row via upsertGitHubUser (no conflict possible since
   * the old row is gone). Sets up a default free subscription and establishes
   * the session as if the user were signing up for the first time.
   */
  async startFreshAccount(request: Request): Promise<void> {
    const pending = request.session.pendingArchived;
    if (!pending) {
      throw new UnauthorizedException(
        'No pending archived account in this session',
      );
    }

    // Permanently remove the archived row; ON DELETE CASCADE handles children.
    await this.usersRepository.hardDeleteByGithubUserId(pending.githubUserId);

    // Insert a fresh row — no conflict because the old row is gone.
    // onboarding_completed_at is NULL by default so the new account will
    // correctly be directed through the onboarding flow again.
    const newUser = await this.usersRepository.upsertGitHubUser({
      githubUserId: pending.githubUserId,
      login: pending.login,
      ...(pending.name !== undefined && { name: pending.name }),
      ...(pending.email !== undefined && { email: pending.email }),
      ...(pending.avatarUrl !== undefined && { avatarUrl: pending.avatarUrl }),
      isInternal: pending.isInternal,
    });

    await this.subscriptionsRepository.ensureDefaultFreeSubscription(
      newUser.id,
    );
    await this.establishSession(request, newUser);
    request.session.githubAccessToken = pending.accessToken;
    delete request.session.pendingArchived;

    await this.saveSession(request);
  }

  private async handleOAuthProviderCallback(
    request: Request,
    code?: string,
    state?: string,
  ): Promise<string> {
    // Safe fallback used if the DB state lookup itself fails (e.g. transient
    // connection error). Must be defined before the try so the catch can use it.
    const fallbackReturnTo = `${this.config.frontendUrl}/auth/callback`;

    try {
      // Look up and atomically delete the state record from DB.
      // This is the authoritative source — session state is no longer consulted.
      // NOTE: kept inside the outer try so that a transient DB error here produces
      // an auth=failed redirect instead of an unhandled 500.
      const oauthRecord =
        code && state
          ? await this.oauthStateRepository.findAndDelete(state)
          : null;

      // When the state record is missing/expired we have no stored returnTo. Default
      // to the callback page (not the site root) so the FE renders the invalid_state
      // error instead of silently dropping the user on the marketing homepage.
      const returnTo = oauthRecord?.returnTo ?? fallbackReturnTo;

      const isInvalidState =
        !code || !state || oauthRecord?.provider !== 'github';

      if (isInvalidState) {
        return this.withQuery(returnTo, 'auth', 'invalid_state');
      }

      if (!this.hasGitHubCredentials()) {
        return this.withQuery(returnTo, 'auth', 'unavailable');
      }

      const accountState = await this.resolveAccountState(code);

      if (accountState.kind === 'unauthorized') {
        // Internal deployment gate rejected this sign-in. No session, no DB
        // write. The reason maps to a distinct auth= code so the FE can tell
        // a confirmed non-member, a pending invitation, and an unverifiable
        // membership check apart (see AccountState's 'unauthorized' comment)
        // instead of always telling the user to "ask to be added to the org".
        this.logger.warn(
          `Blocked sign-in for "${accountState.login}" (GITHUB_INTERNAL_ORG gate, reason: ${accountState.reason}).`,
        );
        const authCodeByReason = {
          not_member: 'not_authorized',
          invitation_pending: 'org_invite_pending',
          verification_failed: 'org_verification_failed',
        } as const;
        let redirect = this.withQuery(
          returnTo,
          'auth',
          authCodeByReason[accountState.reason],
        );
        if (accountState.reason === 'invitation_pending') {
          // The org login lets the FE link straight to GitHub's invitation
          // acceptance page (github.com/orgs/{org}/invitation). Public info.
          redirect = this.withQuery(
            redirect,
            'org',
            this.config.github.internalOrg,
          );
        }
        return redirect;
      }

      if (accountState.kind === 'archived') {
        // User previously archived their account. Stash a pending-choice
        // payload in the session so the FE can present restore/start-fresh.
        // Do NOT set userId or session.user — the user is NOT authenticated.
        const { profile, accessToken, isInternal } = accountState;
        request.session.pendingArchived = {
          githubUserId: profile.githubUserId,
          login: profile.login,
          ...(profile.name !== undefined && { name: profile.name }),
          ...(profile.email !== undefined && { email: profile.email }),
          ...(profile.avatarUrl !== undefined && {
            avatarUrl: profile.avatarUrl,
          }),
          accessToken,
          isInternal,
        };

        await this.saveSession(request);

        return this.withQuery(returnTo, 'auth', 'archived_choice');
      }

      // Active or new account — establish a full authenticated session.
      const { user: persistedUser, accessToken } = accountState;
      await this.subscriptionsRepository.ensureDefaultFreeSubscription(
        persistedUser.id,
      );
      await this.establishSession(request, persistedUser);
      request.session.githubAccessToken = accessToken;
      // Persist the access token to the store. `session.regenerate()` inside
      // `establishSession` saves userId + user, but subsequent writes to
      // `request.session` after the regenerate promise resolves are NOT
      // automatically flushed with `resave: false`. An explicit save is
      // required to guarantee the token reaches the session store before we
      // redirect the browser.
      await this.saveSession(request);

      await this.outboxRepository.publishLater({
        topic: 'user.signed_in',
        aggregateType: 'user',
        aggregateId: persistedUser.id,
        payload: {
          provider: 'github',
          login: persistedUser.login,
        },
      });

      return this.withQuery(returnTo, 'auth', 'success');
    } catch (err) {
      this.logger.error(
        `OAuth callback failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err.stack : undefined,
      );
      return this.withQuery(fallbackReturnTo, 'auth', 'failed');
    }
  }

  /**
   * Promisified `request.session.save()`. express-session uses a node-style
   * callback; this wraps it so callers can `await` and so the error-normalizing
   * boilerplate lives in exactly one place.
   */
  private saveSession(request: Request): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      request.session.save((err) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Exchange the OAuth code for a GitHub token, fetch the user profile, then
   * determine whether this is an active user, a new user, or an archived user.
   *
   * Returns a discriminated union so handleOAuthProviderCallback can branch
   * cleanly without duplicating token-exchange or profile-fetch logic.
   */
  private async resolveAccountState(code: string): Promise<AccountState> {
    const accessToken = await this.exchangeCodeForGitHubToken(code);
    const profile = await this.fetchGitHubUser(accessToken);

    // Internal-org membership handling:
    //  - Internal deployment (GITHUB_INTERNAL_ORG set): verify membership and
    //    authoritatively persist the boolean (self-heals on join/leave).
    //  - Sold deployment (unset): pass null so the persisted flag is preserved
    //    for existing users (an employee's internal status is not clobbered by
    //    logging into the customer product) and defaults to false for new rows.
    const internalGatingEnabled = Boolean(this.config.github.internalOrg);
    let isInternal: boolean | null = null;
    if (internalGatingEnabled) {
      const membership = await this.checkInternalOrgMembership(accessToken);

      // Hard-block: non-members (confirmed or unverifiable) may not sign in on
      // the internal deployment. Rejected before any session is established
      // and before any DB write. Both failure modes deny access, but they are
      // NOT the same situation — see AccountState's 'unauthorized' comment —
      // so the reason is threaded through to produce an accurate message.
      if (membership !== 'member') {
        return {
          kind: 'unauthorized',
          login: profile.login,
          reason: membership,
        };
      }
      isInternal = true;
    }

    const existing =
      await this.usersRepository.findByGithubUserIdIncludingArchived(
        profile.githubUserId,
      );

    if (existing && existing.archivedAt !== null) {
      // Archived — do not upsert; return enough info to build pendingArchived.
      return { kind: 'archived', profile, accessToken, isInternal };
    }

    // Seed the GLOBAL hierarchy role (identity.app_users.app_role) for brand-new
    // users only — a returning user's role is settled below, either by the team
    // sync (GITHUB_TEAM_ROLE_SYNC='enforce') or not at all.
    //
    // Org ownership is resolved first because it outranks team membership in
    // both modes: an owner is always 'admin'.
    const isOrgOwner = existing
      ? false
      : (await this.resolveSeedAppRoleFromOrgOwnership(accessToken)) ===
        'admin';

    const seedAppRole = existing
      ? null
      : ((await this.githubTeamRoleService.resolveSeedRole(
          profile.login,
          accessToken,
          isOrgOwner,
        )) ??
        // Sync off, or GitHub unreadable — fall back to the legacy
        // ownership-only seed so behaviour is unchanged when the feature is
        // disabled.
        (isOrgOwner ? 'admin' : 'member'));

    // Active or new — upsertGitHubUser handles both paths:
    // - no existing row: INSERT (new user, seeded app_role applied).
    // - existing active row: UPDATE last_login_at + profile fields (app_role kept).
    const user = await this.usersRepository.upsertGitHubUser({
      ...profile,
      isInternal,
      seedAppRole,
    });

    // Returning users: re-derive app_role from GitHub team membership so a
    // promotion to `team-lead` (or removal from it) takes effect on next
    // sign-in. No-ops unless GITHUB_TEAM_ROLE_SYNC='enforce', and skips users
    // pinned to app_role_source='manual'. Failures here must never block a
    // login — the user keeps whatever role they already had.
    if (existing) {
      try {
        await this.githubTeamRoleService.syncRoleForUser({
          userId: user.id,
          login: profile.login,
          token: accessToken,
          trigger: 'login',
        });
      } catch (error) {
        this.logger.warn(
          `Team role sync failed for ${profile.login} at login: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const kind = existing ? 'active' : 'new';
    return { kind, user, accessToken };
  }

  /**
   * Determines the first-login GLOBAL role from the user's membership role in
   * the enforced org (Alpha-Explora), via GET /user/memberships/orgs/{org}.
   * GitHub reports an ORG OWNER as role 'admin' and any other member as 'member'
   * (this `role` is distinct from the `state` field the internal-org gate reads).
   *
   *   org owner (role 'admin')  → 'admin'  (full system access)
   *   anything else / unverifiable → 'member'  (fail-safe default)
   *
   * Fail-safe on purpose: a missing read:org scope, an OAuth-App-restricted org,
   * a non-owner, or any network/HTTP error all resolve to 'member' so we never
   * grant admin without a positive confirmation of ownership.
   */
  private async resolveSeedAppRoleFromOrgOwnership(
    accessToken: string,
  ): Promise<'admin' | 'member'> {
    const org = this.config.github.enforcedOrg?.trim();
    if (!org) {
      return 'member';
    }

    try {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (!response.ok) {
        this.logger.log(
          `Org ownership check for "${org}" returned ${String(response.status)}; seeding role 'member'.`,
        );
        return 'member';
      }

      const payload = (await response.json()) as {
        state?: string;
        role?: string;
      };
      // Only an ACTIVE owner is elevated. A 'pending' invite or a plain member
      // is a 'member' at seed time; ownership granted later can be reflected via
      // the Admin Console (the seed is first-login only, by design).
      if (payload.state === 'active' && payload.role === 'admin') {
        this.logger.log(
          `New user is an owner of "${org}"; seeding global role 'admin'.`,
        );
        return 'admin';
      }
      return 'member';
    } catch (err) {
      this.logger.warn(
        `Org ownership check for "${org}" failed: ${err instanceof Error ? err.message : String(err)}; seeding role 'member'.`,
      );
      return 'member';
    }
  }

  /**
   * Checks whether the OAuth-authenticated user is an active member of the
   * configured internal org (GITHUB_INTERNAL_ORG), using the user's own token
   * against GET /user/memberships/orgs/{org}. Returns a multi-state result
   * rather than a boolean because "not a member", "invited but not accepted",
   * and "could not verify" are different situations that call for different
   * operator/user messaging, even though all deny access (fail-closed):
   *   - 200 + state 'active'  → 'member'
   *   - 200 + state 'pending' → 'invitation_pending' (invited, must accept
   *                             the invitation on GitHub before signing in)
   *   - 404                   → 'not_member' (confirmed non-member)
   *   - anything else (403/5xx) or a network error → 'verification_failed'
   *     (e.g. missing read:org scope, or the org has OAuth App access
   *     restrictions and has not approved this app)
   */
  private async checkInternalOrgMembership(
    accessToken: string,
  ): Promise<OrgMembershipCheck> {
    const org = this.config.github.internalOrg;
    if (!org) {
      return 'not_member';
    }

    try {
      const response = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 404) {
        this.logger.log(
          `Org membership check: "${org}" returned 404 (confirmed non-member or unaccepted invite).`,
        );
        return 'not_member';
      }

      if (!response.ok) {
        this.logger.warn(
          `Org membership check for "${org}" returned ${String(response.status)}; could not verify, denying access. ` +
            'Common causes: the OAuth token is missing the read:org scope, or the GitHub org has "OAuth App access restrictions" enabled and has not approved this app.',
        );
        return 'verification_failed';
      }

      const payload = (await response.json()) as { state?: string };
      if (payload.state === 'active') {
        return 'member';
      }
      // GET /user/memberships/orgs/{org} returns 200 with state 'pending' for
      // a user who was invited but has not accepted the invitation yet. This
      // is the most common "I was added but can't log in" situation, so it is
      // surfaced distinctly instead of being folded into 'not_member'.
      if (payload.state === 'pending') {
        this.logger.log(
          `Org membership check: "${org}" invitation is pending acceptance.`,
        );
        return 'invitation_pending';
      }
      this.logger.log(
        `Org membership check: "${org}" returned state "${payload.state ?? 'unknown'}"; treating as non-member.`,
      );
      return 'not_member';
    } catch (err) {
      this.logger.warn(
        `Org membership check for "${org}" failed: ${err instanceof Error ? err.message : String(err)}; could not verify, denying access.`,
      );
      return 'verification_failed';
    }
  }

  private buildGitHubAuthorizationUrl(state: string): string {
    const authorizationUrl = new URL(
      'https://github.com/login/oauth/authorize',
    );
    authorizationUrl.searchParams.set('client_id', this.config.github.clientId);
    authorizationUrl.searchParams.set(
      'redirect_uri',
      this.config.github.callbackUrl,
    );
    authorizationUrl.searchParams.set('scope', this.config.github.scope);
    authorizationUrl.searchParams.set('state', state);

    return authorizationUrl.toString();
  }

  private async exchangeCodeForGitHubToken(code: string): Promise<string> {
    const response = await fetch(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          client_id: this.config.github.clientId,
          client_secret: this.config.github.clientSecret,
          code,
          redirect_uri: this.config.github.callbackUrl,
        }).toString(),
      },
    );

    if (!response.ok) {
      throw new Error('Failed to exchange OAuth code');
    }

    const payload = (await response.json()) as GitHubTokenResponse;
    if (!payload.access_token || payload.error) {
      throw new Error('GitHub did not return an access token');
    }

    return payload.access_token;
  }

  private async fetchGitHubUser(
    accessToken: string,
  ): Promise<GitHubNormalizedUser> {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cicd-workflow-product',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to fetch GitHub profile');
    }

    const payload = (await response.json()) as GitHubUserResponse;

    let email = payload.email;
    if (!email) {
      email = await this.fetchPrimaryEmail(accessToken);
    }

    return {
      githubUserId: String(payload.id),
      login: payload.login,
      name: payload.name ?? payload.login,
      ...(payload.avatar_url !== undefined && {
        avatarUrl: payload.avatar_url,
      }),
      ...(email !== undefined && { email }),
    };
  }

  private async fetchPrimaryEmail(
    accessToken: string,
  ): Promise<string | undefined> {
    const response = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cicd-workflow-product',
      },
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as GitHubEmail[];
    const primary =
      payload.find((item) => item.primary && item.verified) ??
      payload.find((item) => item.verified);

    return primary?.email;
  }

  private withQuery(url: string, key: string, value: string): string {
    // This runs on the OAuth *failure* path (e.g. the DB rejected our
    // credentials), so it must never throw — otherwise a handled error becomes
    // an unhandled 500. `url` derives from FRONTEND_URL, which can be
    // misconfigured per environment (e.g. missing the scheme), making
    // `new URL()` throw. Fall back to the configured frontend, then to a bare
    // relative path, so the user always lands on a real error page.
    for (const candidate of [url, this.config.frontendUrl]) {
      try {
        const parsed = new URL(candidate);
        parsed.searchParams.set(key, value);
        return parsed.toString();
      } catch {
        // try the next candidate
      }
    }

    this.logger.error(
      `withQuery: could not build a valid URL from FRONTEND_URL ("${this.config.frontendUrl}"). Check the FRONTEND_URL env var in this environment.`,
    );
    return `/?${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }

  private normalizeReturnTo(returnTo?: string): string {
    if (!returnTo) {
      return this.config.frontendUrl;
    }

    if (returnTo.startsWith('/')) {
      return `${this.config.frontendUrl}${returnTo}`;
    }

    try {
      const parsed = new URL(returnTo);

      if (this.isAllowedReturnToOrigin(parsed.origin)) {
        return parsed.toString();
      }
    } catch {
      return this.config.frontendUrl;
    }

    return this.config.frontendUrl;
  }

  /**
   * Mirror of the CORS allow-list logic (security.config.ts): an origin is
   * allowed if it is an exact match OR — for HTTPS origins only — matches one of
   * the configured ALLOWED_ORIGIN_PATTERNS. Plain-HTTP origins can never match a
   * pattern, so preview-URL patterns cannot be abused to redirect to http://.
   */
  private isAllowedReturnToOrigin(origin: string): boolean {
    if (this.returnToOrigins.has(origin)) {
      return true;
    }

    if (origin.startsWith('https://')) {
      return this.returnToOriginPatterns.some((re) => re.test(origin));
    }

    return false;
  }

  private buildReturnToOrigins(
    frontendUrl: string,
    allowedOrigins?: string,
  ): Set<string> {
    const origins = new Set<string>();
    this.addReturnToOrigin(origins, frontendUrl);

    for (const origin of (allowedOrigins ?? '').split(',')) {
      this.addReturnToOrigin(origins, origin);
    }

    return origins;
  }

  /**
   * Compile ALLOWED_ORIGIN_PATTERNS into anchored RegExps. Invalid patterns are
   * silently skipped (env validation owns operator feedback), matching the
   * behavior of corsOptions() in security.config.ts so the two allow-lists stay
   * byte-for-byte consistent.
   */
  private buildReturnToOriginPatterns(allowedPatterns?: string): RegExp[] {
    return (allowedPatterns ?? '')
      .split(',')
      .map((pattern) => pattern.trim())
      .filter((pattern) => pattern.length > 0)
      .flatMap((pattern) => {
        try {
          return [new RegExp(`^${pattern}$`)];
        } catch {
          return [];
        }
      });
  }

  private addReturnToOrigin(origins: Set<string>, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      // Ignore malformed origins; env validation owns operator feedback.
    }
  }

  private async establishSession(
    request: Request,
    user: SessionUser,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      request.session.regenerate((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }

        request.session.userId = user.id;
        request.session.user = user;
        delete request.session.oauthState;
        delete request.session.oauthReturnTo;
        delete request.session.oauthProvider;
        delete request.session.pendingArchived;
        resolve();
      });
    });
  }

  private hasGitHubCredentials(): boolean {
    return Boolean(
      this.config.github.clientId && this.config.github.clientSecret,
    );
  }
}
