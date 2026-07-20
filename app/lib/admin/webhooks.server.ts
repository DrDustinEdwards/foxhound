// /admin/webhooks data layer: delivery/health view off webhook_events. READ
// only (Pass 1); there is no retry/replay action here.

import { and, count, desc, isNotNull, sql } from "drizzle-orm";

import type { Db } from "~/db";
import { webhookEvents } from "~/db";

export interface WebhookHealthSummary {
  totalLast24h: number;
  errorsLast24h: number;
  unprocessedCount: number;
}

export async function getWebhookHealthSummary(db: Db): Promise<WebhookHealthSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
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

export async function listRecentWebhookEvents(db: Db, limit = 100) {
  return db.select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(limit);
}
