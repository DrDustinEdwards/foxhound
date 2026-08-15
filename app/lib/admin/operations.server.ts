// /admin/operations data layer: D1 cap telemetry, deploy state, env sanity,
// migration status. ARCHITECTURE.md requires D1 size + per-table growth
// surfaced here, alert at 50% of the 10GB cap, from day one.

import { count } from "drizzle-orm";

import type { Db } from "~/db";
import {
  aiCalls,
  cronRunHistory,
  emailSends,
  engagementEvents,
  healthScoreHistory,
  page404Daily,
  socialLeads,
  webhookEvents,
} from "~/db";

/** D1's Workers-binding query metadata reports the live database size in bytes
 *  on every query (`D1Meta.size_after`), so a size read is just any cheap
 *  query's byproduct - no `dbstat`/pragma virtual table is needed. Confirmed
 *  2026-07-20 that `pragma_page_count()`/`pragma_page_size()` are NOT
 *  authorized on D1 (SQLITE_AUTH), so `size_after` is the only in-app source
 *  for this; there is no Cloudflare REST-API alternative reachable from inside
 *  the Worker without a new CLOUDFLARE_API_TOKEN secret, which is out of this
 *  pass's scope. This reads the raw D1 binding directly (not through Drizzle):
 *  Drizzle's d1 driver does not surface `.meta` on query results, and this is
 *  infrastructure telemetry, not a business-logic query (ARCHITECTURE.md's
 *  "Drizzle only" rule governs business logic; the schema comment in
 *  app/db/schema.ts scopes the raw-SQL ban the same way). */
export async function getD1SizeBytes(env: Env): Promise<number> {
  const result = await env.DB.prepare("SELECT 1").run();
  return result.meta.size_after;
}

/** Known applied-migration filenames, in order. Static: the Worker has no
 *  filesystem access to drizzle/migrations at runtime, and this list only
 *  changes when a new migration ships (a deploy-time event anyway).
 *
 *  Because it is maintained by hand it had drifted FOUR behind, stopping at 0005
 *  while the schema was at 0009, so /admin/operations under-reported the schema
 *  state on the page treated as the authoritative answer for exactly that.
 *  test/admin-known-migrations.test.ts now asserts this list against the actual
 *  .sql files on disk, so the next migration that ships without updating it fails
 *  CI instead of silently shrinking the page. */
export const KNOWN_MIGRATIONS = [
  "0000_init_foxhound_schema.sql",
  "0001_hardening_win_back_index_and_currency.sql",
  "0002_famous_reaper.sql",
  "0003_faithful_harrier.sql",
  "0004_narrow_annihilus.sql",
  "0005_stormy_vector.sql",
  "0006_spooky_gravity.sql",
  "0007_shallow_the_fallen.sql",
  "0008_hard_scream.sql",
  "0009_lethal_gladiator.sql",
  "0010_flimsy_hitman.sql",
  "0011_bouncy_whizzer.sql",
  "0012_solid_nightmare.sql",
  "0013_short_vulture.sql",
  "0014_flashy_rawhide_kid.sql",
  "0015_steady_azazel.sql",
  // 313: cron_alerts (the alert dedupe key), email_dead_letters (the DLQ trace),
  // and email_sends.cron_run_id (send-to-run attribution). All additive.
  "0016_steep_union_jack.sql",
] as const;

export interface MigrationStatusRow {
  name: string;
  applied: boolean;
  appliedAt: Date | null;
}

/** Pure diff: which known migrations are applied (with their timestamp), and
 *  which applied migration names aren't in the known list at all (a build
 *  that shipped a migration file this constant wasn't updated for). Split
 *  from the D1 read so the diff itself is unit-testable without a database. */
export function diffMigrations(
  known: readonly string[],
  appliedByName: Map<string, string>,
): { rows: MigrationStatusRow[]; unexpectedApplied: string[] } {
  const rows: MigrationStatusRow[] = known.map((name) => {
    const appliedAt = appliedByName.get(name);
    return { name, applied: appliedAt !== undefined, appliedAt: appliedAt ? new Date(appliedAt) : null };
  });
  const knownSet = new Set(known);
  const unexpectedApplied = [...appliedByName.keys()].filter((name) => !knownSet.has(name));
  return { rows, unexpectedApplied };
}

/** `d1_migrations` is wrangler's own migration-tracking table (created by
 *  `wrangler d1 migrations apply`); it is a normal queryable table, unlike the
 *  pragma virtual tables D1 blocks. Cross-referenced against KNOWN_MIGRATIONS
 *  (via diffMigrations) so a migration that shipped in code but never ran
 *  against this database is visibly flagged rather than silently absent. */
