/**
 * scripts/apply-migrations.ts
 *
 * Applies named migration files from supabase/migrations against
 * SUPABASE_DB_URL, each inside its own transaction.
 *
 * Follows the same shape as scripts/hierarchy-migrations.cjs (read the .sql,
 * send it, no external tooling) with two differences: TLS is verified against
 * the pinned CA via the app's own postgresSslConfig rather than
 * `rejectUnauthorized: false`, and each file runs in a transaction so a
 * failure half-way leaves nothing behind.
 *
 * Usage:
 *   npm run db:apply -- 20260817000000_app_role_source.sql
 *   npm run db:apply -- <a>.sql <b>.sql        # applied in the order given
 *
 * Every migration this is used with must be idempotent — re-running is a
 * normal recovery step, not an error.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Client } from 'pg';

import { postgresSslConfig } from '../src/modules/database/postgres-ssl.config';

const files = process.argv.slice(2);
const dbUrl = process.env['SUPABASE_DB_URL'];

async function main(): Promise<void> {
  if (files.length === 0) {
    throw new Error(
      'Usage: npm run db:apply -- <migration.sql> [more.sql ...]',
    );
  }
  if (!dbUrl) {
    throw new Error('SUPABASE_DB_URL is required');
  }

  // Read every file up front: a typo in the third filename should fail before
  // the first migration has touched the database.
  const migrations = files.map((name) => ({
    name,
    sql: readFileSync(
      join(__dirname, '..', 'supabase', 'migrations', name),
      'utf8',
    ),
  }));

  const client = new Client({
    connectionString: dbUrl,
    ssl: postgresSslConfig(dbUrl, process.env['SUPABASE_DB_CA_CERT']),
  });

  await client.connect();
  console.log(`Connected to ${new URL(dbUrl).hostname}\n`);

  try {
    for (const migration of migrations) {
      process.stdout.write(`Applying ${migration.name} ... `);
      try {
        await client.query('BEGIN');
        await client.query(migration.sql);
        await client.query('COMMIT');
        console.log('ok');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        console.log('FAILED');
        throw error;
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }

  console.log(`\nApplied ${String(migrations.length)} migration(s).`);
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
