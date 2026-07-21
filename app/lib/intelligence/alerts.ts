// Alert evaluation (PRICING.md Intelligence: alerts on real computed
// metrics). This slice DETECTS and RECORDS breaches (alert_history); it does
// not send notifications (the Phase 8 notification engine, out of scope per
// TASK-foxhound-intelligence-ai.md). Pure evaluation + a thin persistence
// wrapper, mirroring app/lib/ai/cost.ts's buildAiCallRow shape.

import { eq } from "drizzle-orm";

import type { Db } from "~/db";
import { alertHistory, alerts } from "~/db";

export interface AlertConfig {
  id: string;
  accountId: string;
  metric: string;
  thresholdValue: number;
  direction: string;
  channel: string;
}

/** True when `actualValue` breaches the alert's threshold in its configured direction. */
export function breachesThreshold(direction: string, actualValue: number, thresholdValue: number): boolean {
  return direction === "above" ? actualValue > thresholdValue : actualValue < thresholdValue;
}

/**
 * Edge-triggered fire decision: an alert fires only when it is breaching NOW
 * and was not ALREADY breaching as of its most recently recorded evaluation
 * (`previousActualValue`, the actual_value of its latest alert_history row,
 * or null if it has never fired). This is what "don't re-fire the same alert
 * every run" means structurally: a metric that stays over threshold for a
 * week fires once, the day it first crossed, not every night the nightly
 * cron re-evaluates it. It fires again once the metric clears the threshold
 * and later re-breaches.
 */
export function shouldFireAlert(
  alert: Pick<AlertConfig, "direction" | "thresholdValue">,
  previousActualValue: number | null,
  currentActualValue: number,
): boolean {
  const breachingNow = breachesThreshold(alert.direction, currentActualValue, alert.thresholdValue);
  if (!breachingNow) return false;
  const wasBreaching =
    previousActualValue !== null &&
    breachesThreshold(alert.direction, previousActualValue, alert.thresholdValue);
  return !wasBreaching;
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
 * filtering here) against this run's computed metrics. `previousActuals` maps
 * alertId -> the actual_value of its latest alert_history row (null if it has
 * never fired). An alert whose metric key has no computed value this run is
 * skipped (an unrecognized/unsupported metric is a configuration issue, not a
 * breach). Pure.
 */
export function evaluateAlerts(
  configs: AlertConfig[],
  metrics: Record<string, number>,
  previousActuals: Map<string, number | null>,
): AlertFiring[] {
  const firings: AlertFiring[] = [];
  for (const alert of configs) {
    const actualValue = metrics[alert.metric];
    if (actualValue === undefined) continue;
    const previous = previousActuals.get(alert.id) ?? null;
    if (!shouldFireAlert(alert, previous, actualValue)) continue;
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

/** The alert_history insert for one firing. notificationSent stays false: the
 *  Phase 8 notification engine is what would flip it (out of scope here). */
export function buildAlertHistoryInsert(db: Db, firing: AlertFiring, firedAt: Date) {
  return db.insert(alertHistory).values({
    alertId: firing.alertId,
    accountId: firing.accountId,
    metric: firing.metric,
    thresholdValue: firing.thresholdValue,
    direction: firing.direction,
    actualValue: firing.actualValue,
    channel: firing.channel,
    firedAt,
    notificationSent: false,
  });
}

/** Stamps the alert's lastTriggeredAt for UI display ("last fired"). The
 *  edge-trigger decision itself (shouldFireAlert) uses alert_history's actual
 *  values, not this column; this write is display-only bookkeeping. */
export function buildAlertLastTriggeredUpdate(db: Db, alertId: string, firedAt: Date) {
  return db.update(alerts).set({ lastTriggeredAt: firedAt }).where(eq(alerts.id, alertId));
}