export async function getMigrationStatus(env: Env): Promise<{
  rows: MigrationStatusRow[];
  unexpectedApplied: string[];
}> {
  const result = await env.DB.prepare("SELECT name, applied_at FROM d1_migrations ORDER BY id").all<{
    name: string;
    applied_at: string;
  }>();
  const appliedByName = new Map(result.results.map((r) => [r.name, r.applied_at]));
  return diffMigrations(KNOWN_MIGRATIONS, appliedByName);
}

export interface GrowthTableRow {
  label: string;
  retentionPolicy: string;
  rowCount: number;
}

/** Row counts for every table ARCHITECTURE.md's retention table governs.
 *  Byte-level per-table breakdown isn't available from the binding (only the
 *  whole-database size_after is); row counts are the honest available signal. */
export async function getGrowthTableCounts(db: Db): Promise<GrowthTableRow[]> {
  const [
    engagementEventsCount,
    emailSendsCount,
    webhookEventsCount,
    healthScoreHistoryCount,
    cronRunHistoryCount,
    socialLeadsCount,
    page404DailyCount,
    aiCallsCount,
  ] = await Promise.all([
    db.select({ n: count() }).from(engagementEvents),
    db.select({ n: count() }).from(emailSends),
    db.select({ n: count() }).from(webhookEvents),
    db.select({ n: count() }).from(healthScoreHistory),
    db.select({ n: count() }).from(cronRunHistory),
    db.select({ n: count() }).from(socialLeads),
    db.select({ n: count() }).from(page404Daily),
    db.select({ n: count() }).from(aiCalls),
  ]);

  return [
    { label: "Engagement events", retentionPolicy: "180 days, then monthly aggregates", rowCount: engagementEventsCount[0]?.n ?? 0 },
    { label: "Email sends", retentionPolicy: "180 days", rowCount: emailSendsCount[0]?.n ?? 0 },
    { label: "Webhook events", retentionPolicy: "90 days", rowCount: webhookEventsCount[0]?.n ?? 0 },
    { label: "Health score history", retentionPolicy: "90 days raw, weekly rollups after", rowCount: healthScoreHistoryCount[0]?.n ?? 0 },
    { label: "Cron run history", retentionPolicy: "90 days", rowCount: cronRunHistoryCount[0]?.n ?? 0 },
    { label: "Social leads (non-actioned)", retentionPolicy: "180 days", rowCount: socialLeadsCount[0]?.n ?? 0 },
    { label: "Page 404s (daily aggregate)", retentionPolicy: "365 days", rowCount: page404DailyCount[0]?.n ?? 0 },
    { label: "AI calls", retentionPolicy: "90 days raw, monthly cost aggregates after", rowCount: aiCallsCount[0]?.n ?? 0 },
  ];
}

export type EnvSanityKind = "binding" | "var" | "secret";

export interface EnvSanityRow {
  name: string;
  kind: EnvSanityKind;
  set: boolean;
}

/** Every configured-or-configurable binding/var/secret this Worker uses, by
 *  NAME ONLY - values are never read or rendered here (ARCHITECTURE.md #5).
 *  Static list mirrors wrangler.jsonc + env.d.ts; kept in sync by hand since
 *  there is no runtime introspection of "what secrets exist" on Workers. */
export function getEnvSanity(env: Env): EnvSanityRow[] {
  const rows: Array<[string, EnvSanityKind]> = [
    ["DB", "binding"],
    // APP_KV was listed here until 310. The binding is gone from wrangler.jsonc
    // because `env.APP_KV` had ZERO consumers, and leaving it enumerated would
    // report a permanently-unset binding forever. This surface exists to show
    // what is MISSING, so a row that can never be set is noise that trains a
    // reader to ignore the column. The namespace itself is retained, unbound.
    ["MONEY_WRITER", "binding"],
    ["CRON_LOCK", "binding"],
    ["RATE_LIMITER", "binding"],
    ["BETTER_AUTH_URL", "var"],
    ["TURNSTILE_SITE_KEY", "var"],
    ["BETTER_AUTH_SECRET", "secret"],
    ["ADMIN_EMAIL", "secret"],
    ["ENCRYPTION_KEY", "secret"],
    ["STRIPE_SECRET_KEY", "secret"],
    ["STRIPE_CLIENT_ID", "secret"],
    ["STRIPE_WEBHOOK_SECRET", "secret"],
    ["STRIPE_PLATFORM_WEBHOOK_SECRET", "secret"],
    ["ANTHROPIC_API_KEY", "secret"],
    ["GOOGLE_CLIENT_ID", "secret"],
    ["GOOGLE_CLIENT_SECRET", "secret"],
    ["TURNSTILE_SECRET_KEY", "secret"],
    ["PHYSICAL_ADDRESS", "secret"],
    ["SENTRY_DSN", "secret"],
    ["EMAIL", "binding"],
  ];
  return rows.map(([name, kind]) => ({
    name,
    kind,
    set: Boolean((env as unknown as Record<string, unknown>)[name]),
  }));
}
