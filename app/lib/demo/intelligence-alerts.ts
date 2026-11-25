import { DAY_MS } from "~/lib/constants";
import type { AlertHistoryInsert, AlertInsert } from "./intelligence-seed";

export function buildAlerts(
  accountId: string,
  p: string,
  now: Date,
): { alerts: AlertInsert[]; history: AlertHistoryInsert[] } {
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
  const alertRows: AlertInsert[] = [
    {
      id: `${p}alert_recovery_rate`,
      accountId,
      metric: "recovery_rate_pct",
      thresholdValue: 25,
      direction: "below",
      channel: "email",
      label: "Low recovery rate warning",
      enabled: true,
      lastTriggeredAt: null,
      createdAt: now,
    },
    {
      id: `${p}alert_mrr_at_risk`,
      accountId,
      metric: "mrr_at_risk_cents",
      thresholdValue: 200000,
      direction: "above",
      channel: "email",
      label: "High MRR at risk",
      enabled: true,
      lastTriggeredAt: threeDaysAgo,
      createdAt: now,
    },
    {
      id: `${p}alert_active_sequences`,
      accountId,
      metric: "active_sequences",
      thresholdValue: 10,
      direction: "above",
      channel: "email",
      label: "Active sequence count",
      enabled: false,
      lastTriggeredAt: null,
      createdAt: now,
    },
  ];
  const historyRows: AlertHistoryInsert[] = [
    {
      id: `${p}alerthist_mrr_at_risk`,
      alertId: `${p}alert_mrr_at_risk`,
      accountId,
      metric: "mrr_at_risk_cents",
      thresholdValue: 200000,
      direction: "above",
      actualValue: 247300,
      channel: "email",
      firedAt: threeDaysAgo,
      notificationSent: true,
    },
  ];
  return { alerts: alertRows, history: historyRows };
}
