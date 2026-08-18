/**
 * scripts/check-github-team-setup.ts
 *
 * Read-only preflight for the GitHub team role sync
 * (docs/GITHUB-TEAMS-INTEGRATION-PLAN.md).
 *
 * Phase 0 — adding org "Members: Read" to the GitHub App and subscribing it to
 * Member/Team webhook events — happens in GitHub's UI, outside this codebase.
 * Every safety rule in GithubTeamRoleService treats an unreadable GitHub
 * response as "change nothing", which is correct but also silent: a missing
 * permission looks exactly like a working system where nobody ever gets
 * promoted. This script makes that difference visible BEFORE you flip
 * GITHUB_TEAM_ROLE_SYNC to enforce.
 *
 * Makes no writes — GET requests and SELECTs only.
 *
 * Usage:
 *   npm run check:github-teams
 *
 * Environment (read from the normal BE .env):
 *   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY  — to mint an installation token
 *   GITHUB_ENFORCED_ORG                     — the org to inspect
 *   GITHUB_TEAM_LEAD_SLUG / GITHUB_TEAM_DEVELOPER_SLUG
 *   GITHUB_TEAM_ROLE_SYNC                   — reported, not required
 *   SUPABASE_DB_URL                         — optional; enables the DB checks
 */

import { createSign } from 'node:crypto';

import { Client } from 'pg';

import { postgresSslConfig } from '../src/modules/database/postgres-ssl.config';

const GITHUB_API = 'https://api.github.com';
const USER_AGENT = 'cicd-workflow-product';

const org = (process.env['GITHUB_ENFORCED_ORG'] ?? 'Alpha-Explora').trim();
const leadTeam = (process.env['GITHUB_TEAM_LEAD_SLUG'] ?? 'team-lead').trim();
const developerTeam = (
  process.env['GITHUB_TEAM_DEVELOPER_SLUG'] ?? 'developers'
).trim();
const syncMode = (process.env['GITHUB_TEAM_ROLE_SYNC'] ?? 'off').trim();
const appId = (
  process.env['GITHUB_APP_ID'] ??
  process.env['GITHUB_APP'] ??
  ''
).trim();
const appPrivateKey = (
  process.env['GITHUB_APP_PRIVATE_KEY'] ??
  process.env['GITHUB_PRIVATE_KEY'] ??
  ''
).replace(/\\n/g, '\n');
const dbUrl = process.env['SUPABASE_DB_URL'];

let failures = 0;
let warnings = 0;

function pass(label: string, detail = ''): void {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
}
function warn(label: string, detail = ''): void {
  warnings += 1;
  console.log(`  WARN  ${label}${detail ? ` — ${detail}` : ''}`);
}
function fail(label: string, detail = ''): void {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/**
 * Returns null (having already reported the failure) when the key cannot sign.
 *
 * A wrong GITHUB_APP_PRIVATE_KEY surfaces from node:crypto as
 * "error:1E08010C:DECODER routines::unsupported", which says nothing about
 * what is actually wrong. The shape is checked first so the report names the
 * real problem — a value that is not a PEM at all is by far the most common
 * case (an app id, a webhook secret, or a placeholder pasted into the slot).
 */
function appJwt(): string | null {
  if (!appPrivateKey.includes('-----BEGIN')) {
    fail(
      'GITHUB_APP_PRIVATE_KEY is a PEM key',
      `value is ${String(appPrivateKey.length)} chars and has no "-----BEGIN" header — this is not an RSA private key. Paste the App's .pem (newlines may be escaped as \\n).`,
    );
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const b64 = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iat: now - 60,
    exp: now + 540,
    iss: appId,
  })}`;

  try {
    const signature = createSign('RSA-SHA256')
      .update(unsigned)
      .sign(appPrivateKey, 'base64url');
    return `${unsigned}.${signature}`;
  } catch (error) {
    fail(
      'GITHUB_APP_PRIVATE_KEY is usable',
      `signing failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function gh(
  path: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON error body — keep the raw text
  }
  return { status: response.status, body };
}

