import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { alertHistory, alerts } from "~/db";

// The alert writers. This row is the surface that creates the rows those two have been reading an empty
// table for. Plain account-state writes, not money writes: an alert threshold gates no billing,
// claims no webhook and records no outcome. The id arrives from a client-POSTed form, so tenant
// isolation is DB-enforced rather than caller-dependent, exactly as buildBrandVoiceUpdate and
// findLiveConnection do.

export interface CreateAlertInput {
  metric: string;
  direction: string;
  thresholdValue: number;
  label: string | null;
  channel: string;
}

/**
 * THE STATEMENT, NOT THE AWAIT. The id is passed in rather than minted here, because the caller has
 * to know it to report it back.
 */
export function buildAlertInsert(
  db: Db,
  accountId: string,
  input: CreateAlertInput,
  now: Date,
  id: string,
) {
  return db.insert(alerts).values({
    id,
    accountId,
    metric: input.metric,
    direction: input.direction,
    thresholdValue: input.thresholdValue,
    channel: input.channel,
    label: input.label,
    enabled: true,
    createdAt: now,
  });
}

/**
 * Enable or disable one alert. A disabled alert stays on the list and stops firing;
 * `evaluateAlerts` filters on `enabled`.
 */
export function buildAlertEnabledUpdate(
  db: Db,
  accountId: string,
  alertId: string,
  enabled: boolean,
) {
  return db
    .update(alerts)
    .set({ enabled })
    .where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)));
}

/**
 * Delete one alert. `alert_history.alert_id` REFERENCES `alerts.id`, so the firing rows must go
 * first or the delete violates the foreign key.
 */
export function buildAlertHistoryDelete(db: Db, accountId: string, alertId: string) {
  return db
    .delete(alertHistory)
    .where(and(eq(alertHistory.alertId, alertId), eq(alertHistory.accountId, accountId)));
}

/** The alert row itself. */
export function buildAlertDelete(db: Db, accountId: string, alertId: string) {
  return db.delete(alerts).where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)));
}
