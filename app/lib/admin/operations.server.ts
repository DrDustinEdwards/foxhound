// /admin/operations data layer: the recovery queue's depth, cron-lock health,
// D1 cap telemetry, env sanity and migration status. ARCHITECTURE.md requires
// D1 size + per-table growth surfaced here, alert at 50% of the 10GB cap, from
// day one. The queue depth and the lock health are what Recova's Operations
// page showed (OperationsClient.tsx, blob 419a51ac), read from Foxhound's own
// engine (J71).

import { and, count, eq, isNotNull, isNull, min } from "drizzle-orm";

// drizzle-kit writes this on every `generate`, so it cannot fall behind the
// migrations it records. Bundled at build time; the Worker has no filesystem.
import migrationJournal from "../../../drizzle/migrations/meta/_journal.json";

import type { Db } from "~/db";
import { countActiveRecoveries } from "~/lib/admin/overview.server";
import { accountProcessingEligibleCondition, stepDueCondition } from "~/lib/cron/due-steps";
import { CRON_LOCK_PEEK_TIMEOUT_MS } from "~/lib/constants";
import { CRON_JOBS } from "~/lib/cron/registry";
import { cronLockHealth, type CronLockView } from "~/lib/cron/lock-state";
import {
  accounts,
  aiCalls,
  cronRunHistory,
  emailSends,
  engagementEvents,
  failedPayments,
  healthScoreHistory,
  page404Daily,
  recoverySteps,
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
 *  app/db/schema/ scopes the raw-SQL ban the same way). */
export async function getD1SizeBytes(env: Env): Promise<number> {
  const result = await env.DB.prepare("SELECT 1").run();
  return result.meta.size_after;
}

/** Applied-migration filenames, in order, DERIVED from drizzle's own journal.
 *
 *  THE HAND-MAINTAINED LIST IS GONE (317). It failed twice: it drifted FOUR
 *  behind in July (stopping at 0005 against a schema at 0009, so
 *  /admin/operations under-reported schema state on the page treated as the
 *  authoritative answer for exactly that), and it went red again at 316 when
 *  0017 shipped. A list that a human must remember to update is a defect
 *  generator, and the guard around it only converted silent drift into a CI
 *  failure someone still had to fix by hand.
 *
 *  `drizzle/migrations/meta/_journal.json` is written by `drizzle-kit generate`
 *  itself, so it cannot fall behind the migrations it records. Importing it is a
 *  plain JSON import (resolveJsonModule), bundled at BUILD time, which is what
 *  keeps this working in a Worker with no filesystem at runtime. Sorting by
 *  `idx` rather than trusting array order makes the ordering explicit, since
 *  `getMigrationStatus` renders these in sequence.
 *
 *  test/admin-known-migrations.test.ts still cross-checks against the actual
 *  .sql files on disk. That check is now the load-bearing one: it catches a
 *  migration file present without a journal entry, or a journal entry whose file
 *  is missing, neither of which the journal can self-report. */
export const KNOWN_MIGRATIONS: readonly string[] = [...migrationJournal.entries]
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => `${entry.tag}.sql`);

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
  /** Set but wrong, in words that never quote the value. */
  problem: string | null;
}

/**
 * STRIPE_SECRET_KEY must be a live key: Foxhound runs one production Worker,
 * claims and ignores every test-mode webhook and refuses a test-mode Connect
 * token, so a test key here connects nobody and recovers nothing. Only the
 * key's mode prefix is read, never the rest of it.
 */
function stripeKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !key) return null;
  return key.startsWith("sk_live_") || key.startsWith("rk_live_") ? null : "Not a live key";
}

/** Every configured-or-configurable binding/var/secret this Worker uses, by
 *  NAME ONLY - values are never rendered here (ARCHITECTURE.md #5), and the one
 *  value read at all is the Stripe key's mode prefix (stripeKeyProblem).
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
    // The five-minute ticker (app/lib/cron/ticker.ts). Unset means recovery,
    // win-back and dispute reminders run only when the */5 trigger fires.
    ["CRON_TICKER", "binding"],
    ["RATE_LIMITER", "binding"],
    ["AUTH_RATE_LIMITER", "binding"],
    // The nightly D1 dump bucket (job_f7f35d4b7ac7, bound under job_7bbec6ab48d1). Unset means the d1-backup
    // cron throws on every run and /health reports no backup.
    ["BACKUPS", "binding"],
    // The monthly audit queue producer (job_97878f0d1fde). Unset means the
    // monthly-audit cron fails on its first send and no account is audited.
    ["AUDIT_QUEUE", "binding"],
    // Merchant dispute evidence files (J07). Unset means uploads answer 503
    // uploads_unavailable and a submission goes to Stripe without files.
    ["EVIDENCE", "binding"],
    // The blog's media library (Carrel uploads, /media/*). Unset means every
    // media call and every /media file fails.
    ["MEDIA", "binding"],
    // Cloudflare Images: the blog pictures' sizes and Carrel's turns and
    // shrinks. Unset means /media serves originals only.
    ["IMAGES", "binding"],
    // Workers AI: the media library's suggested alt text and tags only.
    ["AI", "binding"],
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
    // Optional: unset simply means the Anthropic calls go direct rather
    // than through AI Gateway. Listed so the surface shows whether the
    // gateway is actually in front of them.
    ["AI_GATEWAY_BASE_URL", "secret"],
    ["AI_GATEWAY_TOKEN", "secret"],
    ["GOOGLE_CLIENT_ID", "secret"],
    ["GOOGLE_CLIENT_SECRET", "secret"],
    ["TURNSTILE_SECRET_KEY", "secret"],
    ["PHYSICAL_ADDRESS", "secret"],
    ["SENTRY_DSN", "secret"],
    // Read back by /admin/platform/errors (J48): optional, unset means the
    // page says it cannot read Sentry and names what is missing.
    ["SENTRY_AUTH_TOKEN", "secret"],
    ["SENTRY_ORG", "secret"],
    ["EMAIL", "binding"],
  ];
  const values = env as unknown as Record<string, unknown>;
  return rows.map(([name, kind]) => ({
    name,
    kind,
    set: Boolean(values[name]),
    problem: name === "STRIPE_SECRET_KEY" ? stripeKeyProblem(values[name]) : null,
  }));
}

