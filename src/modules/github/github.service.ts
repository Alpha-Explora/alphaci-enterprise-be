import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';

import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import sodium from 'libsodium-wrappers';

import type { AppConfig } from '../../config/app.config';
import { ENV_GUARD_CHECK_CONTEXT } from '../workflows/staged-workflow.builder';
import type { CreateRepoDto } from './dto/create-repo.dto';
import {
  GithubInstallationsRepository,
  type GithubInstallation,
  type GithubInstallationRepo,
} from './github-installations.repository';

interface GitHubRepoResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  default_branch: string;
  html_url: string;
  updated_at: string;
}

interface GitHubInstallationMetadataResponse {
  account?: {
    login?: string | null;
    id?: number | null;
    type?: 'Organization' | 'User' | null;
  };
  repository_selection?: 'all' | 'selected';
}

interface GitHubInstallationRepositoriesResponse {
  repositories?: Array<{ full_name?: string }>;
}

interface GitHubContentResponse {
  content?: string;
  encoding?: string;
  sha?: string;
}

interface GitHubContentsWriteResponse {
  content?: { html_url?: string };
  commit?: { sha?: string; html_url?: string };
}

interface GitHubPullRequestResponse {
  number?: number;
  html_url?: string;
}

export interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  htmlUrl: string;
  updatedAt: string;
}

export type GithubRepoDeleteErrorCode = 'missing_scope' | 'not_found' | 'other';

/**
 * Thrown by deleteRepoForUser() (never by deleteRepo(), which stays silent
 * for its compensating-transaction call sites). Carries a machine-readable
 * `code` so a user-initiated delete can surface *why* it failed instead of
 * a generic failure — in particular, distinguishing a missing `delete_repo`
 * OAuth scope (the caller should prompt the user to reconnect GitHub) from a
 * repo that's simply already gone.
 */
export class GithubRepoDeleteError extends Error {
  constructor(
    public readonly code: GithubRepoDeleteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GithubRepoDeleteError';
  }
}

/**
 * Organization every product-created repository is locked to when no
 * GITHUB_ENFORCED_ORG override is configured. This is the same default as
 * app.config.ts, duplicated here on purpose: getEnforcedOrg() falls back to it
 * directly so the org-only guarantee survives even if ConfigService is
 * unavailable or the `app` namespace failed to load. Without this, a config/DI
 * failure would make getEnforcedOrg() return '' and surface the misleading
 * "no destination org is configured" error despite the code being correct.
 */
const DEFAULT_ENFORCED_ORG = 'Alpha-Explora';

/**
 * Emitted on GithubService when a GitHub `repository` webhook reports
 * `action: 'deleted'`. ProjectsService subscribes to this in its constructor
 * to mark the matching provisioned_projects row 'orphaned' — see the
 * module-level comment on that subscription for why an event is used
 * instead of a direct repository injection (GithubModule must not import
 * ProjectsModule, which a direct ProjectsRepository/ProjectsService
 * dependency here would require).
 */
export const REPOSITORY_DELETED_EVENT = 'repository.deleted';

export interface RepositoryDeletedEvent {
  /** e.g. "Alpha-Explora/some-repo" — case-insensitive per GitHub semantics. */
  repoFullName: string;
}

/**
 * Emitted when a GitHub `membership` webhook reports someone being added to or
 * removed from an org team. GithubTeamRoleService subscribes to re-derive that
 * user's app_role immediately, so a promotion to `team-lead` — or, more
 * importantly for security, a removal from it — does not wait for their next
 * login.
 *
 * An event is used rather than a direct call because GithubTeamRoleService
 * already depends on GithubService; calling back the other way would be a
 * cycle. Same reasoning as REPOSITORY_DELETED_EVENT above.
 */
export const TEAM_MEMBERSHIP_CHANGED_EVENT = 'team.membership.changed';

export interface TeamMembershipChangedEvent {
  /** 'added' | 'removed' — GitHub's `action` on the membership event. */
  action: string;
  /** GitHub login of the affected user. */
  login: string;
  /** Slug of the team they were added to / removed from. */
  teamSlug: string;
  /** Installation id, used to mint a token for the follow-up team reads. */
  installationId: number;
}

@Injectable()
export class GithubService extends EventEmitter {
  private readonly logger = new Logger(GithubService.name);
  private readonly appId: string;
  private readonly appSlug: string;
  private readonly appPrivateKey: string;
  private readonly appWebhookSecret: string;

  // Explicit @Inject tokens are required here: the `| null` union types make
  // emitDecoratorMetadata serialize these params as `Object`, so token-less
  // injection silently resolves to undefined (with @Optional) or fails. The
  // `| null` in the type exists only so unit tests can construct the service
  // without a Nest container; at runtime both dependencies must resolve.
  constructor(
    @Inject(ConfigService)
    private readonly configService: ConfigService | null,
    @Inject(GithubInstallationsRepository)
    private readonly githubInstallationsRepository: GithubInstallationsRepository | null,
  ) {
    super();
    const config = this.configService?.get<AppConfig>('app');
    this.appId = config?.github.appId ?? '';
    this.appSlug = config?.github.appSlug?.trim() ?? '';
    this.appPrivateKey = config?.github.appPrivateKey ?? '';
    this.appWebhookSecret = config?.github.appWebhookSecret ?? '';

    // Printed once per process boot so a stale deploy (running code that
    // predates the enforced-org fallback, or a config wiring regression) is
    // visible in the Render log stream immediately — instead of only
    // surfacing when a user hits create-project and gets a 403.
    const enforcedOrg = config?.github.enforcedOrg?.trim();
    this.logger.log(
      enforcedOrg
        ? `Repository creation is enforced to organization: ${enforcedOrg}`
        : 'GITHUB ENFORCED ORG RESOLVED EMPTY AT BOOT — repository creation will be refused. Check that this deploy includes the enforced-org config fallback.',
    );
  }

