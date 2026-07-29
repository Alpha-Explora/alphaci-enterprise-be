# Migration reconciliation — project `gxoflpycsxhtloiihfna`

Status of the repair performed on 2026-07-30 against the Supabase project
`https://gxoflpycsxhtloiihfna.supabase.co`.

## The problem

The migrations folder could not rebuild the database, and the drift ran in
**both** directions:

| Direction | Count | Meaning |
|---|---|---|
| Applied in DB, no file in repo | 14 | Schema existed that nothing in git could recreate |
| File in repo, not in ledger | 13 | Migrations applied by effect but never recorded |
| Filename version collisions | 12 files / 4 versions | CLI could not tell them apart |

The schema itself was **not** broken. Every object the "unapplied" repo
migrations create was verified present in the database — tables, columns, RLS
flags, and the `delegated_lead` role constraint. The damage was confined to
bookkeeping.

## What was fixed in the repo (done)

1. **Extracted 14 migrations** from `supabase_migrations.schema_migrations`
   into real files. The ledger stores original SQL including comments, so these
   are faithful, not decompiled. Line endings were normalised to LF.

   `20260606_domain_schema_bootstrap` · `20260701_gcp_runtime_expand_contract` ·
   `20260702_block_new_byo_provider_connections` · `20260706091358_identity_federation` ·
   `20260712000000_billing_profiles` · `20260712000100_remove_free_plan` ·
   `20260713000000_auth_session_handoffs` · `20260713000100_workspace_members_role_alignment` ·
   `20260713000200_workspace_subscriptions` · `20260714_payment_ledger` ·
   `20260715_recurring_subscriptions` · `20260716000000_payment_method_vault` ·
   `20260716000100_subscription_plan_catalog` · `20260718_plan_interval_catalog`

2. **Resolved the `20260702` collision.** The repo's `app_users_is_internal`
   and the ledger's `block_new_byo_provider_connections` both claimed version
   `20260702`. `app_users_is_internal` was renamed to `20260702000100` so the
   `20260702` slot matches the ledger.

3. **Renamed 13 files to their exact ledger versions.** Twelve files shared only
   four version numbers (`20260607` ×2, `20260614` ×4, `20260615` ×2,
   `20260617` ×4); `20260611_render_deployment_provisioning` was recorded as
   `20260611000000`. The CLI parses the version as the digits before the first
   underscore, so these were indistinguishable.

4. **Realigned 5 rollback filenames** in `rollbacks/` with their renamed partners.

Result: 54 migration files, zero duplicate versions, and **every one of the 41
ledger versions now has exactly one matching file**.

## Remaining step — ledger repair (NOT yet done)

Thirteen migrations exist as files and are applied in the database, but are
absent from the ledger. They must be **marked** applied, never re-run — most
would fail on duplicate columns or constraints.

```bash
supabase link --project-ref gxoflpycsxhtloiihfna

supabase migration repair --status applied \
  20260622063000 20260702000100 20260712 \
  20260713060000 20260713061000 20260713062000 20260713063000 20260713064000 \
  20260713120000 20260713130000 \
  20260714000000 20260714010000 20260729000000
```

Then confirm a clean three-column alignment:

```bash
supabase migration list --linked
```

### Verify before and after

```sql
SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version;
```

## Hazards

**`20260718_plan_interval_catalog` is destructive.** It opens by deleting every
row from `payment_refunds`, `payment_webhook_events`, `payment_attempts`,
`workspace_subscriptions`, `user_subscriptions`, `billing_profiles`, and
`subscription_plans` before reseeding the catalog. It carries its own warning:
never apply it to a database holding live customer billing history. It is
already applied here, and this project has no billing data (`subscription_plans`
holds the 6 seeded catalog rows; every other billing table is empty).

**`20260712_remove_demo_projects`** is a data migration. It is safe to repair as
applied — `projects.provisioned_projects` is empty, so it is vacuously satisfied.

**Row Level Security is disabled on 5 tables**, which the Supabase advisor rates
critical. They are exposed to `anon` and `authenticated`:

```sql
ALTER TABLE identity.app_users            ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects.provisioned_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscription_plans    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.user_subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.subscription_events   ENABLE ROW LEVEL SECURITY;
```

Enabling RLS without policies blocks all access. The backend uses the
service-role client, so the deny-by-default pattern already used by
`20260617000000_enable_rls_exposed_tables` (authorize in the API layer) is the
consistent choice — but this is a deliberate decision, not a mechanical fix.

## Note on the `public.*` tables

`public.app_users`, `public.subscription_plans`, `public.user_subscriptions`,
`public.outbox_events`, `public.workflow_generations`,
`public.github_installations`, and `public.github_installation_repos` are legacy
copies superseded by the domain schemas in `20260606_domain_schema_bootstrap`
and `20260609_backfill_projects_schema_from_public`. The backend's connection
sets `search_path=identity,billing,github_app,projects,…`, so unqualified queries
resolve to the domain tables, not these. They are dead weight, retained
deliberately by the backfill migration.
