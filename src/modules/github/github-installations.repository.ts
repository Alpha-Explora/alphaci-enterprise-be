import { Injectable, Logger } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

interface GithubInstallationRow {
  installation_id: number;
  user_id: string;
  account_login: string | null;
  account_id: number | null;
  account_type: 'Organization' | 'User' | null;
  repository_selection: 'all' | 'selected';
  repos_linked: number;
  created_at: string;
}

interface GithubInstallationRepoRow {
  installation_id: number;
  repo_full_name: string;
}

export interface GithubInstallation {
  installationId: number;
  userId: string;
  accountLogin: string | null;
  accountId: number | null;
  accountType: 'Organization' | 'User' | null;
  repositorySelection: 'all' | 'selected';
  reposLinked: number;
}

export interface GithubInstallationRepo {
  installationId: number;
  repoFullName: string;
}

@Injectable()
export class GithubInstallationsRepository {
  private readonly logger = new Logger(GithubInstallationsRepository.name);

  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * Upsert a GitHub App installation record for the given user.
   * Returns the stored installation row.
   */
  async upsert(
    userId: string,
    installationId: number,
    accountLogin: string | null,
    accountId: number | null,
    accountType: 'Organization' | 'User' | null,
    repositorySelection: 'all' | 'selected',
    reposLinked: number,
  ): Promise<GithubInstallation> {
    const result = await this.databaseService.query<GithubInstallationRow>(
      `
        INSERT INTO github_app.github_installation_accounts (
          installation_id,
          user_id,
          account_login,
          account_id,
          account_type,
          repository_selection
        )
        VALUES ($1, $2::uuid, $3, $4, $5, $6)
        ON CONFLICT (user_id, installation_id)
        DO UPDATE SET
          account_login        = EXCLUDED.account_login,
          account_id           = EXCLUDED.account_id,
          account_type         = EXCLUDED.account_type,
          repository_selection = EXCLUDED.repository_selection,
          updated_at           = NOW()
        RETURNING
          installation_id,
          user_id::text,
          account_login,
          account_id,
          account_type,
          repository_selection,
          $7::integer AS repos_linked,
          created_at;
      `,
      [
        installationId,
        userId,
        accountLogin,
        accountId,
        accountType,
        repositorySelection,
        reposLinked,
      ],
    );

    const row = result.rows[0];
    if (!row) throw new Error('github_installations upsert returned no row');
    return this.toInstallation(row);
  }

  /** Return all installations belonging to the given user. */
  async findByUserId(userId: string): Promise<GithubInstallation[]> {
    const result = await this.databaseService.query<GithubInstallationRow>(
      `
        SELECT
          a.installation_id,
          a.user_id::text,
          a.account_login,
          a.account_id,
          a.account_type,
          a.repository_selection,
          (
            SELECT COUNT(*)::integer
            FROM github_app.github_installations r
            WHERE r.user_id = a.user_id
              AND r.installation_id = a.installation_id
              AND r.suspended_at IS NULL
          ) AS repos_linked,
          a.created_at
        FROM github_app.github_installation_accounts a
        WHERE a.user_id = $1::uuid
          AND a.suspended_at IS NULL
        ORDER BY created_at DESC;
      `,
      [userId],
    );

    return result.rows.map((row) => this.toInstallation(row));
  }

  /**
   * Installation id for an org, independent of any one user.
   *
   * Background jobs (the role-reconciliation worker) have no acting user, so
   * they cannot go through getInstallationAccessTokenForUser. Any non-suspended
   * row for the org yields the same installation id — the account is the org,
   * not the user who happened to link it — so the newest is as good as any.
   */
  async findInstallationIdByAccountLogin(
    accountLogin: string,
  ): Promise<number | null> {
    const result = await this.databaseService.query<{
      installation_id: number;
    }>(
      `
        SELECT installation_id
        FROM github_app.github_installation_accounts
        WHERE LOWER(account_login) = LOWER($1)
          AND suspended_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1;
      `,
      [accountLogin],
    );
    return result.rows[0]?.installation_id ?? null;
  }

