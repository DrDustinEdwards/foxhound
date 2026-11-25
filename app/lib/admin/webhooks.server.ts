// /admin/platform/webhooks data layer: delivery/health view off webhook_events.
// READ only (Pass 1); there is no retry/replay action here.

import { and, desc, eq, isNotNull, like, sql, type SQL } from "drizzle-orm";

import type { Db } from "~/db";
import { countRows } from "~/db/scope";
import { webhookEvents } from "~/db";
import { WEBHOOK_PAGE_SIZE, type WebhookFilters } from "~/lib/admin/webhooks";
import { DAY_MS } from "~/lib/constants";

export interface WebhookHealthSummary {
  totalLast24h: number;
  errorsLast24h: number;
  unprocessedCount: number;
}

export async function getWebhookHealthSummary(db: Db): Promise<WebhookHealthSummary> {
  const recent = sql`${webhookEvents.receivedAt} >= ${Date.now() - DAY_MS}`;
  const [totalLast24h, errorsLast24h, unprocessedCount] = await Promise.all([
    countRows(db, webhookEvents, recent),
    countRows(db, webhookEvents, and(recent, isNotNull(webhookEvents.errorMessage))),
    countRows(db, webhookEvents, sql`${webhookEvents.processed} = 0`),
  ]);
  return { totalLast24h, errorsLast24h, unprocessedCount };
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

export async function listWebhookEvents(
  db: Db,
  filters: WebhookFilters,
  perPage = WEBHOOK_PAGE_SIZE,
): Promise<WebhookEventPage> {
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

  const total = await countRows(db, webhookEvents, where);
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
