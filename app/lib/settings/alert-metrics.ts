import { ALERT_METRICS, ALERT_DIRECTIONS } from "~/lib/constants";
import type { AlertDirection, AlertMetric } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";

// S28's metric vocabulary, in a CLIENT-SAFE module because the create form
// renders it. Nothing here touches the database.
//
// The list is Recova's eleven (AlertsClient.tsx, blob ee8dac99), labels word
// for word. `ALERT_METRICS` is the evaluator's own enum (app/lib/constants.ts)
// and computeAlertMetrics computes every one, so each choice here can fire.

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  recovery_rate_pct: "Recovery rate",
  mrr_at_risk_cents: "MRR at risk",
  active_sequences: "Active sequences",
  emails_sent_7d: "Emails sent (7d)",
  open_disputes_count: "Open disputes",
  disputes_due_48h: "Disputes due in 48h",
  dispute_amount_at_stake_cents: "Dispute amount at stake",
  high_risk_customers_count: "High-risk customers",
  intelligence_mrr_at_risk_cents: "MRR at risk (Intelligence)",
  audit_leaking_cents: "Audit: revenue leaking",
  audit_leaking_delta_cents: "Audit: leaking change vs prior month",
};

export const ALERT_DIRECTION_LABELS: Record<AlertDirection, string> = {
  below: "Drops below",
  above: "Rises above",
};

/** Recova's cents metrics, so the form takes dollars and the table prints
 *  currency. Recova's form converted only MRR at risk to cents and stored the
 *  other four as typed, a hundredth of what they compare against; here all
 *  five convert. */
const CENTS_METRICS: ReadonlySet<string> = new Set([
  "mrr_at_risk_cents",
  "dispute_amount_at_stake_cents",
  "intelligence_mrr_at_risk_cents",
  "audit_leaking_cents",
  "audit_leaking_delta_cents",
]);

/** Recova's one percentage metric, printed with "%" and given a "%" after
 *  the threshold box. */
const PERCENT_METRIC = "recovery_rate_pct";

export function isCentsMetric(metric: string): boolean {
  return CENTS_METRICS.has(metric);
}

export function isAlertMetric(value: string): value is AlertMetric {
  return (ALERT_METRICS as readonly string[]).includes(value);
}

export function isAlertDirection(value: string): value is AlertDirection {
  return (ALERT_DIRECTIONS as readonly string[]).includes(value);
}

export function alertMetricLabel(metric: string): string {
  return isAlertMetric(metric) ? ALERT_METRIC_LABELS[metric] : metric;
}

/** Threshold as the merchant reads it: currency for cents metrics, "25%" for
 *  the recovery rate, a bare number otherwise. Recova's formatThreshold. */
export function formatThresholdValue(metric: string, value: number): string {
  if (isCentsMetric(metric)) {
    return formatMoneyShort(value, "usd");
  }
  if (metric === PERCENT_METRIC) return `${value}%`;
  return String(value);
}

/** Recova's condition words, "above" and "below", as its tables print the
 *  direction (AlertsClient.tsx, blob ee8dac99). Mapped rather than echoed, so no
 *  stored value reaches the page. The form's choices keep "Drops below" and
 *  "Rises above" (ALERT_DIRECTION_LABELS), as Recova's buttons do. */
const CONDITION_WORD: Record<AlertDirection, string> = { above: "above", below: "below" };

/** "above $5,000", Recova's Recent triggers condition, beside a Metric column. */
export function alertShortCondition(direction: string, metric: string, value: number): string {
  return `${conditionWord(direction)} ${formatThresholdValue(metric, value)}`;
}

/** The word for a stored direction. The action only stores "above" or
 *  "below", so anything else is a corrupt row: it reads "crosses", which is
 *  true of both, rather than echoing the stored value or dropping the word. */
function conditionWord(direction: string): string {
  return isAlertDirection(direction) ? CONDITION_WORD[direction] : "crosses";
}

/** "MRR at risk above $5,000", Recova's alerts-table condition. */
export function alertConditionLabel(metric: string, direction: string, value: number): string {
  return `${alertMetricLabel(metric)} ${alertShortCondition(direction, metric, value)}`;
}

/** What sits before the threshold box: Recova's "$" for a money metric, nothing
 *  for the score. */
export function alertThresholdPrefix(metric: string): string | null {
  return isCentsMetric(metric) ? "$" : null;
}

/** What sits after it: Recova's "%" for the recovery rate. */
export function alertThresholdSuffix(metric: string): string | null {
  return metric === PERCENT_METRIC ? "%" : null;
}

/** The metric the create form opens on: the one asked for, if the evaluator
 *  computes it, else the first. Display only; the action validates. */
export function alertFormMetric(requested: string | null): AlertMetric {
  return requested != null && isAlertMetric(requested) ? requested : ALERT_METRICS[0];
}

export { ALERT_METRICS,  };
export type { AlertDirection, AlertMetric };