  getAppInstallUrl(): string {
    const appSlug = this.getAppSlug();
    if (!appSlug) {
      throw new InternalServerErrorException(
        'GitHub App installation is not configured. Set GITHUB_APP_SLUG and restart the service.',
      );
    }
    return `https://github.com/apps/${appSlug}/installations/new`;
  }

  getAppSlug(): string {
    return (
      this.configService?.get<AppConfig>('app')?.github.appSlug?.trim() ??
      this.appSlug
    );
  }

  /**
   * Login of the org that every created repository must belong to. Never empty:
   * resolves the configured GITHUB_ENFORCED_ORG override when present, otherwise
   * falls back to DEFAULT_ENFORCED_ORG — even if ConfigService is null or the
   * `app` config namespace failed to load. Repository creation reads this so no
   * caller can ever provision into a personal account, and so the
   * "no destination org is configured" guard in createRepo() is unreachable.
   */
  getEnforcedOrg(): string {
    const configured = this.configService
      ?.get<AppConfig>('app')
      ?.github.enforcedOrg?.trim();
    return configured || DEFAULT_ENFORCED_ORG;
  }

  /**
   * Lists the login + avatar of every member of the enforced GitHub
   * organization, using the acting user's installation token. Powers the
   * Group invite picker (members list is sourced from the GitHub org, not the
   * local directory). Returns [] when no installation token is available —
   * e.g. the acting user has no installation, or the App lacks org
   * `Members: Read` — so callers can fall back gracefully rather than error.
   */
  async listOrganizationMembers(
    userId: string,
  ): Promise<Array<{ login: string; avatarUrl: string | null }>> {
    const org = this.getEnforcedOrg();
    const token = await this.getInstallationAccessTokenForUser(userId);
    if (!token) return [];

    const members: Array<{ login: string; avatarUrl: string | null }> = [];
    const maxPages = 5; // cap at 500 members — more than enough for this org
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.fetchWithRetry(
        `https://api.github.com/orgs/${org}/members?per_page=100&page=${String(page)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Could not list members for org ${org} (${String(response.status)}) — check the App has org Members:Read`,
        );
        break;
      }
      const batch = (await response.json()) as Array<{
        login: string;
        avatar_url?: string | null;
      }>;
      for (const item of batch) {
        members.push({ login: item.login, avatarUrl: item.avatar_url ?? null });
      }
      if (batch.length < 100) break;
    }
    return members;
  }

  /**
   * Whether `login` is an active member of `teamSlug` in the enforced org.
   *
   * Uses GET /orgs/{org}/teams/{team_slug}/memberships/{username}, which needs
   * either an App installation token with org `Members: Read` or a user token
   * carrying `read:org` (already in GITHUB_SCOPE).
   *
   *   200 + state 'active'  → true   (a 'pending' invite is NOT membership)
   *   404                   → false  (not a member, or team does not exist)
   *   anything else         → null   ("unknown" — the caller must NOT treat
   *                                   this as "not a member", or a transient
   *                                   403/5xx would silently demote people)
   *
   * The null-vs-false distinction is the whole safety story for role sync.
   */
  async getTeamMembership(
    teamSlug: string,
    login: string,
    token: string,
  ): Promise<boolean | null> {
    const org = this.getEnforcedOrg();
    if (!org || !teamSlug || !login) return null;

    try {
      const response = await this.fetchWithRetry(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(login)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 404) return false;
      if (!response.ok) {
        this.logger.warn(
          `Team membership check for ${login} in ${org}/${teamSlug} returned ${String(response.status)} — treating as unknown. Check the App has org Members:Read.`,
        );
        return null;
      }

      const payload = (await response.json()) as { state?: string };
      return payload.state === 'active';
    } catch (error) {
      this.logger.warn(
        `Team membership check for ${login} in ${org}/${teamSlug} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Every active member login of `teamSlug` in the enforced org, using the
   * acting user's installation token. Returns [] when no token is available or
   * the read fails, matching listOrganizationMembers' graceful-degradation
   * contract — callers reconciling roles must treat [] as "could not read"
   * rather than "the team is empty".
   */
  async listTeamMembers(userId: string, teamSlug: string): Promise<string[]> {
    const org = this.getEnforcedOrg();
    const token = await this.getInstallationAccessTokenForUser(userId);
    if (!org || !teamSlug || !token) return [];

    const logins: string[] = [];
    const maxPages = 5; // cap at 500 members, same bound as listOrganizationMembers
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.fetchWithRetry(
        `https://api.github.com/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(teamSlug)}/members?per_page=100&page=${String(page)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (!response.ok) {
        this.logger.warn(
          `Could not list members of team ${org}/${teamSlug} (${String(response.status)}) — check the App has org Members:Read`,
        );
        break;
      }
      const batch = (await response.json()) as Array<{ login: string }>;
      for (const item of batch) logins.push(item.login);
      if (batch.length < 100) break;
    }
    return logins;
  }

  /**
   * Wraps fetch with bounded retry/backoff for GitHub rate limits.
   *
   * Retries only on 429 and rate-limit 403s — detected via response headers so
   * the body is never consumed and remains readable by callers (a permission
   * 403 is NOT retried because its x-ratelimit-remaining is non-zero). Honors
   * Retry-After / X-RateLimit-Reset but caps the inline wait so a provisioning
   * request can never hang past the platform's request timeout; if the reset is
   * further out than the cap, the original response is returned for the caller
   * to surface normally.
   */
  private async fetchWithRetry(
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): ReturnType<typeof fetch> {
    const maxAttempts = 3;
    const maxWaitMs = 8_000;

    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(input, init);

      const isRateLimited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers?.get('retry-after') != null ||
            response.headers?.get('x-ratelimit-remaining') === '0'));

      if (!isRateLimited || attempt >= maxAttempts) {
        return response;
      }

      const waitMs = this.resolveRetryDelayMs(response, attempt);
      if (waitMs > maxWaitMs) {
        return response;
      }

      this.logger.warn(
        `GitHub rate limit (${String(response.status)}); retrying in ${String(waitMs)}ms (attempt ${String(attempt)}/${String(maxAttempts)})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  private resolveRetryDelayMs(
    response: Awaited<ReturnType<typeof fetch>>,
    attempt: number,
  ): number {
    const retryAfter = response.headers?.get('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return seconds * 1000;
      }
    }

    const reset = response.headers?.get('x-ratelimit-reset');
    if (reset) {
      const resetMs = Number(reset) * 1000 - Date.now();
      if (Number.isFinite(resetMs) && resetMs > 0) {
        return resetMs;
      }
    }

    // Exponential backoff fallback: 1s, 2s, 4s.
    return 2 ** (attempt - 1) * 1000;
  }

  createAppJwt(nowSeconds = Math.floor(Date.now() / 1000)): string {
    const githubConfig = this.configService?.get<AppConfig>('app')?.github;
    const appId = githubConfig?.appId ?? this.appId;
    const appPrivateKey = githubConfig?.appPrivateKey ?? this.appPrivateKey;

    if (!appId || !appPrivateKey) {
      throw new UnprocessableEntityException(
        'GitHub App credentials are not configured. Set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY.',
      );
    }

    const header = this.base64UrlJson({ alg: 'RS256', typ: 'JWT' });
    const payload = this.base64UrlJson({
      iat: nowSeconds - 60,
      exp: nowSeconds + 540,
      iss: appId,
    });
    const unsigned = `${header}.${payload}`;
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(appPrivateKey, 'base64url');

    return `${unsigned}.${signature}`;
  }

  async createInstallationAccessToken(installationId: number): Promise<string> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation token request failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as { token?: string };
    if (!payload.token) {
      throw new BadGatewayException(
        'GitHub installation token response did not include a token',
      );
    }

    return payload.token;
  }

  async getInstallationAccessTokenForUser(
    userId: string,
  ): Promise<string | null> {
    if (!this.githubInstallationsRepository) return null;

    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    const installation =
      installations.find((item) => item.repositorySelection === 'all') ??
      installations[0];

    if (!installation) return null;

    try {
      return await this.createInstallationAccessToken(
        installation.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Could not create installation token for user ${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async getInstallationAccessTokenForUserRepo(
    userId: string,
    repoFullName: string,
  ): Promise<string | null> {
    if (!this.githubInstallationsRepository) return null;

    const [owner] = repoFullName.split('/');
    if (!owner) return null;

    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    if (installations.length === 0) return null;

    const linkedRepos =
      await this.githubInstallationsRepository.findReposByUserId(userId);
    const normalizedRepoFullName = repoFullName.toLowerCase();
    const normalizedOwner = owner.toLowerCase();

    const selectedRepoInstallationId = linkedRepos.find(
      (repo) => repo.repoFullName.toLowerCase() === normalizedRepoFullName,
    )?.installationId;

    const installation =
      (selectedRepoInstallationId
        ? installations.find(
            (item) => item.installationId === selectedRepoInstallationId,
          )
        : undefined) ??
      installations.find(
        (item) =>
          item.repositorySelection === 'all' &&
          item.accountLogin?.toLowerCase() === normalizedOwner,
      );

    if (!installation) return null;

    try {
      return await this.createInstallationAccessToken(
        installation.installationId,
      );
    } catch (error) {
      this.logger.warn(
        `Could not create installation token for ${repoFullName} and user ${userId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  async linkInstallation(
    userId: string,
    installationId: number,
  ): Promise<{ reposLinked: number; repositorySelection: 'all' | 'selected' }> {
    let reposLinked = 0;
    let repositorySelection: 'all' | 'selected' = 'selected';
    let accountLogin: string | null = null;
    let accountId: number | null = null;
    let accountType: 'Organization' | 'User' | null = null;
    let repoFullNames: string[] = [];

    try {
      const metadata = await this.fetchInstallationMetadata(installationId);
      accountLogin = metadata.account?.login ?? null;
      accountId = metadata.account?.id ?? null;
      accountType = metadata.account?.type ?? null;
      repositorySelection = metadata.repository_selection ?? 'selected';

      const installationToken =
        await this.createInstallationAccessToken(installationId);
      repoFullNames =
        await this.fetchInstallationRepositories(installationToken);
      reposLinked = repoFullNames.length;
    } catch (error) {
      this.logger.warn(
        `Could not fully inspect installation ${installationId}: ${(error as Error).message}`,
      );
    }

    if (this.githubInstallationsRepository) {
      try {
        const saved = await this.githubInstallationsRepository.upsert(
          userId,
          installationId,
          accountLogin,
          accountId,
          accountType,
          repositorySelection,
          reposLinked,
        );

        if (repoFullNames.length > 0) {
          await this.githubInstallationsRepository.replaceRepos(
            installationId,
            repoFullNames,
          );
        }

        reposLinked = saved.reposLinked;
        repositorySelection = saved.repositorySelection;
      } catch (error) {
        this.logger.warn(
          `Could not persist installation ${installationId}: ${(error as Error).message}`,
        );
      }
    }

    return { reposLinked, repositorySelection };
  }

  async listLinkedRepos(userId: string): Promise<GithubInstallationRepo[]> {
    if (!this.githubInstallationsRepository) return [];
    try {
      return await this.githubInstallationsRepository.findReposByUserId(userId);
    } catch (error) {
      this.logger.warn(
        `Could not fetch linked repos for user ${userId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async listInstallationAccounts(
    userId: string,
  ): Promise<GithubInstallation[]> {
    if (!this.githubInstallationsRepository) return [];
    try {
      let installations =
        await this.githubInstallationsRepository.findByUserId(userId);
      const missingAccountType = installations.filter(
        (installation) => !installation.accountType,
      );
      if (missingAccountType.length > 0) {
        await Promise.all(
          missingAccountType.map((installation) =>
            this.linkInstallation(userId, installation.installationId),
          ),
        );
        installations =
          await this.githubInstallationsRepository.findByUserId(userId);
      }
      return installations;
    } catch (error) {
      this.logger.warn(
        `Could not fetch installations for user ${userId}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  async handleWebhook(
    signature: string | undefined,
    eventName: string | undefined,
    deliveryId: string | undefined,
    rawBody: Buffer | undefined,
    payload: unknown,
  ): Promise<{ accepted: boolean; duplicate?: boolean }> {
    const appWebhookSecret =
      this.configService?.get<AppConfig>('app')?.github.appWebhookSecret ??
      this.appWebhookSecret;
    if (!appWebhookSecret) {
      throw new UnauthorizedException(
        'GitHub webhook secret is not configured.',
      );
    }
    if (!signature || !eventName || !deliveryId || !rawBody) {
      throw new UnauthorizedException(
        'Missing GitHub webhook headers or raw body.',
      );
    }

    const expected = `sha256=${createHmac('sha256', appWebhookSecret)
      .update(rawBody)
      .digest('hex')}`;
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      throw new UnauthorizedException('Invalid GitHub webhook signature.');
    }

    if (!this.githubInstallationsRepository) {
      return { accepted: true };
    }
    const claimed =
      await this.githubInstallationsRepository.beginWebhookDelivery(
        deliveryId,
        eventName,
      );
    if (!claimed) {
      return { accepted: true, duplicate: true };
    }

    try {
      await this.processWebhookEvent(eventName, payload);
      await this.githubInstallationsRepository.completeWebhookDelivery(
        deliveryId,
      );
      return { accepted: true };
    } catch (error) {
      await this.githubInstallationsRepository.releaseWebhookDelivery(
        deliveryId,
      );
      throw error;
    }
  }

  private async processWebhookEvent(
    eventName: string,
    payload: unknown,
  ): Promise<void> {
    if (!payload || typeof payload !== 'object') return;
    const body = payload as Record<string, unknown>;

    // Handled before the `installation` guard below: a `repository` deleted
    // event carries everything it needs in `repository.full_name` and must
    // not depend on the installation payload shape (GitHub App webhooks
    // normally include `installation`, but there's no reason to make repo
    // deletion detection depend on it).
    if (eventName === 'repository' && body['action'] === 'deleted') {
      const repository = body['repository'];
      if (repository && typeof repository === 'object') {
        const fullName = (repository as Record<string, unknown>)['full_name'];
        if (typeof fullName === 'string' && fullName.trim().length > 0) {
          const event: RepositoryDeletedEvent = { repoFullName: fullName };
          this.emit(REPOSITORY_DELETED_EVENT, event);
        } else {
          this.logger.warn(
            `Ignoring repository.deleted webhook with missing/invalid full_name`,
          );
        }
      } else {
        this.logger.warn(
          `Ignoring repository.deleted webhook with missing repository object`,
        );
      }
      return;
    }

    const installation = body['installation'];
    if (!installation || typeof installation !== 'object') return;
    const installationId = Number(
      (installation as Record<string, unknown>)['id'],
    );
    if (!Number.isInteger(installationId) || installationId < 1) return;

    // Org team membership changed — re-derive the affected user's app_role.
    // Emitted for BOTH 'added' and 'removed': a removal from `team-lead` must
    // revoke create rights promptly, which is the security-relevant direction.
    if (eventName === 'membership') {
      const action = body['action'];
      const member = body['member'];
      const team = body['team'];
      const login =
        member && typeof member === 'object'
          ? (member as Record<string, unknown>)['login']
          : undefined;
      const teamSlug =
        team && typeof team === 'object'
          ? (team as Record<string, unknown>)['slug']
          : undefined;

      if (
        typeof action === 'string' &&
        typeof login === 'string' &&
        login.trim().length > 0 &&
        typeof teamSlug === 'string'
      ) {
        const event: TeamMembershipChangedEvent = {
          action,
          login,
          teamSlug,
          installationId,
        };
        this.emit(TEAM_MEMBERSHIP_CHANGED_EVENT, event);
      } else {
        this.logger.warn(
          'Ignoring membership webhook with missing action/member.login/team.slug',
        );
      }
      return;
    }

    if (eventName === 'installation') {
      const action = body['action'];
      if (action === 'deleted') {
        await this.githubInstallationsRepository?.deleteInstallation(
          installationId,
        );
      } else if (action === 'suspend') {
        await this.githubInstallationsRepository?.setSuspended(
          installationId,
          true,
        );
      } else if (action === 'unsuspend') {
        await this.githubInstallationsRepository?.setSuspended(
          installationId,
          false,
        );
      }
      return;
    }

    if (eventName === 'installation_repositories') {
      const token = await this.createInstallationAccessToken(installationId);
      const repos = await this.fetchInstallationRepositories(token);
      await this.githubInstallationsRepository?.replaceRepos(
        installationId,
        repos,
      );
    }
  }

  /**
   * Returns the account login of the first GitHub App installation linked to
   * the given user, or undefined when no installation is linked.
   */
  async getInstallationOwnerLogin(userId: string): Promise<string | undefined> {
    if (!this.githubInstallationsRepository) return undefined;
    const installations =
      await this.githubInstallationsRepository.findByUserId(userId);
    const installation =
      installations.find((item) => item.repositorySelection === 'all') ??
      installations[0];
    return installation?.accountLogin ?? undefined;
  }

  async getOrganizationProvisioningContext(
    userId: string,
    installationId: number,
  ): Promise<{ accessToken: string; ownerLogin: string }> {
    if (!this.githubInstallationsRepository) {
      throw new ServiceUnavailableException(
        'GitHub App installation records cannot be read: the database layer is not initialized on this deployment.',
      );
    }

    let installation =
      await this.githubInstallationsRepository.findByUserIdAndInstallationId(
        userId,
        installationId,
      );

    if (!installation) {
      throw new ForbiddenException(
        'The selected GitHub App installation is not linked to this account.',
      );
    }

    if (!installation.accountType) {
      await this.linkInstallation(userId, installationId);
      installation =
        await this.githubInstallationsRepository.findByUserIdAndInstallationId(
          userId,
          installationId,
        );
    }

    if (installation?.accountType !== 'Organization') {
      throw new ForbiddenException(
        'The selected GitHub App installation does not belong to an organization.',
      );
    }
    if (installation.repositorySelection !== 'all') {
      throw new ForbiddenException(
        'Organization repository creation requires GitHub App access to all repositories.',
      );
    }
    if (!installation.accountLogin) {
      throw new ForbiddenException(
        'The selected GitHub App installation has no organization login.',
      );
    }

    return {
      accessToken: await this.createInstallationAccessToken(installationId),
      ownerLogin: installation.accountLogin,
    };
  }

  /** True when GitHub App credentials (App ID + private key) are configured. */
  private hasAppCredentials(): boolean {
    const github = this.configService?.get<AppConfig>('app')?.github;
    return Boolean(
      (github?.appId ?? this.appId) &&
      (github?.appPrivateKey ?? this.appPrivateKey),
    );
  }

  /**
   * Resolve the GitHub App installation for an org directly via the App JWT
   * (GET /orgs/{org}/installation). Requires no per-user linkage — the App is
   * installed once on the org and every request resolves it centrally.
   */
  private async getInstallationForOrg(orgLogin: string): Promise<{
    id: number;
    accountLogin: string;
    targetType: string;
    repositorySelection: string;
  }> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/orgs/${encodeURIComponent(orgLogin)}/installation`,
      {
        headers: {
          Authorization: `Bearer ${this.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 404) {
      const appSlug = this.getAppSlug();
      throw new ForbiddenException(
        `The GitHub App is not installed on the ${orgLogin} organization. ` +
          (appSlug
            ? `Install it at https://github.com/apps/${appSlug}/installations/new, ` +
              `choose the ${orgLogin} organization, and grant access to all repositories, then try again.`
            : `Install it on ${orgLogin} with access to all repositories, then try again.`),
      );
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub org installation lookup failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as {
      id: number;
      account?: { login?: string };
      target_type?: string;
      repository_selection?: string;
    };

    return {
      id: payload.id,
      accountLogin: payload.account?.login ?? orgLogin,
      targetType: payload.target_type ?? '',
      repositorySelection: payload.repository_selection ?? '',
    };
  }

  /**
   * Resolve the org provisioning context for a fixed org login (used when the
   * deployment enforces a single destination org, e.g. Alpha-Explora).
   *
   * The GitHub App is installed once on the enforced org, so the installation
   * is always resolved app-to-org via the App JWT — no per-user linkage is
   * consulted. Every failure names its exact cause: missing server credentials,
   * App not installed on the org, or insufficient repository access.
   */
  async getOrganizationProvisioningContextByLogin(
    orgLogin: string,
  ): Promise<{ accessToken: string; ownerLogin: string }> {
    if (!this.hasAppCredentials()) {
      throw new ServiceUnavailableException(
        `Repository creation in the ${orgLogin} organization is not available: ` +
          'this deployment has no GitHub App credentials. Set GITHUB_APP_ID and ' +
          'GITHUB_APP_PRIVATE_KEY (or GITHUB_APP / GITHUB_PRIVATE_KEY) and restart the service.',
      );
    }

    const installation = await this.getInstallationForOrg(orgLogin);

    if (installation.targetType !== 'Organization') {
      throw new ForbiddenException(
        `The GitHub App installation for ${orgLogin} is not an organization installation.`,
      );
    }
    if (installation.repositorySelection !== 'all') {
      throw new ForbiddenException(
        `The GitHub App is installed on ${orgLogin} with "${installation.repositorySelection}" ` +
          'repository access, but creating repositories requires "All repositories". ' +
          `Update it on GitHub: ${orgLogin} organization Settings -> GitHub Apps -> ` +
          `${this.getAppSlug() || 'the app'} -> Configure -> Repository access -> All repositories.`,
      );
    }

    return {
      accessToken: await this.createInstallationAccessToken(installation.id),
      ownerLogin: installation.accountLogin,
    };
  }

  /**
   * Returns true if the repository exists and the token has access to it.
   * Returns false only on 404 (deleted or never existed).
   * Throws on 401/403 and other unexpected statuses (5xx, network errors) —
   * those don't confirm the repo is gone, they mean the check itself is
   * unreliable (bad/revoked token, secondary rate limit, transient outage).
   * Callers must not treat a thrown error as "not found".
   */
  async repoExists(
    accessToken: string,
    repoFullName: string,
  ): Promise<boolean> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/repos/${repoFullName}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 200) return true;
    // 404 alone confirms GitHub does not have this repo. 401/403 are
    // ambiguous — they can mean the token was revoked, the repo's visibility
    // changed, or GitHub's secondary rate limit kicked in — none of which
    // mean the repo is actually gone. Treating them as "not found" would
    // mass-orphan every project checked with the same bad token in one sync
    // pass, so they fall through to the throw below instead, which callers
    // (syncProjects) already treat as a skippable, non-conclusive check.
    if (response.status === 404) return false;

    const body = await response.text();
    throw new BadGatewayException(
      `GitHub repo existence check failed (${String(response.status)}): ${body}`,
    );
  }

  async listRepos(accessToken: string): Promise<GitHubRepo[]> {
    const response = await this.fetchWithRetry(
      'https://api.github.com/user/repos?per_page=100&sort=updated&type=all',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as GitHubRepoResponse[];
    return payload.map((repo) => this.toRepo(repo));
  }

  async getRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<GitHubRepo> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub repo lookup failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubRepoResponse;
    return this.toRepo(payload);
  }

  private toRepo(repo: GitHubRepoResponse): GitHubRepo {
    return {
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      description: repo.description,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      updatedAt: repo.updated_at,
    };
  }

  async createRepo(
    accessToken: string,
    dto: CreateRepoDto,
    ownerLogin?: string,
  ): Promise<{
    repoUrl: string;
    cloneUrl: string;
    ownerLogin: string;
    repoName: string;
  }> {
    // Repositories are ALWAYS created inside a GitHub organization. The personal
    // `POST /user/repos` path has been removed entirely so a repository can never
    // be provisioned into a user's own account — not through a missing owner, and
    // not through configuration. `getEnforcedOrg()` defaults to Alpha-Explora and
    // can never resolve to an empty value (see app.config.ts).
    const targetOwner = ownerLogin || this.getEnforcedOrg();
    if (!targetOwner) {
      throw new ForbiddenException(
        'Repository creation is locked to a GitHub organization, but no ' +
          'destination org is configured. Set GITHUB_ENFORCED_ORG to a valid ' +
          'organization login.',
      );
    }

    return this.createRepoForOrg(accessToken, dto, targetOwner);
  }

  private async createRepoForOrg(
    accessToken: string,
    dto: CreateRepoDto,
    orgLogin: string,
  ): Promise<{
    repoUrl: string;
    cloneUrl: string;
    ownerLogin: string;
    repoName: string;
  }> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/orgs/${orgLogin}/repos`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: dto.repoName,
          description: dto.description ?? '',
          private: dto.private,
          auto_init: true,
          default_branch: 'main',
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 401 || response.status === 403) {
        throw new ForbiddenException(
          `GitHub denied repository creation in organization ${orgLogin} (${String(response.status)}). ` +
            "Confirm the signed-in user's OAuth token has the 'repo' scope and that the user and organization policy allow repository creation.",
        );
      }
      if (response.status === 404) {
        throw new ForbiddenException(
          `GitHub organization ${orgLogin} is unavailable to the signed-in user or OAuth token. Sign out and sign back in with GitHub, then confirm the user belongs to the organization.`,
        );
      }
      if (response.status === 422) {
        throw new UnprocessableEntityException(
          `Repository already exists in ${orgLogin} or the name is invalid: ${body}`,
        );
      }
      throw new BadGatewayException(
        `GitHub repo creation failed (${String(response.status)}): ${body}`,
      );
    }

    const repo = (await response.json()) as {
      html_url: string;
      clone_url: string;
      owner: { login: string };
      name: string;
    };

    return {
      repoUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      ownerLogin: repo.owner.login,
      repoName: repo.name,
    };
  }

  /**
   * Best-effort repository deletion, used to compensate a provisioning failure
   * so a half-created repo is not left orphaned (which would 422 on retry).
   * Never throws: deletion requires the `delete_repo` OAuth scope, which may be
   * absent — failures are logged and swallowed so they cannot mask the original
   * provisioning error. Returns true only when GitHub confirmed the deletion.
   */
  async deleteRepo(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<boolean> {
    try {
      const response = await this.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );

      if (response.status === 204) {
        return true;
      }

      this.logger.warn(
        `Compensating repo delete for ${owner}/${repo} returned ${String(response.status)}; manual cleanup may be required`,
      );
      return false;
    } catch (error) {
      this.logger.warn(
        `Compensating repo delete for ${owner}/${repo} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * User-initiated repository deletion (project delete's opt-in "also delete
   * the GitHub repo" path). Unlike deleteRepo() above — a silent best-effort
   * compensating action that other call sites depend on staying silent —
   * this throws a typed GithubRepoDeleteError on any non-success response so
   * the caller can show the user *why* it failed, most importantly
   * distinguishing a missing `delete_repo` OAuth scope (session token was
   * issued before that scope was added; user must reconnect GitHub) from a
   * repo that's already gone or some other API error.
   */
  async deleteRepoForUser(
    accessToken: string,
    owner: string,
    repo: string,
  ): Promise<void> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 204) {
      return;
    }

    if (response.status === 404) {
      throw new GithubRepoDeleteError(
        'not_found',
        `GitHub repository ${owner}/${repo} was not found (it may already be deleted, or this token no longer has access to it).`,
      );
    }

    if (response.status === 403 || response.status === 401) {
      // Curated, canned message only — never mix the raw GitHub response
      // body into a message that flows into the API response
      // (githubRepoDeleteError.message). Mirrors
      // RenderEnvironmentClient.assertOk's per-status canned messages.
      throw new GithubRepoDeleteError(
        'missing_scope',
        `GitHub denied deleting ${owner}/${repo} (${String(response.status)}). This usually means the session's GitHub token was issued before the delete_repo scope was granted — reconnect your GitHub account to grant repository-deletion permission.`,
      );
    }

    const body = await response.text().catch(() => '');
    const summary = body ? ` ${body.slice(0, 300)}` : '';
    throw new GithubRepoDeleteError(
      'other',
      `GitHub repo deletion failed (${String(response.status)}):${summary}`,
    );
  }

  async createBranch(
    accessToken: string,
    owner: string,
    repo: string,
    branchName: string,
    fromBranch: string,
  ): Promise<void> {
    let ref: { object: { sha: string } } | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
      }
      const refRes = await this.fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${fromBranch}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'cicd-workflow-product',
          },
        },
      );
      if (refRes.ok) {
        ref = (await refRes.json()) as { object: { sha: string } };
        break;
      }
    }
    if (!ref) {
      throw new BadGatewayException(
        `Could not resolve '${fromBranch}' branch on GitHub after retries. ` +
          'The repository may not have initialised yet; please retry in a few seconds.',
      );
    }

    const createRes = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/git/refs`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: `refs/heads/${branchName}`,
          sha: ref.object.sha,
        }),
      },
    );
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new BadGatewayException(
        `Branch '${branchName}' creation failed (${String(createRes.status)}): ${err}`,
      );
    }
  }

  async getFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    ref: string,
  ): Promise<string | null> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub file read failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubContentResponse;
    if (!payload.content || payload.encoding !== 'base64') {
      return null;
    }

    return Buffer.from(payload.content, 'base64').toString('utf8');
  }

  async putFileContent(
    accessToken: string,
    owner: string,
    repo: string,
    filePath: string,
    content: string,
    branch: string,
    message: string,
  ): Promise<{ commitSha: string; commitUrl: string | null }> {
    const encodedContent = Buffer.from(content, 'utf8').toString('base64');
    let existingSha: string | undefined;

    const checkRes = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (checkRes.ok) {
      const existing = (await checkRes.json()) as GitHubContentResponse;
      existingSha = existing.sha;
    } else if (checkRes.status !== 404) {
      const body = await checkRes.text();
      throw new BadGatewayException(
        `GitHub file lookup failed (${String(checkRes.status)}): ${body}`,
      );
    }

    const body: Record<string, unknown> = {
      message,
      content: encodedContent,
      branch,
    };

    if (existingSha) {
      body.sha = existingSha;
    }

    const putRes = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );

    if (!putRes.ok) {
      const errorBody = await putRes.text();
      throw new BadGatewayException(
        `GitHub file write failed (${String(putRes.status)}): ${errorBody}`,
      );
    }

    const payload = (await putRes.json()) as GitHubContentsWriteResponse;
    return {
      commitSha: payload.commit?.sha ?? '',
      commitUrl: payload.commit?.html_url ?? payload.content?.html_url ?? null,
    };
  }

  async createPullRequest(
    accessToken: string,
    owner: string,
    repo: string,
    pullRequest: { title: string; head: string; base: string; body?: string },
  ): Promise<{ number: number; htmlUrl: string }> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(pullRequest),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub pull request creation failed (${String(response.status)}): ${body}`,
      );
    }

    const payload = (await response.json()) as GitHubPullRequestResponse;
    if (!payload.number || !payload.html_url) {
      throw new BadGatewayException(
        'GitHub pull request response was incomplete',
      );
    }

    return { number: payload.number, htmlUrl: payload.html_url };
  }

  async setActionsSecret(
    accessToken: string | null | undefined,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
    options: { throwOnFailure?: boolean } = {},
  ): Promise<void> {
    if (!accessToken) {
      const message = `setActionsSecret: no token available for ${owner}/${repo}/${secretName}, skipping`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
      return;
    }

    const keyRes = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/public-key`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!keyRes.ok) {
      const body = await keyRes.text();
      const message = `setActionsSecret: failed to fetch public key for ${owner}/${repo} (${String(keyRes.status)}): ${body}`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
      return;
    }

    const keyPayload = (await keyRes.json()) as { key_id: string; key: string };

    await sodium.ready;
    const keyBytes = sodium.from_base64(
      keyPayload.key,
      sodium.base64_variants.ORIGINAL,
    );
    const secretBytes = sodium.from_string(secretValue);
    const encryptedBytes = sodium.crypto_box_seal(secretBytes, keyBytes);
    const encryptedValue = sodium.to_base64(
      encryptedBytes,
      sodium.base64_variants.ORIGINAL,
    );

    const putRes = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/actions/secrets/${secretName}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          encrypted_value: encryptedValue,
          key_id: keyPayload.key_id,
        }),
      },
    );

    if (!putRes.ok && putRes.status !== 204) {
      const body = await putRes.text();
      const message = `setActionsSecret: failed to set ${secretName} on ${owner}/${repo} (${String(putRes.status)}): ${body}`;
      if (options.throwOnFailure) {
        throw new BadGatewayException(message);
      }
      this.logger.warn(message);
    }
  }

  async setActionsSecretStrict(
    accessToken: string,
    owner: string,
    repo: string,
    secretName: string,
    secretValue: string,
  ): Promise<void> {
    await this.setActionsSecret(
      accessToken,
      owner,
      repo,
      secretName,
      secretValue,
      { throwOnFailure: true },
    );
  }

  /**
   * Every protected branch requires the env-guard check by default so a pull
   * request that adds a `.env`-style file can never be merged; the guard
   * workflow runs on all pushes and pull requests, so the context is always
   * present on PR head commits of provisioned repos.
   */
  async applyBranchProtection(
    accessToken: string,
    owner: string,
    repo: string,
    branch: string,
    requiredStatusChecks: string[] = [ENV_GUARD_CHECK_CONTEXT],
  ): Promise<void> {
    const res = await this.fetchWithRetry(
      `https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          required_status_checks:
            requiredStatusChecks.length > 0
              ? { strict: false, contexts: requiredStatusChecks }
              : null,
          enforce_admins: false,
          required_pull_request_reviews: {
            dismiss_stale_reviews: true,
            require_code_owner_reviews: false,
            required_approving_review_count: 1,
          },
          restrictions: null,
          allow_force_pushes: false,
          allow_deletions: false,
        }),
      },
    );
    if (!res.ok) {
      this.logger.warn(
        `Branch protection on ${branch} failed (${String(res.status)}); continuing`,
      );
    }
  }

  private async fetchInstallationMetadata(
    installationId: number,
  ): Promise<GitHubInstallationMetadataResponse> {
    const response = await this.fetchWithRetry(
      `https://api.github.com/app/installations/${String(installationId)}`,
      {
        headers: {
          Authorization: `Bearer ${this.createAppJwt()}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation metadata request failed (${String(response.status)}): ${body}`,
      );
    }

    return (await response.json()) as GitHubInstallationMetadataResponse;
  }

  private async fetchInstallationRepositories(
    accessToken: string,
  ): Promise<string[]> {
    const response = await this.fetchWithRetry(
      'https://api.github.com/installation/repositories?per_page=100',
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'cicd-workflow-product',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new BadGatewayException(
        `GitHub installation repositories request failed (${String(response.status)}): ${body}`,
      );
    }

    const payload =
      (await response.json()) as GitHubInstallationRepositoriesResponse;
    return (payload.repositories ?? [])
      .map((repo) => repo.full_name)
      .filter((repoFullName): repoFullName is string => Boolean(repoFullName));
  }

  private base64UrlJson(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }
}
