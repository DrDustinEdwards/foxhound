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
npm run db:migrate:staging      # wrangler d1 migrations apply foxhound-staging   --env staging   --remote
npm run db:migrate:production   # wrangler d1 migrations apply foxhound-production --env production --remote
```

Both databases carry identical structure (49 tables, 58 named indexes). Production
is structure-only; it takes no data until the Phase 9 cutover.

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

- Code binding: `DB` (both environments).
- D1 databases: `foxhound-staging` (`4aa23f57-244e-4e24-850c-66486e7ba92d`),
  `foxhound-production` (`ae406c63-ede5-4031-b5fc-2e821565ac19`).
- All Phase 2 work and verification ran on **staging**; production got structure only.

## Better Auth boundary (Phase 3)

`user`, `session`, `account` (singular), and `verification` are **not** defined here;
Phase 3's Better Auth migration owns them. `account_members.user_id`,
`admin_audit_log.target_user_id`, and `intelligence_notification_preferences.user_id`
are soft references to `user.id` (stored as `text`, no enforced FK yet). Phase 3 wires
and verifies them. Our business `accounts` (plural) + `account_members` are separate
from Better Auth's singular `account` and do not collide.
