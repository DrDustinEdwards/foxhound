import { ALERT_METRICS, ALERT_DIRECTIONS } from "~/lib/constants";
import type { AlertDirection, AlertMetric } from "~/lib/constants";
import { formatMoneyShort } from "~/lib/money-format";

// S28's metric vocabulary, in a CLIENT-SAFE module because the create form
// renders it. Nothing here touches the database.
//
// THE LIST IS FOXHOUND'S FOUR, NOT LEGACY'S ELEVEN, and that is the whole
// decision on this row. `ALERT_METRICS` is the nightly evaluator's own enum
// (app/lib/constants.ts) and `evaluateAlerts` SKIPS an alert whose metric key
// has no computed value that run. Legacy's picker offers eleven, of which
// Foxhound computes exactly one (`mrr_at_risk_cents`); offering the other ten
// would let a merchant configure an alert that can never fire and never say so.
// When the evaluator learns a metric, it goes in ALERT_METRICS and appears here
// by construction, which is why this derives from that constant rather than
// repeating it.

export const ALERT_METRIC_LABELS: Record<AlertMetric, string> = {
  health_score_avg: "Average health score",
  mrr_at_risk_cents: "MRR at risk",
  mrr_churn_cents: "Churned MRR",
  mrr_contraction_cents: "Contracted MRR",
};

export const ALERT_DIRECTION_LABELS: Record<AlertDirection, string> = {
  below: "Drops below",
  above: "Rises above",
};

/** The metrics denominated in cents, so the form takes dollars and the table
 *  prints currency. `health_score_avg` is a 0 to 100 score and is neither. */
const CENTS_METRICS: ReadonlySet<string> = new Set([
  "mrr_at_risk_cents",
  "mrr_churn_cents",
  "mrr_contraction_cents",
]);

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

/** Threshold as the merchant reads it: currency for cents metrics, a bare
 *  number for the score. Mirrors legacy's formatThreshold. */
export function formatThresholdValue(metric: string, value: number): string {
  if (isCentsMetric(metric)) {
    return formatMoneyShort(value, "usd");
  }
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

/** The metric the create form opens on: the one asked for, if the evaluator
 *  computes it, else the first. Display only; the action validates. */
export function alertFormMetric(requested: string | null): AlertMetric {
  return requested != null && isAlertMetric(requested) ? requested : ALERT_METRICS[0];
}

export { ALERT_METRICS, ALERT_DIRECTIONS };
export type { AlertDirection, AlertMetric };
