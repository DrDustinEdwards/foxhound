import { data, useNavigation, useSearchParams } from "react-router";

import { Alert } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAlertsView } from "~/lib/intelligence/views.server";
import {
  ALERT_DIRECTION_LABELS,
  ALERT_DIRECTIONS,
  ALERT_METRICS,
  ALERT_METRIC_LABELS,
  alertConditionLabel,
  alertMetricLabel,
  formatThresholdValue,
  isAlertDirection,
  isAlertMetric,
  isCentsMetric,
} from "~/lib/settings/alert-metrics";
import { createAlert, deleteAlert, setAlertEnabled } from "~/lib/settings/alerts.server";

import type { Route } from "./+types/alerts";

// S28, /settings/alerts. Legacy: alerts/page.tsx (blob 3c1d6bb0, 1,794 bytes)
// and alerts/AlertsClient.tsx (blob ee8dac99, 20,909 bytes).
//
// THE READER CAME FIRST HERE, which is the inverse of 315's usual failure. The
// nightly evaluator (`evaluateAlerts`) has been reading `alerts` and writing
// `alert_history` since Intelligence shipped, against a table nothing could put
// a row in. ALERT_METRICS' own comment says it stands "until a settings UI for
// creating alerts exists": this is that UI.
//
// TWO TRUTHFULNESS CONSTRAINTS, both class (c), both recorded in
// parity/SETTINGS-SPEC-FROM-DOCS.md before this was built:
//
// 1. THE METRIC LIST IS FOXHOUND'S FOUR, NOT LEGACY'S ELEVEN. `evaluateAlerts`
//    silently skips an alert whose metric it does not compute, so offering
//    `recovery_rate_pct` or `open_disputes_count` would let a merchant build a
//    rule that can never fire. Foxhound computes one of legacy's eleven.
// 2. NO CHANNEL PICKER, AND NO NOTIFICATION PROMISE. Legacy's subtitle is "Get
//    notified when Recovery metrics cross a threshold." Nothing here delivers:
//    `buildAlertFiringRow` writes `notificationSent: false` and says so. The
//    page says breaches are recorded and shown below, which is what happens.
//
// Legacy's transport is REST at /api/settings/alerts with optimistic updates
// and silent reverts on failure. This is the route's own action, class (a),
// S30's divergence 1, and a failure is shown rather than reverted invisibly.

export function meta() {
  return [{ title: "Alerts - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const view = await getAlertsView(getDb(env), auth.membership.accountId);
  return view;
}

interface ActionResult {
  action: string;
  ok: boolean;
  error?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (intent === "create") {
    const metric = String(form.get("metric") ?? "");
    const direction = String(form.get("direction") ?? "");
    // The metric and direction are checked against the EVALUATOR'S enums, not
    // against whatever the select happened to render. A posted value the
    // evaluator cannot compute is refused here rather than stored and skipped
    // silently every night.
    if (!isAlertMetric(metric)) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Choose a metric Foxhound tracks." },
        { status: 400 },
      );
    }
    if (!isAlertDirection(direction)) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Choose whether the metric rises or drops." },
        { status: 400 },
      );
    }
    const raw = String(form.get("threshold") ?? "").trim();
    const parsed = Number(raw);
    if (!raw || !Number.isFinite(parsed) || parsed < 0) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Enter a threshold of zero or more." },
        { status: 400 },
      );
    }
    // Cents metrics take dollars in the form and store cents, matching the
    // column the evaluator compares against.
    const thresholdValue = isCentsMetric(metric) ? Math.round(parsed * 100) : parsed;
    const labelRaw = String(form.get("label") ?? "").trim();
    await createAlert(
      db,
      accountId,
      { metric, direction, thresholdValue, label: labelRaw.length > 0 ? labelRaw : null },
      new Date(),
    );
    return data<ActionResult>({ action: intent, ok: true });
  }

  if (intent === "toggle" || intent === "delete") {
    const alertId = String(form.get("alertId") ?? "").trim();
    if (!alertId) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Select an alert." },
        { status: 400 },
      );
    }
    // Both writers pin account_id, so an alert on another account matches zero
    // rows and changes nothing.
    if (intent === "delete") {
      await deleteAlert(db, accountId, alertId);
    } else {
      await setAlertEnabled(db, accountId, alertId, String(form.get("enabled") ?? "") === "true");
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}

