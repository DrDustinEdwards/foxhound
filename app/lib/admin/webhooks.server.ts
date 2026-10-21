// /admin/platform/webhooks data layer: delivery/health view off webhook_events. READ
// only (Pass 1); there is no retry/replay action here.

import { and, count, desc, eq, isNotNull, like, sql, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { webhookEvents } from "~/db";
import { WEBHOOK_PAGE_SIZE, type WebhookFilters } from "~/lib/admin/webhooks";
import { DAY_MS } from "~/lib/constants";

export interface WebhookHealthSummary {
  totalLast24h: number;
  errorsLast24h: number;
  unprocessedCount: number;
}

export async function getWebhookHealthSummary(db: Db): Promise<WebhookHealthSummary> {
  const since = new Date(Date.now() - DAY_MS);
  const [totalRows, errorRows, unprocessedRows] = await Promise.all([
    db.select({ n: count() }).from(webhookEvents).where(sql`${webhookEvents.receivedAt} >= ${since.getTime()}`),
    db
      .select({ n: count() })
      .from(webhookEvents)
      .where(and(sql`${webhookEvents.receivedAt} >= ${since.getTime()}`, isNotNull(webhookEvents.errorMessage))),
    db.select({ n: count() }).from(webhookEvents).where(sql`${webhookEvents.processed} = 0`),
  ]);
  return {
    totalLast24h: totalRows[0]?.n ?? 0,
    errorsLast24h: errorRows[0]?.n ?? 0,
    unprocessedCount: unprocessedRows[0]?.n ?? 0,
  };
}

export type WebhookEventRow = typeof webhookEvents.$inferSelect;

export interface WebhookEventPage {
  events: WebhookEventRow[];
  /** Every event the filters match, not just this page's. */
  total: number;
  /** The page served: the one asked for, kept inside 1..pageCount. */
  page: number;
  /** At least 1, so an empty list is "page 1 of 1". */
  pageCount: number;
}

/**
 * One page of the webhook log, newest first, filtered the way Recova's log
 * filtered in the browser (event type as a case-insensitive substring, errors
 * only) plus Foxhound's pending only. Over the whole table, not Recova's newest
 * 200: retention (90 days) bounds it, and the count says how many there are.
 */
export async function listWebhookEvents(db: Db, filters: WebhookFilters, perPage = WEBHOOK_PAGE_SIZE): Promise<WebhookEventPage> {
  const conditions: SQL[] = [];
  if (filters.type) {
    // Drizzle's like, never a hand-written clause (CLAUDE.md, "Drizzle only").
    // SQLite's LIKE ignores ASCII case, which covers Stripe's event types. A
    // "%" or "_" typed into the field acts as LIKE's wildcard and only widens
    // the match, which is harmless on a read-only admin list.
    conditions.push(like(webhookEvents.eventType, `%${filters.type}%`));
  }
  if (filters.errorsOnly) conditions.push(isNotNull(webhookEvents.errorMessage));
  if (filters.pendingOnly) conditions.push(eq(webhookEvents.processed, false));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const total = (await db.select({ n: count() }).from(webhookEvents).where(where))[0]?.n ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(1, filters.page), pageCount);
  const events =
    total === 0
      ? []
      : await db
          .select()
          .from(webhookEvents)
          .where(where)
          .orderBy(desc(webhookEvents.receivedAt), desc(webhookEvents.id))
          .limit(perPage)
          .offset((page - 1) * perPage);
  return { events, total, page, pageCount };
}
