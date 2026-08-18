import { Injectable } from '@nestjs/common';

import { DatabaseService } from '../../database/database.service';
import type {
  GrantableRole,
  GroupRole,
  LifecycleStatus,
  MemberStatus,
} from '../hierarchy.types';

export interface GroupRecord {
  id: string;
  name: string;
  description: string | null;
  businessUnit: string | null;
  status: LifecycleStatus;
  archivedAt: string | null;
  archivedBy: string | null;
  createdAt: string;
  role?: GroupRole;
  /** Active member / active-system counts — at-a-glance chips (UI_LAYOUTS.md §6.5). */
  memberCount: number;
  systemCount: number;
}

export interface GroupMemberRecord {
  id: string;
  /**
   * NOTE: named groupId (not workspaceId) on purpose — the API path segment
   * is /groups and every hierarchy response uses the product term
   * (HIERARCHY_IMPLEMENTATION_PLAN.md §2.0/§2.3, UI_LAYOUTS.md §6.1). Only the
   * underlying orgs.workspaces/workspace_members SQL keeps the internal name.
   */
  groupId: string;
  userId: string;
  role: GroupRole;
  memberStatus: MemberStatus;
  login: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  invitedBy: string | null;
  invitedAt: string | null;
  removedAt: string | null;
  removedBy: string | null;
  removalReason: string | null;
  createdAt: string;
}

export interface InternalUserDirectoryEntry {
  /** Null when the GitHub org member has never signed into AlphaCI. */
  id: string | null;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** True only when this org member has an AlphaCI account and can be added. */
  hasAccount: boolean;
}

export interface DirectoryAccountRecord {
  id: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /** Already an active member of the Group being added to. */
  isActiveMember: boolean;
}

export interface ActiveMembership {
  workspaceId: string;
  userId: string;
  role: GroupRole;
  memberId: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  business_unit: string | null;
  status: LifecycleStatus;
  archived_at: string | null;
  archived_by: string | null;
  created_at: string;
  role?: GroupRole;
}

interface MemberRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: GroupRole;
  member_status: MemberStatus;
  login: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  invited_by: string | null;
  invited_at: string | null;
  removed_at: string | null;
  removed_by: string | null;
  removal_reason: string | null;
  created_at: string;
}

@Injectable()
export class GroupsRepository {
  constructor(private readonly databaseService: DatabaseService) {}

