import type { BatchItem } from "drizzle-orm/batch";
import { and, inArray, isNull, lt, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db } from "~/db";
import {
  aiCalls,
  aiCallsMonthly,
  cronRunHistory,
  emailSends,
  engagementEvents,
  getDb,
  healthScoreHistory,
  page404Daily,
  socialLeads,
  webhookEvents,
} from "~/db";
import {
  DAY_MS,
  RETENTION_AI_CALLS_DAYS,
  RETENTION_CRON_HISTORY_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_HEALTH_SCORE_DAYS,
  RETENTION_PAGE_404_DAILY_DAYS,
  RETENTION_SOCIAL_LEADS_DAYS,
  RETENTION_SWEEP_LIMIT,
  RETENTION_WEBHOOK_EVENTS_DAYS,
} from "~/lib/constants";
import { computeAiCallCostCents } from "~/lib/ai/cost";

import type { CronJobResult } from "./run";

// Retention sweepers (ARCHITECTURE.md retention table + non-negotiable #4: these
// run before the tables they govern take production writes). Each is registered
// as its own gated cron job (4e-C4). Most are age-based deletes; ai_calls
// aggregates aged rows into ai_calls_monthly then deletes them in one atomic
// batch (raw 90 days, monthly cost aggregates after). Every sweep is bounded to
// RETENTION_SWEEP_LIMIT rows per tick so a large backlog drains over ticks
// instead of timing out a single run.

/** The oldest-allowed timestamp for a window; rows strictly older are swept. Pure. */
export function cutoffFor(days: number, nowMs: number): Date {
  return new Date(nowMs - days * DAY_MS);
}

