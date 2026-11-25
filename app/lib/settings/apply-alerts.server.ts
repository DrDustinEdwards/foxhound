import { and, eq } from "drizzle-orm";
import type { Db } from "~/db";
import { alerts } from "~/db";

import { isAlertDirection, isAlertMetric, isCentsMetric } from "./alert-metrics";
import {
  buildAlertDelete,
  buildAlertEnabledUpdate,
  buildAlertHistoryDelete,
  buildAlertInsert,
} from "./alerts.server";
import { asBoolean, asLabel } from "./setting-input";
import { type ApplyResult, type WriteTrace, commit } from "./apply.server";

// Alerts, in TWO functions, because the action is in two shapes THE FORM'S ACTION BRANCHES EXACTLY
// HERE and the split follows it rather than inventing one: `if (intent === "create")` validates
// four fields and takes no id, then `if (intent === "toggle" || intent === "delete")` shares the id
// reading and the refusal between two verbs that operate on a row that already exists.

export interface AlertCreateState {
  id: string;
  metric: string;
  direction: string;
  thresholdValue: number;
  label: string | null;
  channel: string;
}

const ALERT_CHANNELS = ["email", "slack"] as const;

/** The three refusals, the form's own sentences. */
const ALERT_METRIC_ERROR = "Choose a metric Foxhound tracks.";
const ALERT_DIRECTION_ERROR = "Choose whether the metric rises or drops.";
const ALERT_THRESHOLD_ERROR = "Enter a threshold of zero or more.";
const ALERT_NOT_FOUND_ERROR = "Select an alert.";

/** Create one alert. THE ENUMS ARE THE EVALUATOR'S, not the select's. */
export async function applyAlertCreate(
  db: Db,
  accountId: string,
  input: {
    metric: unknown;
    direction: unknown;
    threshold: unknown;
    label?: unknown;
    channel?: unknown;
  },
  now: Date,
  trace?: WriteTrace,
): Promise<ApplyResult<AlertCreateState>> {
  const metric = typeof input.metric === "string" ? input.metric : "";
  const direction = typeof input.direction === "string" ? input.direction : "";
  if (!isAlertMetric(metric)) return { ok: false, error: ALERT_METRIC_ERROR };
  if (!isAlertDirection(direction)) return { ok: false, error: ALERT_DIRECTION_ERROR };

  const raw =
    typeof input.threshold === "number"
      ? String(input.threshold)
      : String(input.threshold ?? "").trim();
  const parsed = Number(raw);
  if (!raw || !Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, error: ALERT_THRESHOLD_ERROR };
  }
  const thresholdValue = isCentsMetric(metric) ? Math.round(parsed * 100) : parsed;
  const label = asLabel(input.label, "the label");
  if (!label.ok) return label;
  const channel = (ALERT_CHANNELS as readonly unknown[]).includes(input.channel)
    ? String(input.channel)
    : "email";

  const state: AlertCreateState = {
    id: crypto.randomUUID(),
    metric,
    direction,
    thresholdValue,
    label: label.value,
    channel,
  };
  // A new row, so every column it names is a field this write touched.
  const fields = ["metric", "direction", "threshold_value", "label", "channel"];
  await commit(db, accountId, fields, buildAlertInsert(db, accountId, state, now, state.id), trace);
  return { ok: true, fields, state };
}

export interface AlertConfigState {
  id: string;
  enabled: boolean;
  deleted: boolean;
}

/** Enable, disable or delete one existing alert. It then returned `ok: true`. */
export async function applyAlertConfig(
  db: Db,
  accountId: string,
  input: { alertId: unknown; enabled?: unknown; deleted?: unknown },
  trace?: WriteTrace,
): Promise<ApplyResult<AlertConfigState>> {
  const alertId = typeof input.alertId === "string" ? input.alertId.trim() : "";
  if (!alertId) return { ok: false, error: ALERT_NOT_FOUND_ERROR };

  const owned = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.accountId, accountId)))
    .limit(1);
  if (owned.length === 0) return { ok: false, error: ALERT_NOT_FOUND_ERROR };

  if (asBoolean(input.deleted)) {
    const fields = ["deleted"];
    await commit(
      db,
      accountId,
      fields,
      [buildAlertHistoryDelete(db, accountId, alertId), buildAlertDelete(db, accountId, alertId)],
      trace,
    );
    return { ok: true, fields, state: { id: alertId, enabled: false, deleted: true } };
  }

  const enabled = asBoolean(input.enabled);
  const fields = ["enabled"];
  await commit(
    db,
    accountId,
    fields,
    buildAlertEnabledUpdate(db, accountId, alertId, enabled),
    trace,
  );
  return { ok: true, fields, state: { id: alertId, enabled, deleted: false } };
}