  async createGroup(input: {
    name: string;
    description?: string | null;
    businessUnit?: string | null;
    creatorUserId: string;
  }): Promise<GroupRecord> {
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await client.query<GroupRow>(
          `
            INSERT INTO orgs.workspaces (owner_user_id, name, kind, description, business_unit, status)
            VALUES ($1, $2, 'team', $3, $4, 'active')
            RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
          `,
          [
            input.creatorUserId,
            input.name,
            input.description ?? null,
            input.businessUnit ?? null,
          ],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error('Group insert did not return a row');
        }
        await client.query(
          `
            INSERT INTO orgs.workspace_members (workspace_id, user_id, role, member_status)
            VALUES ($1, $2, 'admin', 'active');
          `,
          [row.id, input.creatorUserId],
        );
        await client.query('COMMIT');
        return this.toGroup(row, { memberCount: 1, systemCount: 0 });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async transferLeadGuarded(
    groupId: string,
    newLeadUserId: string,
  ): Promise<{ previousRole: GroupRole } | null> {
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `SELECT id FROM orgs.workspace_members WHERE workspace_id = $1 AND member_status = 'active' FOR UPDATE;`,
          [groupId],
        );
        const targetResult = await client.query<{ role: GroupRole }>(
          `
            SELECT role
            FROM orgs.workspace_members
            WHERE workspace_id = $1 AND user_id = $2 AND member_status = 'active';
          `,
          [groupId, newLeadUserId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return null;
        }
        await client.query(
          `
            UPDATE orgs.workspace_members
            SET role = CASE WHEN user_id = $2 THEN 'admin' ELSE 'delegated_lead' END
            WHERE workspace_id = $1 AND member_status = 'active' AND (role = 'admin' OR user_id = $2);
          `,
          [groupId, newLeadUserId],
        );
        await client.query(
          `UPDATE orgs.workspaces SET owner_user_id = $2, updated_at = NOW() WHERE id = $1 AND kind = 'team';`,
          [groupId, newLeadUserId],
        );
        await client.query('COMMIT');
        return { previousRole: target.role };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  async listForUser(userId: string): Promise<GroupRecord[]> {
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT
          workspace.id, workspace.name, workspace.description, workspace.business_unit,
          workspace.status, workspace.archived_at, workspace.archived_by, workspace.created_at,
          CASE WHEN app_user.app_role = 'member' THEN 'member' ELSE 'admin' END AS role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS app_user ON app_user.id = member.user_id
        WHERE member.user_id = $1
          AND member.member_status = 'active'
          AND workspace.kind = 'team'
        ORDER BY workspace.created_at ASC;
      `,
      [userId],
    );
    const counts = await this.getCountsForGroups(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => this.toGroup(row, counts.get(row.id)));
  }

  async listAllGroups(): Promise<GroupRecord[]> {
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT id, name, description, business_unit, status, archived_at, archived_by, created_at,
          'admin'::text AS role
        FROM orgs.workspaces
        WHERE kind = 'team'
        ORDER BY created_at DESC;
      `,
    );
    const counts = await this.getCountsForGroups(
      result.rows.map((row) => row.id),
    );
    return result.rows.map((row) => this.toGroup(row, counts.get(row.id)));
  }

  async findGroupById(groupId: string): Promise<GroupRecord | null> {
    const result = await this.databaseService.query<GroupRow>(
      `
        SELECT id, name, description, business_unit, status, archived_at, archived_by, created_at
        FROM orgs.workspaces
        WHERE id = $1 AND kind = 'team';
      `,
      [groupId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  /**
   * Active-member / active-system counts for the "at a glance" chips on
   * GroupSummary (UI_LAYOUTS.md §6.5) — batched by group id to stay N+1-free
   * when called from listForUser.
   */
  private async getCountsForGroups(
    groupIds: string[],
  ): Promise<Map<string, { memberCount: number; systemCount: number }>> {
    if (groupIds.length === 0) return new Map();
    const result = await this.databaseService.query<{
      group_id: string;
      member_count: number;
      system_count: number;
    }>(
      `
        SELECT
          workspace.id AS group_id,
          (SELECT count(*)::int FROM orgs.workspace_members m
             WHERE m.workspace_id = workspace.id AND m.member_status = 'active') AS member_count,
          (SELECT count(*)::int FROM hierarchy.systems s
             WHERE s.group_id = workspace.id AND s.status = 'active') AS system_count
        FROM orgs.workspaces AS workspace
        WHERE workspace.id = ANY($1::uuid[]);
      `,
      [groupIds],
    );
    return new Map(
      result.rows.map((row) => [
        row.group_id,
        { memberCount: row.member_count, systemCount: row.system_count },
      ]),
    );
  }

  /** Active membership only — the choke point every group-scoped authz check uses. */
  async findActiveMembership(
    groupId: string,
    userId: string,
  ): Promise<ActiveMembership | null> {
    const result = await this.databaseService.query<{
      id: string;
      workspace_id: string;
      user_id: string;
      role: GroupRole;
    }>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id,
          -- Effective group role is derived from the user's GLOBAL app_role
          -- (single source of truth) — 'admin'/'lead' act as group managers,
          -- 'member' does not. The stored member.role is no longer authoritative.
          CASE WHEN app_user.app_role = 'member' THEN 'member' ELSE 'admin' END AS role
        FROM orgs.workspace_members AS member
        JOIN orgs.workspaces AS workspace ON workspace.id = member.workspace_id
        JOIN identity.app_users AS app_user ON app_user.id = member.user_id
        WHERE member.workspace_id = $1
          AND member.user_id = $2
          AND member.member_status = 'active'
          AND workspace.kind = 'team';
      `,
      [groupId, userId],
    );
    const row = result.rows[0];
    return row
      ? {
          workspaceId: row.workspace_id,
          userId: row.user_id,
          role: row.role,
          memberId: row.id,
        }
      : null;
  }

  async updateGroup(
    groupId: string,
    input: {
      name?: string;
      description?: string | null;
      businessUnit?: string | null;
    },
  ): Promise<GroupRecord | null> {
    const result = await this.databaseService.query<GroupRow>(
      `
        UPDATE orgs.workspaces
        SET
          name = COALESCE($2, name),
          description = CASE WHEN $3::boolean THEN $4 ELSE description END,
          business_unit = CASE WHEN $5::boolean THEN $6 ELSE business_unit END,
          updated_at = NOW()
        WHERE id = $1 AND kind = 'team'
        RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
      `,
      [
        groupId,
        input.name ?? null,
        input.description !== undefined,
        input.description ?? null,
        input.businessUnit !== undefined,
        input.businessUnit ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  async setArchiveStatus(
    groupId: string,
    status: LifecycleStatus,
    actingUserId: string,
  ): Promise<GroupRecord | null> {
    const result = await this.databaseService.query<GroupRow>(
      `
        UPDATE orgs.workspaces
        SET
          status = $2,
          archived_at = CASE WHEN $2 = 'archived' THEN NOW() ELSE NULL END,
          archived_by = CASE WHEN $2 = 'archived' THEN $3 ELSE NULL END,
          updated_at = NOW()
        WHERE id = $1 AND kind = 'team'
        RETURNING id, name, description, business_unit, status, archived_at, archived_by, created_at;
      `,
      [groupId, status, actingUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const counts = await this.getCountsForGroups([row.id]);
    return this.toGroup(row, counts.get(row.id));
  }

  async listMembers(groupId: string): Promise<GroupMemberRecord[]> {
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id,
          CASE WHEN user_profile.app_role = 'member' THEN 'member' ELSE 'admin' END AS role,
          member.member_status,
          member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
          member.created_at,
          user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1
        ORDER BY
          CASE member.member_status WHEN 'active' THEN 1 WHEN 'invited' THEN 2 ELSE 3 END,
          CASE WHEN user_profile.app_role = 'member' THEN 2 ELSE 1 END,
          lower(user_profile.login) ASC;
      `,
      [groupId],
    );
    return result.rows.map((row) => this.toMember(row));
  }

  async findMemberById(
    groupId: string,
    memberId: string,
  ): Promise<GroupMemberRecord | null> {
    const result = await this.databaseService.query<MemberRow>(
      `
        SELECT
          member.id, member.workspace_id, member.user_id, member.role, member.member_status,
          member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
          member.created_at,
          user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
        FROM orgs.workspace_members AS member
        JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
        WHERE member.workspace_id = $1 AND member.id = $2;
      `,
      [groupId, memberId],
    );
    const row = result.rows[0];
    return row ? this.toMember(row) : null;
  }

  async countActiveOwners(groupId: string): Promise<number> {
    const result = await this.databaseService.query<{ count: number }>(
      `
        SELECT count(*)::int AS count
        FROM orgs.workspace_members
        WHERE workspace_id = $1 AND role = 'admin' AND member_status = 'active';
      `,
      [groupId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateMemberRole(
    groupId: string,
    memberId: string,
    role: GroupRole,
  ): Promise<GroupMemberRecord | null> {
    await this.databaseService.query(
      `
        UPDATE orgs.workspace_members
        SET role = $3
        WHERE workspace_id = $1 AND id = $2;
      `,
      [groupId, memberId, role],
    );
    return this.findMemberById(groupId, memberId);
  }

  /** Offboarding — recorded event, not a hard delete (plan §2.4). */
  async markMemberRemoved(
    groupId: string,
    memberId: string,
    removedBy: string,
    reason?: string | null,
  ): Promise<GroupMemberRecord | null> {
    await this.databaseService.query(
      `
        UPDATE orgs.workspace_members
        SET member_status = 'removed', removed_at = NOW(), removed_by = $3, removal_reason = $4
        WHERE workspace_id = $1 AND id = $2;
      `,
      [groupId, memberId, removedBy, reason ?? null],
    );
    return this.findMemberById(groupId, memberId);
  }

  /**
   * Race-free "last owner" guard for a role change (ciso finding, plan §3.3
   * "last-manager protection ... race-condition safety in the transaction
   * handling"). The naive check-then-act pattern (SELECT count, then
   * UPDATE in two separate statements — see the now-unused combination of
   * countActiveOwners + updateMemberRole above) lets two concurrent
   * requests each read "2 active owners" before either commits, and both
   * proceed, leaving the Group with zero owners. This method closes that
   * window by taking a row lock (`FOR UPDATE`) on every active-owner row of
   * the Group inside a single transaction before deciding — a second,
   * concurrent call for the same Group blocks on that lock until the first
   * transaction commits or rolls back, so the owner count it eventually
   * reads is never stale.
   */
  async changeMemberRoleGuarded(
    groupId: string,
    memberId: string,
    role: GroupRole,
  ): Promise<{ member: GroupMemberRecord | null; blockedLastOwner: boolean }> {
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `
            SELECT id FROM orgs.workspace_members
            WHERE workspace_id = $1 AND role = 'admin' AND member_status = 'active'
            FOR UPDATE;
          `,
          [groupId],
        );

        const targetResult = await client.query<MemberRow>(
          `
            SELECT
              member.id, member.workspace_id, member.user_id, member.role, member.member_status,
              member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
              member.created_at,
              user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
            FROM orgs.workspace_members AS member
            JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
            WHERE member.workspace_id = $1 AND member.id = $2
            FOR UPDATE OF member;
          `,
          [groupId, memberId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return { member: null, blockedLastOwner: false };
        }

        if (target.role === 'admin' && role !== 'admin') {
          const countResult = await client.query<{ count: number }>(
            `
              SELECT count(*)::int AS count FROM orgs.workspace_members
              WHERE workspace_id = $1 AND role = 'admin' AND member_status = 'active';
            `,
            [groupId],
          );
          const ownerCount = Number(countResult.rows[0]?.count ?? 0);
          if (ownerCount <= 1) {
            await client.query('ROLLBACK');
            return { member: this.toMember(target), blockedLastOwner: true };
          }
        }

        await client.query(
          `UPDATE orgs.workspace_members SET role = $3 WHERE workspace_id = $1 AND id = $2;`,
          [groupId, memberId, role],
        );
        await client.query('COMMIT');

        return {
          member: this.toMember({ ...target, role }),
          blockedLastOwner: false,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * Same race-free lock pattern as changeMemberRoleGuarded (see that
   * method's comment), applied to member removal — the other path that can
   * orphan a Group of its last owner (source plan §11 "must keep at least
   * one owner").
   */
  async removeMemberGuarded(
    groupId: string,
    memberId: string,
    removedBy: string,
    reason?: string | null,
  ): Promise<{ member: GroupMemberRecord | null; blockedLastOwner: boolean }> {
    return this.databaseService.withClient(async (client) => {
      await client.query('BEGIN');
      try {
        await client.query(
          `
            SELECT id FROM orgs.workspace_members
            WHERE workspace_id = $1 AND role = 'admin' AND member_status = 'active'
            FOR UPDATE;
          `,
          [groupId],
        );

        const targetResult = await client.query<MemberRow>(
          `
            SELECT
              member.id, member.workspace_id, member.user_id, member.role, member.member_status,
              member.invited_by, member.invited_at, member.removed_at, member.removed_by, member.removal_reason,
              member.created_at,
              user_profile.login, user_profile.display_name, user_profile.email, user_profile.avatar_url
            FROM orgs.workspace_members AS member
            JOIN identity.app_users AS user_profile ON user_profile.id = member.user_id
            WHERE member.workspace_id = $1 AND member.id = $2
            FOR UPDATE OF member;
          `,
          [groupId, memberId],
        );
        const target = targetResult.rows[0];
        if (!target) {
          await client.query('ROLLBACK');
          return { member: null, blockedLastOwner: false };
        }

        if (target.role === 'admin') {
          const countResult = await client.query<{ count: number }>(
            `
              SELECT count(*)::int AS count FROM orgs.workspace_members
              WHERE workspace_id = $1 AND role = 'admin' AND member_status = 'active';
            `,
            [groupId],
          );
          const ownerCount = Number(countResult.rows[0]?.count ?? 0);
          if (ownerCount <= 1) {
            await client.query('ROLLBACK');
            return { member: this.toMember(target), blockedLastOwner: true };
          }
        }

        await client.query(
          `
            UPDATE orgs.workspace_members
            SET member_status = 'removed', removed_at = NOW(), removed_by = $3, removal_reason = $4
            WHERE workspace_id = $1 AND id = $2;
          `,
          [groupId, memberId, removedBy, reason ?? null],
        );
        await client.query('COMMIT');

        return {
          member: this.toMember({ ...target, member_status: 'removed' }),
          blockedLastOwner: false,
        };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }

  /**
   * Grants membership immediately — there is no invitation and no pending
   * state. Upserting on (workspace_id, user_id) makes re-adding a previously
   * removed member a reinstatement rather than a unique violation.
   *
   * invited_by / invited_at keep their column names (renaming them would be a
   * migration for no behavioural gain) but now record who added the member and
   * when.
   */
  async addMemberDirect(
    groupId: string,
    userId: string,
    role: GrantableRole,
    addedBy: string,
  ): Promise<void> {
    await this.databaseService.query(
      `
        INSERT INTO orgs.workspace_members (workspace_id, user_id, role, member_status, invited_by, invited_at)
        VALUES ($1, $2, $3, 'active', $4, NOW())
        ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET role = EXCLUDED.role, member_status = 'active', removed_at = NULL, removed_by = NULL, removal_reason = NULL;
      `,
      [groupId, userId, role, addedBy],
    );
  }

  /** Resolves an internal user by login or email (approved internal directory, plan §6 open question #2). */
  async findInternalUserByLoginOrEmail(
    loginOrEmail: string,
  ): Promise<{ id: string } | null> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT id
        FROM identity.app_users
        WHERE (lower(login) = lower($1) OR lower(email) = lower($1))
          AND is_internal = true
        LIMIT 1;
      `,
      [loginOrEmail],
    );
    return result.rows[0] ?? null;
  }

  async findInternalUserById(userId: string): Promise<{ id: string } | null> {
    const result = await this.databaseService.query<{ id: string }>(
      `
        SELECT id
        FROM identity.app_users
        WHERE id = $1 AND is_internal = true
        LIMIT 1;
      `,
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async searchEligibleInternalUsers(
    groupId: string,
    search: string,
    limit = 20,
  ): Promise<InternalUserDirectoryEntry[]> {
    const result = await this.databaseService.query<{
      id: string;
      login: string;
      display_name: string | null;
      email: string | null;
      avatar_url: string | null;
    }>(
      `
        SELECT app_user.id, app_user.login, app_user.display_name, app_user.email, app_user.avatar_url
        FROM identity.app_users AS app_user
        WHERE app_user.is_internal = true
          AND (
            lower(app_user.login) LIKE lower($2)
            OR lower(COALESCE(app_user.display_name, '')) LIKE lower($2)
            OR lower(COALESCE(app_user.email, '')) LIKE lower($2)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orgs.workspace_members AS member
            WHERE member.workspace_id = $1
              AND member.user_id = app_user.id
              AND member.member_status = 'active'
          )
        ORDER BY lower(app_user.login) ASC
        LIMIT $3;
      `,
      [groupId, `%${search}%`, limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      login: row.login,
      name: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      hasAccount: true,
    }));
  }

  /**
   * Resolves a batch of GitHub logins to AlphaCI accounts, flagging any that
   * are already an active member of the given Group. Used to cross-reference
   * the GitHub org roster against local accounts for the member picker.
   *
   * Only INTERNAL accounts count as "has an account" — the same gate
   * GroupMembersService.addMember applies. An org member who has signed in but
   * is not internal is reported hasAccount:false and shown disabled, rather
   * than being offered and rejected on submit.
   */
  async findAccountsByLogins(
    groupId: string,
    logins: string[],
  ): Promise<DirectoryAccountRecord[]> {
    if (logins.length === 0) return [];
    const result = await this.databaseService.query<{
      id: string;
      login: string;
      display_name: string | null;
      email: string | null;
      avatar_url: string | null;
      is_active_member: boolean;
    }>(
      `
        SELECT
          app_user.id, app_user.login, app_user.display_name,
          app_user.email, app_user.avatar_url,
          EXISTS (
            SELECT 1 FROM orgs.workspace_members AS member
            WHERE member.workspace_id = $1
              AND member.user_id = app_user.id
              AND member.member_status = 'active'
          ) AS is_active_member
        FROM identity.app_users AS app_user
        WHERE lower(app_user.login) = ANY($2::text[])
          -- Must match findInternalUserById's gate exactly. Without this a
          -- non-internal account renders as selectable in the picker and then
          -- fails the add with a 404 the UI cannot explain.
          AND app_user.is_internal = true;
      `,
      [groupId, logins.map((login) => login.toLowerCase())],
    );
    return result.rows.map((row) => ({
      id: row.id,
      login: row.login,
      name: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      isActiveMember: row.is_active_member,
    }));
  }

  private toGroup(
    row: GroupRow,
    counts?: { memberCount: number; systemCount: number },
  ): GroupRecord {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      businessUnit: row.business_unit,
      status: row.status,
      archivedAt: row.archived_at,
      archivedBy: row.archived_by,
      createdAt: row.created_at,
      memberCount: counts?.memberCount ?? 0,
      systemCount: counts?.systemCount ?? 0,
      ...(row.role ? { role: row.role } : {}),
    };
  }

  private toMember(row: MemberRow): GroupMemberRecord {
    return {
      id: row.id,
      groupId: row.workspace_id,
      userId: row.user_id,
      role: row.role,
      memberStatus: row.member_status,
      login: row.login,
      name: row.display_name ?? row.login,
      email: row.email,
      avatarUrl: row.avatar_url,
      invitedBy: row.invited_by ?? null,
      invitedAt: row.invited_at,
      removedAt: row.removed_at,
      removedBy: row.removed_by ?? null,
      removalReason: row.removal_reason ?? null,
      createdAt: row.created_at,
    };
  }

  /**
   * Hard-deletes a Group (team workspace). FK cascades remove its members,
   * invitations, systems, delivery projects and hierarchy repositories; any
   * provisioned_projects rows survive with workspace_id set to NULL (ON DELETE
   * SET NULL), i.e. their GitHub repos are detached to "individual", never
   * destroyed. Returns false when no such team workspace existed.
   */
  async deleteGroup(groupId: string): Promise<boolean> {
    const result = await this.databaseService.query(
      `DELETE FROM orgs.workspaces WHERE id = $1 AND kind = 'team';`,
      [groupId],
    );
    return (result.rowCount ?? 0) > 0;
  }

}
