// Alert evaluation (PRICING.md Intelligence: alerts on real computed
// metrics). Pure evaluation plus the statements that record a firing. The
// sending is app/lib/intelligence/alert-notify.server.ts (E21, E22); the
// orchestration that sends and then records is evaluateAndRecordAlerts in
// ai-run.server.ts, in Recova's order (lib/alert-evaluation.ts, blob 0e28ecbf).

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
  /** When the alert last fired; the cooldown runs from here. */
  lastTriggeredAt: Date | null;
}

/** Recova's COOLDOWN_MS: an alert that has fired does not fire again for 24
 *  hours, however many evaluations see it still past its threshold. */
export const ALERT_COOLDOWN_MS = DAY_MS;

/**
 * The nightly run's start drifts by however long the daily jobs before it take
 * (cron-health, expiring-cards, d1-backup and demo-reset all run on the same
 * "0 3 * * *" trigger). Without a margin, a run that starts a second earlier
 * than last night's finds the alert still in cooldown, so a steady breach is
 * mailed every other night. Recova re-evaluated every few minutes, so its
 * effective period was 24 hours plus one tick; one evaluation a night gets the
 * same behavior from this margin (review round 1, PR 156).
 */
export const ALERT_COOLDOWN_MARGIN_MS = HOUR_MS;

/** How long after a firing the alert stays quiet: the cooldown less the margin. */
export const ALERT_COOLDOWN_WINDOW_MS = ALERT_COOLDOWN_MS - ALERT_COOLDOWN_MARGIN_MS;

/** True when `actualValue` breaches the alert's threshold in its configured direction. */
export function breachesThreshold(direction: string, actualValue: number, thresholdValue: number): boolean {
  return direction === "above" ? actualValue > thresholdValue : actualValue < thresholdValue;
}

/**
 * Recova's inCooldown, on the alert's own last_triggered_at. A missing or
 * unreadable stamp is no cooldown.
 *
 * THIS REPLACES THE EDGE TRIGGER. Foxhound fired an alert once per
 * crossing, judged from the previous firing's actual value; Recova fires
 * whenever the metric is past its threshold and the alert is outside its 24
 * hour cooldown, so a metric that stays past it is mailed again each day. The
 * email row (E21) is judged on when it sends, and the job says to keep
 * Recova's cooldown.
 */
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

/**
 * Evaluate a set of alert configs (the caller queries only enabled=true rows,
 * mirroring accountProcessingEligibleCondition's SQL-level gating rather than
 * filtering here) against this run's computed metrics. An alert fires when its
 * metric is past its threshold and it is outside its cooldown, Recova's rule.
 * An alert whose metric key has no computed value this run is skipped (an
 * unrecognized/unsupported metric is a configuration issue, not a breach).
 * Pure.
 */
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

/** The alert_history insert for one firing, written after the notification
 *  was attempted, with whether it went (Recova's notification_sent). Required,
 *  so no caller can record a firing without saying. */
export function buildAlertHistoryInsert(db: Db, firing: AlertFiring, firedAt: Date, notificationSent: boolean) {
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

/** Stamps the alert's lastTriggeredAt: the page's "last fired", and the start
 *  of its cooldown (inAlertCooldown). */
export function buildAlertLastTriggeredUpdate(db: Db, alertId: string, firedAt: Date) {
  return db.update(alerts).set({ lastTriggeredAt: firedAt }).where(eq(alerts.id, alertId));
}

// ---- the critical customers check (E22) -------------------------------------
//
// Recova's always-on cross-product check (lib/alert-evaluation.ts lines 337 to
// 440): a customer with an active recovery sequence, a health score of 33 or
// less and an open dispute, all at once. No alert row is needed; the firing is
// recorded in alert_history under this metric with no alert_id, and that row is
// the 24 hour cooldown.

export const CRITICAL_CUSTOMERS_METRIC = "cross_product_critical";

/** Recova's high-risk ceiling for this check: health_score <= 33. */
export const CRITICAL_HEALTH_SCORE_MAX = 33;

/** The alert_history row for one critical customers firing, as Recova writes
 *  it: threshold 0, direction above, the count as the actual value, and the
 *  channel "email" when neither channel was available. */
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
