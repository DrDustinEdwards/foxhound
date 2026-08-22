import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { alertHistory, alerts } from "~/db";

// S28's writers. The READER already existed and is not duplicated here:
// `getAlertsView` (app/lib/intelligence/views.server.ts) returns the configured
// alerts and the recent firings, and `evaluateAlerts` (intelligence/alerts.ts)
// is what actually reads `alerts` every night. This row is the surface that
// creates the rows those two have been reading an empty table for.
//
// Plain account-state writes, not money writes: an alert threshold gates no
// billing, claims no webhook and records no outcome.
//
// EVERY function here pins `account_id` in the WHERE. The id arrives from a
// client-POSTed form, so tenant isolation is DB-enforced rather than
// caller-dependent, exactly as buildBrandVoiceUpdate and findLiveConnection do.

export interface CreateAlertInput {
  metric: string;
  direction: string;
  thresholdValue: number;
  label: string | null;
}

/**
 * The channel every alert is created with.
 *
 * `alerts.channel` is NOT NULL and the schema keeps it, but S28 renders NO
 * channel picker, because nothing in this codebase delivers an alert:
 * `buildAlertFiringRow` writes `notificationSent: false` and its own comment
 * says the slice detects and records only. Offering Email or Slack would be a
 * delivery promise no code keeps. The column carries the value the sender will
 * default to when one is built.
 */
export const ALERT_DEFAULT_CHANNEL = "email";

export async function createAlert(
  db: Db,
  accountId: string,
  input: CreateAlertInput,
  now: Date,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await db.insert(alerts).values({
    id,
    accountId,
    metric: input.metric,
    direction: input.direction,
    thresholdValue: input.thresholdValue,
    channel: ALERT_DEFAULT_CHANNEL,
    label: input.label,
    enabled: true,
    createdAt: now,
  });
  return { id };
}

/** Enable or disable one alert. Legacy's On/Off pill. A disabled alert stays on
 *  the list and stops firing; `evaluateAlerts` filters on `enabled`. */
export async function setAlertEnabled(
  db: Db,
  accountId: string,
  alertId: string,
  enabled: boolean,
): Promise<void> {
  await db
    .update(alerts)
    .set({ enabled })
    .where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)));
}

/**
 * Delete one alert.
 *
 * `alert_history.alert_id` REFERENCES `alerts.id`, so the firing rows must go
 * first or the delete violates the foreign key. They are the merchant's own
 * record of what fired, and legacy drops them the same way by cascading, so the
 * history for a deleted alert goes with it rather than being orphaned.
 */
export async function deleteAlert(db: Db, accountId: string, alertId: string): Promise<void> {
  await db
    .delete(alertHistory)
    .where(and(eq(alertHistory.alertId, alertId), eq(alertHistory.accountId, accountId)));
  await db.delete(alerts).where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)));
}
