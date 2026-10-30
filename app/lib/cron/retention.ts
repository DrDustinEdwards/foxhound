import type { BatchItem } from "drizzle-orm/batch";
import { and, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
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
  DELETE_ID_BATCH_SIZE,
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
import { monthKeyUTC } from "~/lib/date-format";

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

/** Split an id list into chunks that fit under D1's bound-parameter ceiling.
 *  Pure, and exported so the boundary is directly testable at a row count ABOVE
 *  the ceiling, which is the only assertion that would have caught the original
 *  bug. */
export function chunkIds<T>(ids: readonly T[], size: number = DELETE_ID_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size) as T[]);
  return out;
}

/** Delete up to RETENTION_SWEEP_LIMIT rows matching a predicate, returning the
 *  count.
 *
 *  THE DELETE CARRIES NO ID LIST. It re-expresses the same bounded selection as
 *  a SUBQUERY, so its bound-parameter count is CONSTANT (the predicate's own
 *  operands plus the limit) no matter how many rows match. That is the whole
 *  difference between a fix and a larger version of the bug: an id list costs
 *  O(rows) parameters and breaks the day a table crosses D1_MAX_BOUND_PARAMS.
 *  retention-health-score failed every day for 29 days that way, building 417
 *  placeholders against a documented ceiling of 100.
 *
 *  Batching the id list would also have worked and is deliberately NOT what this
 *  does: a predicate that needs no id list cannot regress if someone later
 *  raises RETENTION_SWEEP_LIMIT or edits a chunk size, whereas a batched delete
 *  stays one careless constant away from the same failure.
 *
 *  THE LEADING SELECT SURVIVES, AND ONLY TO COUNT. `rowsAffected` is not uniform
 *  across the two drivers this code runs on (D1 returns D1Result.meta, the
 *  better-sqlite3 driver the tests use returns RunResult.changes), so counting
 *  here keeps production and the harness reading the same number rather than
 *  agreeing by luck.
 *
 *  The two statements evaluate the same predicate at slightly different moments,
 *  so a row that ages in between could be swept in place of one that was counted.
 *  Immaterial for an age-based sweep: every matching row is equally deletable,
 *  the tick stays bounded either way, and the remainder is swept next tick. Crons
 *  are serialized per name by the CronLock DO, so no second sweep of the same
 *  table runs alongside this one. */
async function deleteBoundedWhere(
  db: Db,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  predicate: SQL,
): Promise<number> {
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

/** Age-based sweep: the common case, where the predicate is one timestamp. */
async function deleteOlderThan(
  db: Db,
  table: SQLiteTable,
  idColumn: SQLiteColumn,
  tsColumn: SQLiteColumn,
  cutoff: Date,
): Promise<number> {
  return deleteBoundedWhere(db, table, idColumn, lt(tsColumn, cutoff));
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

/** Non-actioned social leads only (a lead we replied to is kept).
 *
 *  Two predicate terms rather than one, but still a PREDICATE: it goes through
 *  the same subquery delete as the age-only sweeps and carries no id list. This
 *  site had its own copy of the select-then-inArray shape, so it carried the
 *  same latent bug as the shared helper and would have fired the day
 *  social_leads crossed the ceiling. */
export async function sweepSocialLeads(env: Env): Promise<CronJobResult> {
  const cutoff = cutoffFor(RETENTION_SOCIAL_LEADS_DAYS, Date.now());
  const rows = await deleteBoundedWhere(
    getDb(env),
    socialLeads,
    socialLeads.id,
    and(lt(socialLeads.scoutRunAt, cutoff), isNull(socialLeads.repliedAt)) as SQL,
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

  // THE ONE SITE WHERE AN ID LIST IS SEMANTICALLY REQUIRED, so this one is
  // BATCHED rather than converted to a predicate.
  //
  // The other sweeps may re-express their delete as "whatever currently matches
  // the predicate", because every matching row is equally deletable. This one
  // may not: it must delete EXACTLY the rows it just aggregated into
  // ai_calls_monthly. A subquery re-evaluating `created_at < cutoff` inside the
  // batch would also match rows written after the SELECT, and deleting those
  // would drop AI calls that were never rolled into a monthly bucket. That is
  // silent loss in a cost ledger, which is worse than the bug being fixed.
  //
  // So the ids stay, and are chunked under D1's ceiling. The chunks go into the
  // SAME batch as the upserts, so the aggregate-then-delete stays one atomic
  // transaction and a crash still never double-counts.
  const deletes = chunkIds(rows.map((r) => r.id)).map((chunk) =>
    db.delete(aiCalls).where(inArray(aiCalls.id, chunk)),
  );
  await db.batch([upserts[0], ...upserts.slice(1), ...deletes] as [
    BatchItem<"sqlite">,
    ...BatchItem<"sqlite">[],
  ]);
  return { rowsProcessed: rows.length, message: `${groups.length} monthly buckets` };
}
