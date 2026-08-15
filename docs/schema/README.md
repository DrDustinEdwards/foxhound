# Data layer (Drizzle + D1)

The Foxhound data layer: Drizzle schema, D1 migrations, query helpers, and the
legacy transform. Design is governed by `docs/canon/SCHEMA.md`; column truth and
dispositions are in `docs/schema/legacy-map.md`.

## Layout

| Path | What |
|---|---|
| `app/db/schema.ts` | The Drizzle SQLite schema (49 tables). Single source of table definitions. |
| `app/db/client.ts` | `getDb(env)` -> typed Drizzle client bound to the `DB` D1 binding. |
| `app/db/scope.ts` | Account-scoping helpers (`byAccount`, `byAccountActive`). |
| `app/db/billable.ts` | THE billable-recovery predicate (`getBillableRecoveries`). No phase reimplements it. |
| `app/db/money-write.ts` | Money-write type contract (Phase 4 routes it through the per-account DO). |
| `app/db/index.ts` | Data-layer entry point; import from `~/db`. |
| `app/lib/constants.ts` | Centralized fees, maturity window, canon enum value sets. |
| `drizzle.config.ts` | drizzle-kit config (generate only). |
| `drizzle/migrations/` | Generated SQL migrations + drizzle meta. Applied by wrangler. |
| `scripts/transform-legacy-to-staging.mjs` | Checksummed, idempotent legacy -> staging transform. |

## Conventions (SCHEMA.md + ARCHITECTURE.md)

- ids: `text` uuid string, app-generated via `crypto.randomUUID()`.
- timestamps: `integer` epoch **milliseconds** (`mode: 'timestamp_ms'`).
- booleans: `integer` 0/1 (`mode: 'boolean'`).
- json / arrays: `text` (`mode: 'json'`).
- money: `integer` cents, always paired with a `currency` column in the same row.
- enums: CHECK constraints only for the four canon-defined enums (attribution_kind,
  dispute state, billing line-item type, engagement event type). Legacy text columns
  whose value sets were not probed stay plain `text`.
- Every tenant table has `account_id` + an index.

## Migrations

Migrations are Drizzle-generated and applied with wrangler (which tracks applied
state in a `d1_migrations` table; `migrations_dir` is set per-database in
`wrangler.jsonc`).

```bash
# 1. regenerate after any schema.ts change
npm run db:generate

# 2. apply (idempotent; wrangler skips already-applied migrations)
npm run db:migrate                        # LOCAL database only. Safe default.
npm run db:migrate -- --remote-confirm    # REMOTE, i.e. PRODUCTION. Deliberate.
```

Corrected 2026-08-11. This section previously named `db:migrate:staging` and
`db:migrate:production`, and passed `--env staging` / `--env production`.
**Neither script exists, and neither `--env` does either**: `wrangler.jsonc`
declares a single environment with no `env.*` blocks. Following the old
instructions produced a script-not-found error, and the natural recovery was to
reach for the one script that did exist, which was an unguarded `--remote`
against live data.

**Read this before running the remote form.** The database bound as `DB` is
named `foxhound` and **is the production database**. The single-environment
`wrangler.jsonc` binds it to the Worker serving foxhoundapp.com. Since ruling 301
the name simply matches the thing: there is no leftover label to read past and no
second database to confuse it with. Every `--remote` command naming `foxhound`
writes to production.

`npm run db:migrate` therefore defaults to the local database and refuses the
remote one unless you pass `--remote-confirm` (or set `DB_MIGRATE_CONFIRM=1`,
which is what CI does). See `scripts/db-migrate.mjs`. CI applies migrations
after `verify` and before the deploy, so schema always precedes code.

Migration `0001` (post-review hardening) adds the win_back_steps account index
and `currency` columns to `accounts` and `customer_context`; it is purely
additive (see legacy-map.md).

Verified on apply: all tables/indexes present; CHECK constraints reject bad values
(`engagement_events_type_ck`); the billing line-item unique keys reject a second
line item per recovery/dispute (structural no-double-billing); FKs are declared and
**enforced** by D1.

## Transform (legacy -> staging)

One-time / re-runnable transform of the KEEP content/reference tables (blog_posts,
benchmark_data, social_*). Tenant data is demo-only and re-seeded, not migrated
(see legacy-map.md). Reads legacy read-only over the PostgREST REST API; writes
staging D1 via idempotent upserts (`INSERT ... ON CONFLICT(id) DO UPDATE`).

```bash
# credentials are read from the environment, never committed or logged
export SUPABASE_URL=...              # legacy project REST URL
export SUPABASE_SERVICE_ROLE_KEY=... # used SELECT-only

node scripts/transform-legacy-to-staging.mjs --dry-run   # fetch + generate SQL only
node scripts/transform-legacy-to-staging.mjs             # import + verify
```

The script reports per-table row-count parity and sha256 checksums (computed
identically on both sides) and exits non-zero on any mismatch. Re-running changes
nothing (upserts; a second run leaves every checksum byte-identical). Generated SQL
and the report land in `scripts/out/` (gitignored).

## Binding and environment facts

- Code binding: `DB`.
- D1 databases: `foxhound` (`3ad240ed-de30-4684-a181-1da33ea08b65`), the live
  one. `foxhound-production` (`7469d599-8556-4958-aad2-39bddf79b4de`) is the
  frozen pre-rename snapshot from ruling 301 and is not deleted by any agent.
  Two earlier databases are GONE, retired by Dustin himself and measured
  unreachable 2026-08-15: `foxhound-staging` (`4aa23f57-244e-4e24-850c-66486e7ba92d`)
  and an old empty `foxhound-production` (`ae406c63-ede5-4031-b5fc-2e821565ac19`).
  **This list was garbled between 299 and 301 and is repaired here rather than
  patched again:** 299's sweep replaced the string `foxhound-staging` in this doc
  without noticing that a DIFFERENT database already carried the name it replaced
  it with, so the doc briefly asserted that the live database was also bound
  nowhere.
- **`foxhound` is the live production database.** It is the only D1 bound
  in `wrangler.jsonc`, which declares a single environment, and that Worker
  serves foxhoundapp.com. The name no longer needs reading past: the inversion
  this section used to warn about is what ruling 301 removed. Treat the
  truth.
- All Phase 2 work and verification ran on what was then staging; the two-
  environment split described elsewhere in this file predates the single-
  environment cutover.

## Better Auth boundary (Phase 3)

`user`, `session`, `account` (singular), and `verification` are **not** defined here;
Phase 3's Better Auth migration owns them. `account_members.user_id`,
`admin_audit_log.target_user_id`, and `intelligence_notification_preferences.user_id`
are soft references to `user.id` (stored as `text`, no enforced FK yet). Phase 3 wires
and verifies them. Our business `accounts` (plural) + `account_members` are separate
from Better Auth's singular `account` and do not collide.
