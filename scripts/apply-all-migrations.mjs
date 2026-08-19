#!/usr/bin/env node
/**
 * Apply every migration in supabase/migrations, in filename order.
 *
 * scripts/apply-migrations.ts takes explicit filenames and applies each in its
 * own transaction. That is the right primitive, but there are 59 files and
 * typing them out is where a bootstrap goes wrong. This wraps it.
 *
 *   node scripts/apply-all-migrations.mjs --dry-run   # list, touch nothing
 *   node scripts/apply-all-migrations.mjs             # apply all, in order
 *   node scripts/apply-all-migrations.mjs --from 20260712000000_billing_profiles.sql
 *
 * Every migration in this repo is written to be idempotent, so re-running is a
 * normal recovery step rather than an error. If one fails, the run stops there:
 * later migrations frequently ALTER what earlier ones create, so continuing
 * past a failure produces a schema that matches no known state.
 *
 * Requires SUPABASE_DB_URL — the direct connection on port 5432, not the 6543
 * transaction pooler.
 */
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const migrationsDir = join(repoRoot, "supabase", "migrations");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fromIdx = args.indexOf("--from");
const from = fromIdx !== -1 ? args[fromIdx + 1] : null;

let files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort(); // filenames are timestamp-prefixed, so lexical order is chronological

if (from) {
  const start = files.indexOf(from);
  if (start === -1) {
    console.error(`--from ${from} is not in supabase/migrations`);
    process.exit(1);
  }
  files = files.slice(start);
}

console.log(`${files.length} migration(s) to apply\n`);

if (dryRun) {
  files.forEach((f, i) => console.log(`  ${String(i + 1).padStart(2)}. ${f}`));
  console.log("\ndry run — nothing was applied");
  process.exit(0);
}

if (!process.env.SUPABASE_DB_URL) {
  // db:apply loads .env itself via --env-file, so an unset variable here is
  // only a warning — but an empty one in .env is a real misconfiguration.
  console.log("note: SUPABASE_DB_URL not in this shell; db:apply reads .env\n");
}

let applied = 0;
for (const file of files) {
  process.stdout.write(`  [${String(++applied).padStart(2)}/${files.length}] ${file} ... `);
  const result = spawnSync("npm", ["run", "db:apply", "--", file], {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });

  if (result.status !== 0) {
    console.log("FAILED\n");
    console.error(result.stdout || "");
    console.error(result.stderr || "");
    console.error(
      `\nStopped at ${file}. Later migrations often ALTER what this one creates,\n` +
        `so continuing would leave the schema in an unknown state. Fix the cause,\n` +
        `then resume with:\n\n  node scripts/apply-all-migrations.mjs --from ${file}\n`,
    );
    process.exit(1);
  }
  console.log("ok");
}

console.log(`\nAll ${files.length} migration(s) applied.`);