function formatDate(at: Date | null): string {
  if (!at) return "Never";
  return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(at: Date): string {
  return new Date(at).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const TH = "px-2 py-3 text-left font-mono text-micro uppercase tracking-wide text-text-tertiary";
const TD = "px-2 py-3 text-label";

export default function AlertSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { alerts, history } = loaderData;
  const result = actionData as ActionResult | undefined;
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const creating = params.get("new") === "1";
  const metric = params.get("metric") ?? ALERT_METRICS[0];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">Alerts</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Foxhound checks these every night and records every breach below.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {result && !result.ok && result.error ? <Alert tone="error">{result.error}</Alert> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-label text-text-secondary">
            {alerts.length} {alerts.length === 1 ? "alert" : "alerts"} configured
          </div>
          {creating ? null : (
            <a
              href="?new=1"
              className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber no-underline transition-opacity duration-500 hover:opacity-80"
            >
              Create alert
            </a>
          )}
        </div>

        {alerts.length === 0 && !creating ? (
          <p className="py-8 text-center text-label text-text-subtle">
            No alerts yet. Create one to get told when a metric needs attention.
          </p>
        ) : null}

        {alerts.length > 0 ? (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Label</th>
                  <th className={TH}>Condition</th>
                  <th className={TH}>Last triggered</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className={`${TD} text-text`}>{a.label ?? "-"}</td>
                    <td className={`${TD} text-text`}>
                      {alertConditionLabel(a.metric, a.direction, a.thresholdValue)}
                    </td>
                    <td className={`${TD} font-mono text-text-subtle`}>{formatDate(a.lastTriggeredAt)}</td>
                    <td className={TD}>
                      <DemoGuardedForm method="post">
                        <input type="hidden" name="_action" value="toggle" />
                        <input type="hidden" name="alertId" value={a.id} />
                        <input type="hidden" name="enabled" value={a.enabled ? "false" : "true"} />
                        <button
                          type="submit"
                          disabled={busy}
                          className={
                            a.enabled
                              ? "rounded-full border border-green px-2 py-0.5 text-micro font-medium uppercase tracking-wide text-green disabled:opacity-60"
                              : "rounded-full border border-border px-2 py-0.5 text-micro font-medium uppercase tracking-wide text-text-subtle disabled:opacity-60"
                          }
                        >
                          {a.enabled ? "On" : "Off"}
                        </button>
                      </DemoGuardedForm>
                    </td>
                    <td className={`${TD} text-right`}>
                      <DemoGuardedForm method="post">
                        <input type="hidden" name="_action" value="delete" />
                        <input type="hidden" name="alertId" value={a.id} />
                        <button
                          type="submit"
                          disabled={busy}
                          className="rounded-full border border-border px-3 py-0.5 font-mono text-micro text-text-subtle transition-colors duration-150 hover:border-text-tertiary disabled:opacity-60"
                        >
                          Delete alert
                        </button>
                      </DemoGuardedForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {creating ? (
          <DemoGuardedForm
            method="post"
            className="mt-6 flex flex-col gap-4 rounded-lg border border-border p-5"
          >
            <input type="hidden" name="_action" value="create" />
            <p className="text-label font-medium text-text">Create a new alert</p>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">Metric</span>
              {/* Only what the nightly evaluator computes. */}
              <select
                name="metric"
                defaultValue={metric}
                className="rounded-md border border-border bg-surface px-3 py-2 text-label text-text focus-visible:border-amber"
              >
                {ALERT_METRICS.map((m) => (
                  <option key={m} value={m}>
                    {ALERT_METRIC_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="flex flex-col gap-1.5 border-0 p-0">
              <legend className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Direction
              </legend>
              <div className="mt-1.5 flex gap-4">
                {ALERT_DIRECTIONS.map((d, i) => (
                  <label key={d} className="flex items-center gap-2 text-label text-text">
                    <input type="radio" name="direction" value={d} defaultChecked={i === 0} />
                    {ALERT_DIRECTION_LABELS[d]}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Threshold
              </span>
              <input
                name="threshold"
                type="number"
                min={0}
                step={1}
                required
                placeholder="5000"
                className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-label text-text placeholder:text-text-subtle focus-visible:border-amber"
              />
              <span className="text-micro text-text-subtle">
                Money metrics are in dollars. Average health score is a number from 0 to 100.
              </span>
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
                Label (optional)
              </span>
              <input
                name="label"
                type="text"
                placeholder="e.g. Churn running hot"
                className="rounded-md border border-border bg-surface px-3 py-2 text-label text-text placeholder:text-text-subtle focus-visible:border-amber"
              />
            </label>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={busy}
                className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber transition-opacity duration-500 hover:opacity-80 disabled:opacity-60"
              >
                {busy ? "Creating..." : "Create alert"}
              </button>
              <a href="?" className="text-label text-text-subtle no-underline hover:opacity-80">
                Cancel
              </a>
            </div>
          </DemoGuardedForm>
        ) : null}
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-label font-semibold text-text">Recent triggers</h2>
        {history.length === 0 ? (
          <p className="mt-2 text-label text-text-subtle">
            No alerts have fired yet. Triggers appear here when a threshold crosses.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className={TH}>Metric</th>
                  <th className={TH}>Condition</th>
                  <th className={TH}>Actual value</th>
                  <th className={TH}>Fired at</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-border">
                    <td className={`${TD} text-text`}>{alertMetricLabel(h.metric)}</td>
                    <td className={`${TD} text-text-subtle`}>
                      {alertConditionLabel(h.metric, h.direction, h.thresholdValue)}
                    </td>
                    <td className={`${TD} font-mono text-text`}>
                      {formatThresholdValue(h.metric, h.actualValue)}
                    </td>
                    <td className={`${TD} font-mono text-text-subtle`}>{formatDateTime(h.firedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
