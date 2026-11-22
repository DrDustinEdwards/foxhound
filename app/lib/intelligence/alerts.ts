// Alert evaluation: pure evaluation plus the statements that record a firing. Sending is alert-notify.server.ts;
// evaluateAndRecordAlerts (alert-run.server.ts) sends and then records.

import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { alertHistory, alerts } from "~/db";
import { DAY_MS, HOUR_MS } from "~/lib/constants";

export interface AlertConfig {
  id: string;
  accountId: string;
  metric: string;
  thresholdValue: number;
  direction: string;
  channel: string;
  lastTriggeredAt: Date | null;
}

/** An alert that has fired does not fire again for 24 hours, however many evaluations see it past its threshold. */
const ALERT_COOLDOWN_MS = DAY_MS;

/** The nightly run's start drifts by however long the earlier jobs on the same "0 3 * * *" trigger take. Without
 *  a margin, a run starting a second earlier than last night's finds the alert still in cooldown and a steady
 *  breach is mailed every other night. */
const ALERT_COOLDOWN_MARGIN_MS = HOUR_MS;

export const ALERT_COOLDOWN_WINDOW_MS = ALERT_COOLDOWN_MS - ALERT_COOLDOWN_MARGIN_MS;

export function breachesThreshold(
  direction: string,
  actualValue: number,
  thresholdValue: number,
): boolean {
  return direction === "above" ? actualValue > thresholdValue : actualValue < thresholdValue;
}

/** Whether the alert's own last_triggered_at is inside the cooldown; a missing or unreadable stamp is none. An
 *  alert fires whenever its metric is past the threshold and outside the cooldown (not once per crossing), so a
 *  metric that stays past it is mailed again each day. */
function inAlertCooldown(lastTriggeredAt: Date | null, nowMs: number): boolean {
  if (!lastTriggeredAt) return false;
  const lastMs = lastTriggeredAt.getTime();
  if (!Number.isFinite(lastMs)) return false;
  return nowMs - lastMs < ALERT_COOLDOWN_WINDOW_MS;
}

export interface AlertFiring {
  alertId: string;
  accountId: string;
  metric: string;
  thresholdValue: number;
  direction: string;
  actualValue: number;
  channel: string;
}

/** Evaluate alert configs (the caller queries only enabled rows) against this run's metrics. An alert fires when
 *  its metric is past its threshold and outside its cooldown. A metric with no computed value this run is
 *  skipped (a configuration issue, not a breach). Pure. */
export function evaluateAlerts(
  configs: AlertConfig[],
  metrics: Record<string, number>,
  nowMs: number,
): AlertFiring[] {
  const firings: AlertFiring[] = [];
  for (const alert of configs) {
    const actualValue = metrics[alert.metric];
    if (actualValue === undefined) continue;
    if (!breachesThreshold(alert.direction, actualValue, alert.thresholdValue)) continue;
    if (inAlertCooldown(alert.lastTriggeredAt, nowMs)) continue;
    firings.push({
      alertId: alert.id,
      accountId: alert.accountId,
      metric: alert.metric,
      thresholdValue: alert.thresholdValue,
      direction: alert.direction,
      actualValue,
      channel: alert.channel,
    });
  }
  return firings;
}

/** The alert_history insert for one firing, written after the notification was attempted, with whether it went
 *  (required, so no caller can record a firing without saying). */
export function buildAlertHistoryInsert(
  db: Db,
  firing: AlertFiring,
  firedAt: Date,
  notificationSent: boolean,
) {
  return db.insert(alertHistory).values({
    alertId: firing.alertId,
    accountId: firing.accountId,
    metric: firing.metric,
    thresholdValue: firing.thresholdValue,
    direction: firing.direction,
    actualValue: firing.actualValue,
    channel: firing.channel,
    firedAt,
    notificationSent,
  });
}

/** Stamps the alert's lastTriggeredAt: the page's "last fired" and the start of its cooldown. */
export function buildAlertLastTriggeredUpdate(db: Db, alertId: string, firedAt: Date) {
  return db.update(alerts).set({ lastTriggeredAt: firedAt }).where(eq(alerts.id, alertId));
}

//
// Always-on cross-product check: an active recovery sequence, a health score of 33 or less and an open dispute, all
// at once. No alert row; the firing is recorded in alert_history under this metric with no alert_id, and that row
// is the 24 hour cooldown.

export const CRITICAL_CUSTOMERS_METRIC = "cross_product_critical";

/** The alert_history row for one critical customers firing: threshold 0, direction above, the count as the actual
 *  value, and channel "email" when neither channel was available. */
export function buildCriticalAlertHistoryInsert(
  db: Db,
  input: {
    accountId: string;
    count: number;
    channel: "email" | "slack" | "none";
    notificationSent: boolean;
    firedAt: Date;
  },
) {
  return db.insert(alertHistory).values({
    alertId: null,
    accountId: input.accountId,
    metric: CRITICAL_CUSTOMERS_METRIC,
    thresholdValue: 0,
    direction: "above",
    actualValue: input.count,
    channel: input.channel === "none" ? "email" : input.channel,
    firedAt: input.firedAt,
    notificationSent: input.notificationSent,
  });
}
