import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export type PlatformRole = 'admin' | 'super_admin';

/** Global hierarchy role — single source of truth for group capabilities. */
export type AppRole = 'admin' | 'lead' | 'member';

/**
 * Provenance of app_role.
 *  - 'github_team' — derived from GitHub org team membership; re-evaluated on
 *    every login (and by the membership webhook) under GITHUB_TEAM_ROLE_SYNC
 *    = 'enforce'.
 *  - 'manual' — pinned by an Admin Console edit. Automatic sync skips these
 *    users entirely until an admin resets them.
 */
export type AppRoleSource = 'github_team' | 'manual';

export interface PlatformAdminRecord {
  userId: string;
  login: string;
  displayName: string | null;
  role: PlatformRole;
  grantedBy: string | null;
  grantedAt: string;
}

interface PlatformAdminRow {
  user_id: string;
  login: string;
  display_name: string | null;
  role: PlatformRole;
  granted_by: string | null;
  granted_at: string;
}

/**
 * Data access for the platform-level admin grants in identity.platform_admins.
 * Absence of a row means the user is an ordinary user (no platform role).
 */
@Injectable()
export class PlatformAdminsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  /** Returns the user's platform role, or null if they are not a platform admin. */
  async findRole(userId: string): Promise<PlatformRole | null> {
    const result = await this.databaseService.query<{ role: PlatformRole }>(
      `SELECT role FROM identity.platform_admins WHERE user_id = $1 LIMIT 1;`,
      [userId],
    );
    return result.rows[0]?.role ?? null;
  }

  /** Global hierarchy role (defaults to 'member' when the user is unknown). */
  async findAppRole(userId: string): Promise<AppRole> {
    const result = await this.databaseService.query<{ app_role: AppRole }>(
      `SELECT app_role FROM identity.app_users WHERE id = $1 LIMIT 1;`,
      [userId],
    );
    return result.rows[0]?.app_role ?? 'member';
  }

  /**
   * Sets a user's global hierarchy role.
   *
   * `source` defaults to 'manual' on purpose: every caller that reaches this
   * method through the Admin Console is a deliberate human decision and must
   * pin the user, so a later login can't silently undo it. Automatic sync
   * paths pass 'github_team' explicitly.
   */
  async setAppRole(
    userId: string,
    role: AppRole,
    source: AppRoleSource = 'manual',
  ): Promise<void> {
    await this.databaseService.query(
      `UPDATE identity.app_users SET app_role = $2, app_role_source = $3 WHERE id = $1;`,
      [userId, role, source],
    );
  }

  /**
   * Role plus provenance in one round-trip. Defaults to
   * ('member', 'github_team') when the user is unknown, matching findAppRole.
   */
  async findAppRoleWithSource(
    userId: string,
  ): Promise<{ role: AppRole; source: AppRoleSource }> {
    const result = await this.databaseService.query<{
      app_role: AppRole;
      app_role_source: AppRoleSource;
    }>(
      `SELECT app_role, app_role_source FROM identity.app_users WHERE id = $1 LIMIT 1;`,
      [userId],
    );
    const row = result.rows[0];
    return {
      role: row?.app_role ?? 'member',
      source: row?.app_role_source ?? 'github_team',
    };
  }

  /** Unpins a user so GitHub team membership drives their role again. */
  async setAppRoleSource(userId: string, source: AppRoleSource): Promise<void> {
    await this.databaseService.query(
      `UPDATE identity.app_users SET app_role_source = $2 WHERE id = $1;`,
      [userId, source],
    );
  }

  /** Resolves a GitHub login to an AlphaCI user id — used by the membership webhook. */
  async findUserIdByGithubLogin(login: string): Promise<string | null> {
    const result = await this.databaseService.query<{ id: string }>(
      `SELECT id FROM identity.app_users WHERE LOWER(login) = LOWER($1) LIMIT 1;`,
      [login],
    );
    return result.rows[0]?.id ?? null;
  }

  async list(): Promise<PlatformAdminRecord[]> {
    const result = await this.databaseService.query<PlatformAdminRow>(
      `
        SELECT pa.user_id, u.login, u.display_name, pa.role, pa.granted_by, pa.granted_at
        FROM identity.platform_admins AS pa
        JOIN identity.app_users AS u ON u.id = pa.user_id
        ORDER BY pa.granted_at ASC;
      `,
    );
    return result.rows.map((row) => this.toRecord(row));
  }

  /** Idempotent upsert — grants or changes a user's platform role. */
  async grant(
    userId: string,
    role: PlatformRole,
    grantedBy: string,
  ): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO identity.platform_admins (user_id, role, granted_by)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id)
        DO UPDATE SET role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, granted_at = NOW();
      `,
      [userId, role, grantedBy],
    );
  }

  async revoke(userId: string): Promise<void> {
    await this.databaseService.query(
      `DELETE FROM identity.platform_admins WHERE user_id = $1;`,
      [userId],
    );
  }

  /** Number of super-admins — used to prevent removing the last one. */
  async countSuperAdmins(): Promise<number> {
    const result = await this.databaseService.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM identity.platform_admins WHERE role = 'super_admin';`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  private toRecord(row: PlatformAdminRow): PlatformAdminRecord {
    return {
      userId: row.user_id,
      login: row.login,
      displayName: row.display_name,
      role: row.role,
      grantedBy: row.granted_by,
      grantedAt: row.granted_at,
    };
  }
}