async function resolveInstallationToken(): Promise<string | null> {
  const jwt = appJwt();
  if (!jwt) return null;
  const installation = await gh(
    `/orgs/${encodeURIComponent(org)}/installation`,
    jwt,
  );
  if (installation.status !== 200) {
    fail(
      `GitHub App installed on ${org}`,
      `GET /orgs/${org}/installation returned ${String(installation.status)}. Install the App on the org.`,
    );
    return null;
  }
  const installationId = (installation.body as { id?: number }).id;
  if (!installationId) {
    fail(`GitHub App installed on ${org}`, 'installation payload had no id');
    return null;
  }
  pass(
    `GitHub App installed on ${org}`,
    `installation ${String(installationId)}`,
  );

  const tokenResponse = await fetch(
    `${GITHUB_API}/app/installations/${String(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
      },
    },
  );
  if (!tokenResponse.ok) {
    fail(
      'Installation access token',
      `POST access_tokens returned ${String(tokenResponse.status)}`,
    );
    return null;
  }
  pass('Installation access token', 'minted');
  return ((await tokenResponse.json()) as { token: string }).token;
}

async function checkTeam(
  slug: string,
  token: string,
  role: string,
): Promise<string[]> {
  const team = await gh(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}`,
    token,
  );
  if (team.status === 404) {
    fail(
      `Team "${slug}" exists`,
      `not found in ${org}. Create it, or point GITHUB_TEAM_*_SLUG at the real slug.`,
    );
    return [];
  }
  if (team.status !== 200) {
    fail(`Team "${slug}" exists`, `lookup returned ${String(team.status)}`);
    return [];
  }
  pass(`Team "${slug}" exists`, `→ app_role '${role}'`);

  const members = await gh(
    `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(slug)}/members?per_page=100`,
    token,
  );
  if (members.status !== 200) {
    fail(
      `Roster for "${slug}" readable`,
      `returned ${String(members.status)} — the App is missing org "Members: Read".`,
    );
    return [];
  }
  const logins = (members.body as Array<{ login: string }>).map((m) => m.login);
  if (logins.length === 0) {
    // The sweep refuses to act on an empty roster because empty is
    // indistinguishable from unreadable — so an empty team means no sync.
    warn(
      `Roster for "${slug}" readable`,
      'team is EMPTY — reconciliation will refuse to act on it',
    );
  } else {
    pass(`Roster for "${slug}" readable`, `${String(logins.length)} member(s)`);
  }
  return logins;
}