/** UTC YYYY-MM bucket for a timestamp. Pure. */
export function monthKeyUTC(when: Date): string {
  return `${when.getUTCFullYear()}-${String(when.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Delete up to RETENTION_SWEEP_LIMIT rows older than the cutoff, returning the
 *  count. Selects ids first so the count is exact and the delete is bounded. */
async function deleteOlderThan(
  db: Db,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  tsColumn: SQLiteColumn,
  cutoff: Date,
): Promise<number> {
  const rows = await db
    .select({ id: idColumn })
    .from(table)
    .where(lt(tsColumn, cutoff))
    .limit(RETENTION_SWEEP_LIMIT);
  if (rows.length === 0) return 0;
  const ids = rows.map((r) => r.id as string);
  await db.delete(table).where(inArray(idColumn, ids));
  return ids.length;
}

export async function sweepEngagementEvents(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_ENGAGEMENT_DAYS, Date.now());
  const rows = await deleteOlderThan(
    getDb(env),
    engagementEvents,
    engagementEvents.id,
    engagementEvents.occurredAt,
    cutoff,
  );
  return { rowsProcessed: rows };
}

export async function sweepEmailSends(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_EMAIL_SENDS_DAYS, Date.now());
  const rows = await deleteOlderThan(getDb(env), emailSends, emailSends.id, emailSends.createdAt, cutoff);
  return { rowsProcessed: rows };
}

export async function sweepWebhookEvents(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_WEBHOOK_EVENTS_DAYS, Date.now());
  const rows = await deleteOlderThan(
    getDb(env),
    webhookEvents,
    webhookEvents.id,
    webhookEvents.receivedAt,
    cutoff,
  );
  return { rowsProcessed: rows };
}

export async function sweepHealthScoreHistory(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_HEALTH_SCORE_DAYS, Date.now());
  const rows = await deleteOlderThan(
    getDb(env),
    healthScoreHistory,
    healthScoreHistory.id,
    healthScoreHistory.recordedAt,
    cutoff,
  );
  return { rowsProcessed: rows };
}

export async function sweepCronRunHistory(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_CRON_HISTORY_DAYS, Date.now());
  const rows = await deleteOlderThan(
    getDb(env),
    cronRunHistory,
    cronRunHistory.id,
    cronRunHistory.createdAt,
    cutoff,
  );
  return { rowsProcessed: rows };
}

export async function sweepPage404Daily(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_PAGE_404_DAILY_DAYS, Date.now());
  const rows = await deleteOlderThan(getDb(env), page404Daily, page404Daily.id, page404Daily.day, cutoff);
  return { rowsProcessed: rows };
}

/** Non-actioned social leads only (a lead we replied to is kept). */
export async function sweepSocialLeads(env: Env): Promise<CronJobResult> {
  const db = getDb(env);
  const cutoff = cutoffFor(RETENTION_SOCIAL_LEADS_DAYS, Date.now());
  const rows = await db
    .select({ id: socialLeads.id })
    .from(socialLeads)
    .where(and(lt(socialLeads.scoutRunAt, cutoff), isNull(socialLeads.repliedAt)))
    .limit(RETENTION_SWEEP_LIMIT);
  if (rows.length === 0) return { rowsProcessed: 0 };
  const ids = rows.map((r) => r.id);
  await db.delete(socialLeads).where(inArray(socialLeads.id, ids));
  return { rowsProcessed: ids.length };
}

export interface AiCallRow {
  id: string;
  accountId: string | null;
  model: string;
  promptTokens: number;
  completionTokens: number;
  createdAt: Date;
}
export interface AiCallAggregate {
  accountKey: string;
  model: string;
  month: string;
  promptTokens: number;
  completionTokens: number;
}

/** Group aged ai_calls rows by (account, model, UTC month), summing tokens. Pure.
 *  A null account collapses to "" so platform-level calls dedupe into one bucket. */
export function aggregateAiCalls(rows: AiCallRow[]): AiCallAggregate[] {
  const map = new Map<string, AiCallAggregate>();
  for (const r of rows) {
    const accountKey = r.accountId ?? "";
    const month = monthKeyUTC(r.createdAt);
    const key = `${accountKey}|${r.model}|${month}`;
    const agg =
      map.get(key) ?? { accountKey, model: r.model, month, promptTokens: 0, completionTokens: 0 };
    agg.promptTokens += r.promptTokens;
    agg.completionTokens += r.completionTokens;
    map.set(key, agg);
  }
  return [...map.values()];
}

/** Aggregate aged ai_calls into ai_calls_monthly then delete them, atomically.
 *  Cost is linear in tokens, so additive upserts of per-run cost sum correctly. */
export async function sweepAiCalls(env: Env): Promise<CronJobResult> {
  const db = getDb(env);
  const cutoff = cutoffFor(RETENTION_AI_CALLS_DAYS, Date.now());
  const rows = (await db
    .select({
      id: aiCalls.id,
      accountId: aiCalls.accountId,
      model: aiCalls.model,
      promptTokens: aiCalls.promptTokens,
      completionTokens: aiCalls.completionTokens,
      createdAt: aiCalls.createdAt,
    })
    .from(aiCalls)
    .where(lt(aiCalls.createdAt, cutoff))
    .limit(RETENTION_SWEEP_LIMIT)) as AiCallRow[];
  if (rows.length === 0) return { rowsProcessed: 0 };

  const now = new Date();
  const groups = aggregateAiCalls(rows);
  const upserts: BatchItem<"sqlite">[] = groups.map((g) =>
    db
      .insert(aiCallsMonthly)
      .values({
        accountId: g.accountKey,
        model: g.model,
        month: g.month,
        promptTokens: g.promptTokens,
        completionTokens: g.completionTokens,
        costCents: computeAiCallCostCents(g.model, g.promptTokens, g.completionTokens),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [aiCallsMonthly.accountId, aiCallsMonthly.model, aiCallsMonthly.month],
        set: {
          promptTokens: sql`${aiCallsMonthly.promptTokens} + excluded.prompt_tokens`,
          completionTokens: sql`${aiCallsMonthly.completionTokens} + excluded.completion_tokens`,
          costCents: sql`${aiCallsMonthly.costCents} + excluded.cost_cents`,
          updatedAt: now,
        },
      }),
  );

  const del = db.delete(aiCalls).where(inArray(aiCalls.id, rows.map((r) => r.id)));
  // One atomic batch: the aged rows are deleted in the same transaction that
  // rolls them into the monthly buckets, so a crash never double-counts.
  await db.batch([upserts[0], ...upserts.slice(1), del]);
  return { rowsProcessed: rows.length, message: `${groups.length} monthly buckets` };
}