export interface RecoveryQueueDepth {
  /** Failed payments in an active sequence, demo accounts not counted: Recova's
   *  "Payments in active recovery queue", the same count as the Overview's. */
  activePayments: number;
  /** Steps the recovery tick would run if it ran now: due, on an active payment,
   *  on an account it may process (not paused, canceled or demo). */
  dueSteps: number;
  /** When the longest-waiting of those steps fell due; null when none waits. */
  oldestDueAt: Date | null;
}

/** The recovery queue's depth, by the tick's own conditions (stepDueCondition
 *  and accountProcessingEligibleCondition), so this page and the tick never
 *  disagree about what is waiting. A step's due time is its next_retry_at when a
 *  send backoff set one, else its scheduled_at; the two are read apart and the
 *  earlier taken, so no SQL expression is written by hand. Read only. */
export async function getRecoveryQueueDepth(db: Db, now: number = Date.now()): Promise<RecoveryQueueDepth> {
  const at = new Date(now);
  const due = and(
    stepDueCondition(at),
    eq(failedPayments.status, "active"),
    accountProcessingEligibleCondition(),
  );
  // The tick's own joins: a step, its payment and its account.
  const onPayment = eq(failedPayments.id, recoverySteps.failedPaymentId);
  const onAccount = eq(accounts.id, recoverySteps.accountId);

  const [activePayments, counted, retried, scheduled] = await Promise.all([
    countActiveRecoveries(db),
    db
      .select({ n: count() })
      .from(recoverySteps)
      .innerJoin(failedPayments, onPayment)
      .innerJoin(accounts, onAccount)
      .where(due),
    db
      .select({ at: min(recoverySteps.nextRetryAt) })
      .from(recoverySteps)
      .innerJoin(failedPayments, onPayment)
      .innerJoin(accounts, onAccount)
      .where(and(due, isNotNull(recoverySteps.nextRetryAt))),
    db
      .select({ at: min(recoverySteps.scheduledAt) })
      .from(recoverySteps)
      .innerJoin(failedPayments, onPayment)
      .innerJoin(accounts, onAccount)
      .where(and(due, isNull(recoverySteps.nextRetryAt))),
  ]);

  const times = [retried[0]?.at, scheduled[0]?.at]
    .filter((t): t is Date => t instanceof Date)
    .map((t) => t.getTime());
  return {
    activePayments,
    dueSteps: counted[0]?.n ?? 0,
    oldestDueAt: times.length > 0 ? new Date(Math.min(...times)) : null,
  };
}

export interface CronLockRow {
  name: string;
  /** idle, running and not-released are cronLockHealth's; unreadable means the
   *  lock's Durable Object did not answer, which the page says rather than fail. */
  state: "idle" | "running" | "not-released" | "unreadable";
  heldUntil: Date | null;
}

/** Every registered cron's lock, in the registry's order (Recova's cron-lock
 *  table, read from Foxhound's CronLock Durable Objects). Each read is the
 *  object's `peek`, which writes nothing and never hands out the holder's token.
 *  The reads are independent: one that fails, or does not answer within
 *  CRON_LOCK_PEEK_TIMEOUT_MS, marks that row unreadable and the rest still show. */
export async function readCronLocks(env: Env, now: number = Date.now()): Promise<CronLockRow[]> {
  const ns = env.CRON_LOCK;
  const reads = await Promise.allSettled(
    CRON_JOBS.map((job) =>
      withTimeout(ns.get(ns.idFromName(job.name)).peek() as Promise<CronLockView>, CRON_LOCK_PEEK_TIMEOUT_MS),
    ),
  );
  return CRON_JOBS.map((job, i) => {
    const read = reads[i];
    if (read.status === "rejected") return { name: job.name, state: "unreadable", heldUntil: null };
    const health = cronLockHealth(read.value, now);
    return {
      name: job.name,
      state: health.state,
      heldUntil: health.heldUntil === null ? null : new Date(health.heldUntil),
    };
  });
}

/** The read, or a rejection once `ms` has passed without an answer. The timer
 *  is cleared as soon as the read settles either way, so none outlives it. */
function withTimeout<T>(read: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}