async function checkDatabase(): Promise<void> {
  section('Database');
  if (!dbUrl) {
    warn('SUPABASE_DB_URL set', 'skipping DB checks');
    return;
  }

  // Reuse the app's own SSL resolver rather than hand-rolling one here.
  // SUPABASE_DB_CA_CERT is commonly stored with escaped \n, which a raw pass
  // silently turns into an invalid cert and a misleading "self-signed
  // certificate in certificate chain" — postgresSslConfig normalizes it.
  const client = new Client({
    connectionString: dbUrl,
    ssl: postgresSslConfig(dbUrl, process.env['SUPABASE_DB_CA_CERT']),
  });

  try {
    await client.connect();

    const column = await client.query<{ exists: boolean }>(
      `SELECT TRUE AS exists
       FROM information_schema.columns
       WHERE table_schema = 'identity'
         AND table_name = 'app_users'
         AND column_name = 'app_role_source'
       LIMIT 1;`,
    );
    if (column.rows.length === 0) {
      fail(
        'Migration 20260817000000_app_role_source applied',
        'identity.app_users.app_role_source is missing — role sync cannot run',
      );
      return;
    }
    pass('Migration 20260817000000_app_role_source applied');

    const counts = await client.query<{ app_role_source: string; n: string }>(
      `SELECT app_role_source, COUNT(*)::text AS n
       FROM identity.app_users
       WHERE archived_at IS NULL
       GROUP BY app_role_source;`,
    );
    for (const row of counts.rows) {
      pass(`Users with source '${row.app_role_source}'`, row.n);
    }

    const linkable = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
       FROM projects.provisioned_projects AS pp
       JOIN orgs.workspaces AS w ON w.id = pp.workspace_id AND w.kind = 'team'
       WHERE pp.status <> 'orphaned'
         AND NOT EXISTS (
           SELECT 1 FROM hierarchy.repositories AS hr
           WHERE hr.provisioned_project_id = pp.id
         );`,
    );
    const unlinked = Number(linkable.rows[0]?.n ?? '0');
    if (unlinked > 0) {
      warn(
        'Group projects linked into the hierarchy',
        `${String(unlinked)} still unlinked — apply 20260818000000_link_group_projects_to_hierarchy.sql`,
      );
    } else {
      pass('Group projects linked into the hierarchy', 'none outstanding');
    }
  } catch (error) {
    fail(
      'Database reachable',
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  console.log(`GitHub team role sync preflight — org "${org}"`);

  section('Configuration');
  console.log(`  INFO  GITHUB_TEAM_ROLE_SYNC = ${syncMode}`);
  if (syncMode === 'off') {
    warn(
      'Sync mode',
      "'off' — nothing syncs yet. Set 'seed' then 'enforce' once this preflight is clean.",
    );
  } else {
    pass('Sync mode', syncMode);
  }

  if (!appId || !appPrivateKey) {
    fail(
      'GitHub App credentials',
      'GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY missing — cannot check anything else',
    );
    console.log('\nRESULT: not ready.');
    process.exit(1);
  }
  pass('GitHub App credentials', 'present');

  // Phase 4a (immediate propagation on team membership change) rides on the
  // `membership` webhook, and handleWebhook rejects every delivery when the
  // secret is unset. Without it only the login path and the periodic sweep
  // propagate — which still works, just slower.
  if (!(process.env['GITHUB_APP_WEBHOOK_SECRET'] ?? '').trim()) {
    warn(
      'GITHUB_APP_WEBHOOK_SECRET set',
      'unset — `membership` webhooks are rejected, so role changes wait for the next login or reconciliation sweep',
    );
  } else {
    pass('GITHUB_APP_WEBHOOK_SECRET set');
  }

  section('GitHub');
  const token = await resolveInstallationToken();
  if (token) {
    const members = await gh(
      `/orgs/${encodeURIComponent(org)}/members?per_page=1`,
      token,
    );
    if (members.status === 200) {
      pass('Org "Members: Read" permission', 'granted');
    } else {
      fail(
        'Org "Members: Read" permission',
        `GET /orgs/${org}/members returned ${String(members.status)} — add it to the App and re-approve the installation (Phase 0).`,
      );
    }

    const leads = await checkTeam(leadTeam, token, 'lead');
    const developers = await checkTeam(developerTeam, token, 'member');

    const both = leads.filter((login) =>
      developers.some((d) => d.toLowerCase() === login.toLowerCase()),
    );
    if (both.length > 0) {
      // Not an error: resolveRoleFromTeams checks team-lead first and
      // short-circuits, so lead wins. Worth stating so it is not a surprise.
      warn(
        'Users in BOTH teams',
        `${both.join(', ')} — team-lead wins, they resolve to 'lead'`,
      );
    }
  }

  await checkDatabase();

  section('Result');
  if (failures > 0) {
    console.log(
      `  NOT READY — ${String(failures)} failure(s), ${String(warnings)} warning(s).`,
    );
    process.exit(1);
  }
  console.log(
    `  READY — 0 failures, ${String(warnings)} warning(s). Safe to set GITHUB_TEAM_ROLE_SYNC=enforce.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