  async findByUserIdAndInstallationId(
    userId: string,
    installationId: number,
  ): Promise<GithubInstallation | null> {
    const installations = await this.findByUserId(userId);
    return (
      installations.find((item) => item.installationId === installationId) ??
      null
    );
  }

  /** Return all repos linked to installations belonging to the given user. */
  async findReposByUserId(userId: string): Promise<GithubInstallationRepo[]> {
    const result = await this.databaseService.query<GithubInstallationRepoRow>(
      `
        SELECT
          installation_id,
          repo_full_name
        FROM github_app.github_installations
        WHERE user_id = $1::uuid
          AND suspended_at IS NULL
        ORDER BY repo_full_name;
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      installationId: row.installation_id,
      repoFullName: row.repo_full_name,
    }));
  }

  async replaceRepos(
    installationId: number,
    repoFullNames: string[],
  ): Promise<void> {
    await this.databaseService.query(
      'DELETE FROM github_app.github_installations WHERE installation_id = $1;',
      [installationId],
    );

    if (repoFullNames.length === 0) {
      return;
    }

    const values: unknown[] = [];
    const placeholders = repoFullNames.map((repoFullName, index) => {
      values.push(repoFullName);
      return `($${index + 2})`;
    });

    await this.databaseService.query(
      `
        INSERT INTO github_app.github_installations (
          user_id,
          installation_id,
          repo_full_name,
          account_login,
          account_id,
          repository_selection,
          permissions,
          events,
          installed_at
        )
        SELECT
          account.user_id,
          account.installation_id,
          repo.repo_full_name,
          account.account_login,
          account.account_id,
          account.repository_selection,
          account.permissions,
          account.events,
          account.installed_at
        FROM github_app.github_installation_accounts account
        CROSS JOIN (VALUES ${placeholders.join(', ')}) AS repo(repo_full_name)
        WHERE account.installation_id = $1
          AND account.suspended_at IS NULL
        ON CONFLICT DO NOTHING;
      `,
      [installationId, ...values],
    );
  }

  async setSuspended(
    installationId: number,
    suspended: boolean,
  ): Promise<void> {
    await this.databaseService.query(
      `UPDATE github_app.github_installation_accounts
       SET suspended_at = CASE WHEN $2 THEN NOW() ELSE NULL END,
           updated_at = NOW()
       WHERE installation_id = $1;`,
      [installationId, suspended],
    );
  }

  async deleteInstallation(installationId: number): Promise<void> {
    await this.databaseService.query(
      'DELETE FROM github_app.github_installation_accounts WHERE installation_id = $1;',
      [installationId],
    );
  }

  async beginWebhookDelivery(
    deliveryId: string,
    eventName: string,
  ): Promise<boolean> {
    const result = await this.databaseService.query<{ delivery_id: string }>(
      `INSERT INTO github_app.webhook_deliveries (delivery_id, event_name, status)
       VALUES ($1, $2, 'processing')
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING delivery_id;`,
      [deliveryId, eventName],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }

  async completeWebhookDelivery(deliveryId: string): Promise<void> {
    await this.databaseService.query(
      `UPDATE github_app.webhook_deliveries
       SET status = 'processed', processed_at = NOW()
       WHERE delivery_id = $1;`,
      [deliveryId],
    );
  }

  async releaseWebhookDelivery(deliveryId: string): Promise<void> {
    await this.databaseService.query(
      `DELETE FROM github_app.webhook_deliveries
       WHERE delivery_id = $1 AND status = 'processing';`,
      [deliveryId],
    );
  }

  private toInstallation(row: GithubInstallationRow): GithubInstallation {
    return {
      installationId: row.installation_id,
      userId: row.user_id,
      accountLogin: row.account_login,
      accountId: row.account_id,
      accountType: row.account_type,
      repositorySelection: row.repository_selection,
      reposLinked: row.repos_linked,
    };
  }
}
