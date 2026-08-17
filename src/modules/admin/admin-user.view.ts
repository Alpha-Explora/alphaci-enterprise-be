import type {
  AdminUserActivityRow,
  AdminUserErrorRow,
  AdminUserListRow,
  AdminUserProjectRow,
  AdminUserSubscriptionRow,
  AdminUserWorkflowRow,
} from './admin.repository';
import type { AppRole, AppRoleSource } from './platform-admins.repository';

/**
 * View models returned to admins. These types DELIBERATELY have no field for any
 * secret (provider tokens, encrypted env values, CI token secrets, OAuth state).
 * Secrets are excluded at the query layer (admin.repository.ts) and the types here
 * make it impossible to accidentally serialize one.
 */
export interface AdminUserListItem {
  id: string;
  login: string;
  displayName: string | null;
  email: string | null;
  avatarUrl: string | null;
  provider: string;
  createdAt: string;
  lastLoginAt: string | null;
  archivedAt: string | null;
  onboardingCompleted: boolean;
  /** Global hierarchy role — assigned in the Admin Console or synced from GitHub. */
  appRole: AppRole;
  /**
   * Where appRole came from. 'manual' means an admin pinned it and automatic
   * GitHub team sync skips this user; 'github_team' means it follows the
   * org teams and can change on their next login.
   */
  appRoleSource: AppRoleSource;
  projectCount: number;
  errorCount: number;
}

export interface AdminUserDetail extends AdminUserListItem {
  subscription: {
    plan: string;
    planCode: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null;
  projects: AdminUserProjectRow[];
  workflows: AdminUserWorkflowRow[];
  recentErrors: AdminUserErrorRow[];
  recentActivity: AdminUserActivityRow[];
}

export function toAdminUserListItem(row: AdminUserListRow): AdminUserListItem {
  return redactSensitiveFields({
    id: row.id,
    login: row.login,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    provider: row.provider,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    archivedAt: row.archived_at,
    onboardingCompleted: row.onboarding_completed_at != null,
    appRole: row.app_role,
    appRoleSource: row.app_role_source,
    projectCount: row.project_count,
    errorCount: row.error_count,
  });
}

export function toAdminUserDetail(
  row: AdminUserListRow,
  parts: {
    subscription: AdminUserSubscriptionRow | null;
    projects: AdminUserProjectRow[];
    workflows: AdminUserWorkflowRow[];
    recentErrors: AdminUserErrorRow[];
    recentActivity: AdminUserActivityRow[];
  },
): AdminUserDetail {
  return {
    ...toAdminUserListItem(row),
    subscription: parts.subscription
      ? {
          plan: parts.subscription.plan,
          planCode: parts.subscription.plan_code,
          status: parts.subscription.status,
          currentPeriodEnd: parts.subscription.current_period_end,
        }
      : null,
    projects: parts.projects,
    workflows: parts.workflows,
    recentErrors: parts.recentErrors,
    recentActivity: parts.recentActivity,
  };
}

/**
 * redactSensitiveFields — the privacy boundary for admin-visible user data.
 *
 * The hard secrets (tokens, encrypted values) are already gone by this point.
 * What's left are GRAY-AREA fields where "metadata only" is a judgment call:
 *  - email: arguably PII you may not want every admin to see in full
 *  - (extend as the product adds fields, e.g. phone, billing name)
 *
 * This default is intentionally conservative-but-permissive: it passes email
 * through. Decide your policy here — e.g. mask email for non-super-admins, or
 * drop it entirely. This single function defines what an admin can and cannot
 * see about a user, so it's the right place for an explicit, reviewed decision
 * rather than an ad-hoc choice scattered across queries.
 *
 * TODO(you): adjust the redaction policy to match your privacy stance. For
 * example, to mask emails:  email: item.email ? maskEmail(item.email) : null
 */
export function redactSensitiveFields(
  item: AdminUserListItem,
): AdminUserListItem {
  return {
    ...item,
    // email passes through by default — change this line to mask/drop it.
    email: item.email,
  };
}
