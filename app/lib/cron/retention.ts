import type { BatchItem } from "drizzle-orm/batch";
import { inArray, lt, sql } from "drizzle-orm";
import { inList } from "@dustinedwards/site-runtime/d1";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

import type { Db } from "~/db";
import {
  adminApiCalls,
  aiCalls,
  aiCallsMonthly,
  emailSends,
  engagementEvents,
  getDb,
  healthScoreHistory,
  webhookEvents,
} from "~/db";
import {
  DAY_MS,
  RETENTION_ADMIN_API_CALLS_DAYS,
  RETENTION_AI_CALLS_DAYS,
  RETENTION_EMAIL_SENDS_DAYS,
  RETENTION_ENGAGEMENT_DAYS,
  RETENTION_HEALTH_SCORE_DAYS,
  RETENTION_SWEEP_LIMIT,
  RETENTION_WEBHOOK_EVENTS_DAYS,
} from "~/lib/constants";
import { computeAiCallCostCents } from "~/lib/ai/cost";
import { monthKey } from "@dustinedwards/site-runtime/time";

import type { CronJobResult } from "./run";

// Retention sweepers (ARCHITECTURE.md retention table + non-negotiable #4: these run before the tables they govern take production writes). Each is a step of the nightly retention job (registry.ts).

export function cutoffFor(days: number, nowMs: number): Date {
  return new Date(nowMs - days * DAY_MS);
}

/**
 * Delete up to RETENTION_SWEEP_LIMIT rows older than the cutoff, returning the
 * count.
 *
 * Batching the id list would also have worked and is deliberately NOT what this
 * does: a predicate that needs no id list cannot regress if someone later
 * raises RETENTION_SWEEP_LIMIT or edits a chunk size, whereas a batched delete
 * stays one careless constant away from the same failure.
 */
async function deleteOlderThan(
  db: Db,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  tsColumn: SQLiteColumn,
  cutoff: Date,
): Promise<number> {
  const predicate = lt(tsColumn, cutoff);
  const rows = await db
    .select({ id: idColumn })
    .from(table)
    .where(predicate)
    .limit(RETENTION_SWEEP_LIMIT);
  if (rows.length === 0) return 0;
  await db
    .delete(table)
    .where(
      inArray(
        idColumn,
        db.select({ id: idColumn }).from(table).where(predicate).limit(RETENTION_SWEEP_LIMIT),
      ),
    );
  return rows.length;
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
  const rows = await deleteOlderThan(
    getDb(env),
    emailSends,
    emailSends.id,
    emailSends.createdAt,
    cutoff,
  );
  return { rowsProcessed: rows };
}

export async function sweepAdminApiCalls(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_ADMIN_API_CALLS_DAYS, Date.now());
  const rows = await deleteOlderThan(
    getDb(env),
    adminApiCalls,
    adminApiCalls.id,
    adminApiCalls.createdAt,
    cutoff,
  );
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

/**
 * Group aged ai_calls rows by (account, model, UTC month), summing tokens.
 * Pure. A null account collapses to "" so platform-level calls dedupe into one
 * bucket.
 */
export function aggregateAiCalls(rows: AiCallRow[]): AiCallAggregate[] {
  const map = new Map<string, AiCallAggregate>();
  for (const r of rows) {
    const accountKey = r.accountId ?? "";
    const month = monthKey(r.createdAt);
    const key = `${accountKey}|${r.model}|${month}`;
    const agg = map.get(key) ?? {
      accountKey,
      model: r.model,
      month,
      promptTokens: 0,
      completionTokens: 0,
    };
    agg.promptTokens += r.promptTokens;
    agg.completionTokens += r.completionTokens;
    map.set(key, agg);
  }
  return [...map.values()];
}

/**
 * Aggregate aged ai_calls into ai_calls_monthly then delete them, atomically.
 * Cost is linear in tokens, so additive upserts of per-run cost sum correctly.
 */
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

  // THE ONE SITE WHERE AN ID LIST IS SEMANTICALLY REQUIRED, so this one keeps
  // its ids rather than converting to a predicate.
  //
  // This one may not: it must delete EXACTLY the rows it just aggregated into
  // ai_calls_monthly. A subquery re-evaluating `created_at < cutoff` inside the
  // batch would also match rows written after the SELECT, and deleting those
  // would drop AI calls that were never rolled into a monthly bucket.
  const deletes = [
    db.delete(aiCalls).where(
      inList(
        aiCalls.id,
        rows.map((r) => r.id),
      ),
    ),
  ];
  await db.batch([upserts[0], ...upserts.slice(1), ...deletes] as [
    BatchItem<"sqlite">,
    ...BatchItem<"sqlite">[],
  ]);
  return {
    rowsProcessed: rows.length,
    message: `${rows.length} calls into ${groups.length} monthly buckets`,
  };
}
