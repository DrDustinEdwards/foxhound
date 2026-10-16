import { useRef, useState } from "react";
import { data, Form, Link, redirect, useNavigation, useSearchParams } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field, InputGroup, InputGroupAddon } from "capsomer/react/field";
import { PageHead } from "capsomer/react/page-head";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";
import { Switch } from "capsomer/react/switch";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/empty.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/status.css";
import "capsomer/switch.css";
import "capsomer/table.css";
// Capsomer's tokens and the teal family, which the components above read, as
// /intelligence/customers and /disputes load them.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { getAlertsView } from "~/lib/intelligence/views.server";
import {
  ALERT_DIRECTION_LABELS,
  ALERT_METRICS,
  ALERT_METRIC_LABELS,
  alertConditionLabel,
  alertFormMetric,
  alertMetricLabel,
  alertShortCondition,
  alertThresholdPrefix,
  formatThresholdValue,
  type AlertDirection,
} from "~/lib/settings/alert-metrics";
import { applyAlertConfig, applyAlertCreate } from "~/lib/settings/apply.server";

import type { Route } from "./+types/alerts";

// S28, /settings/alerts. Legacy: alerts/page.tsx (blob 3c1d6bb0, 1,794 bytes)
// and alerts/AlertsClient.tsx (blob ee8dac99, 20,909 bytes).
//
// J33 (job_947a0b8bbe06) rebuilt the page on Capsomer 0.9.0's parts (Q10),
// teal throughout with no warm accent (Q11). Recova is the spec for what is on it and
// in what order: the phone-only Settings link, the head, a card with the count
// line, Create alert, the alerts table and the create form, then a Recent
// triggers card. The settings layout gives the page Recova's 800px column and
// padding, so the page adds no width of its own. No Foxhound class sits on a
// Capsomer element; what Recova's look still needs is listed for Capsomer's
// per-site layer (capsomer job_ec5ec0754626) in the J33 pull request.
//
// THE READER CAME FIRST HERE, which is the inverse of 315's usual failure. The
// nightly evaluator (`evaluateAlerts`) has been reading `alerts` and writing
// `alert_history` since Intelligence shipped, against a table nothing could put
// a row in. ALERT_METRICS' own comment says it stands "until a settings UI for
// creating alerts exists": this is that UI.
//
// TWO TRUTHFULNESS CONSTRAINTS, both RULES.md 1.2 and 2.7, kept by J33:
//
// 1. THE METRIC LIST IS FOXHOUND'S FOUR, NOT LEGACY'S ELEVEN. `evaluateAlerts`
//    silently skips an alert whose metric it does not compute, so offering
//    `recovery_rate_pct` or `open_disputes_count` would let a merchant build a
//    rule that can never fire.
// 2. NO CHANNEL PICKER, NO CHANNEL COLUMNS, AND NO NOTIFICATION PROMISE.
//    When J33 shipped nothing delivered an alert, so Recova's subtitle ("Get
//    notified when Recovery metrics cross a threshold.") and its "email goes
//    to" note were not ported, nor a Channel column. J94 (rows E21, E22) now
//    emails a firing to the notification address, on Recova's 24 hour
//    cooldown rather than once per crossing. Its review round 1 made the lead
//    true of that ("records each night one is past its threshold"); restoring
//    Recova's subtitle and email note is left to Dustin (PR 156).
//
// Legacy's transport is REST at /api/settings/alerts with optimistic updates
// and silent reverts on failure. This is the route's own action, class (a),
// S30's divergence 1, and a failure is shown rather than reverted invisibly.

export function meta() {
  return [{ title: "Alerts - Foxhound" }];
}

/** Recova's page reads the twenty most recent firings. The shared view reads
 *  more for /intelligence/alerts, so this page takes its own twenty. */
const RECENT_TRIGGERS = 20;

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const view = await getAlertsView(getDb(env), auth.membership.accountId);
  return { alerts: view.alerts, history: view.history.slice(0, RECENT_TRIGGERS) };
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

  // TWO BRANCHES, TWO APPLY FUNCTIONS, and the split below is the one this
  // action always had: creating takes four fields and no id, changing takes an
  // id and one verb. Every refusal string moved with the check that produces
  // it, so the sentences a merchant reads are unchanged and are now the same
  // sentences an agent reads.
  if (intent === "create") {
    const result = await applyAlertCreate(
      db,
      accountId,
      {
        metric: form.get("metric"),
        direction: form.get("direction"),
        threshold: form.get("threshold"),
        label: form.get("label"),
      },
      new Date(),
    );
    if (!result.ok) {
      return data<ActionResult>(
        { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
    }
    // Recova's dismissPanel: a created alert closes the form, clears its
    // fields and re-enables Create alert. Redirecting drops ?new=1, so the
    // form cannot be sent twice with the same values. A refusal above keeps
    // the form open with its message.
    return redirect("/settings/alerts");
  }

  if (intent === "toggle" || intent === "delete") {
    // An alert this account does not own now REFUSES rather than reporting a
    // zero-row write as success. The pill and the delete button only ever offer
    // the caller's own ids, so nothing about the page changes.
    const result = await applyAlertConfig(db, accountId, {
      alertId: form.get("alertId"),
      deleted: intent === "delete",
      enabled: String(form.get("enabled") ?? "") === "true",
    });
    if (!result.ok) {
      return data<ActionResult>(
        { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
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

export default function AlertSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { alerts, history } = loaderData;
  const result = actionData as ActionResult | undefined;
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const creating = params.get("new") === "1";
  const createError = result && !result.ok && result.action === "create" ? result.error : undefined;
  const rowError = result && !result.ok && result.action !== "create" ? result.error : undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Recova's PageHeader sits mb-8 above the first card. */}
      <div className="mb-8">
        <PageHead title="Alerts" lead="Foxhound checks these every night and records each night one is past its threshold." />
      </div>

      {/* Recova's first card has no heading: a count line and a button lead
          it. Capsomer's Panel needs a title, so this is Capsomer's panel
          markup with its body only, as /intelligence/customers does. */}
      <div className="mb-6">
        <div className="cap-panel">
          <div className="cap-panel-body">
            {rowError ? (
              <div className="mb-4 min-w-0">
                <Alert tone="crit">{rowError}</Alert>
              </div>
            ) : null}

            {/* min-w-0 on each of the page's own blocks in Capsomer's panel
                body, which is a grid: without it a wide table pushes the
                card past the 800px column instead of scrolling inside it. */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 text-label">
              <p className="m-0 text-text-secondary">
                {alerts.length} {alerts.length === 1 ? "alert" : "alerts"} configured
              </p>
              {creating ? (
                // Recova keeps the button on screen and disabled while the
                // form is open. Capsomer's Button says why it is disabled.
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" disabledReason="The form is open below.">
                    Create alert
                  </Button>
                </div>
              ) : (
                // A GET form, so the form opens with no script as well.
                <Form method="get">
                  <input type="hidden" name="new" value="1" />
                  <Button type="submit" variant="primary">
                    Create alert
                  </Button>
                </Form>
              )}
            </div>

            {alerts.length === 0 && !creating ? (
              <p className="m-0 min-w-0 py-8 text-center text-label text-text-subtle">
                No alerts yet. Create one to see when metrics need attention.
              </p>
            ) : null}

            {alerts.length > 0 ? (
              <div className="mt-5 min-w-0">
                <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Alerts" tabIndex={0}>
                  <table className="cap-table">
                    <thead>
                      <tr>
                        <th scope="col">Label</th>
                        <th scope="col">Metric</th>
                        <th scope="col">Condition</th>
                        <th scope="col">Last triggered</th>
                        <th scope="col">Status</th>
                        <th scope="col" data-num="">
                          Actions
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {alerts.map((a) => {
                        const condition = alertConditionLabel(a.metric, a.direction, a.thresholdValue);
                        return (
                          <tr key={a.id}>
                            <td>{a.label ?? "-"}</td>
                            <td>
                              <span className="text-text-subtle">{alertMetricLabel(a.metric)}</span>
                            </td>
                            <td>{condition}</td>
                            <td>
                              <span className="font-mono text-text-subtle">{formatDate(a.lastTriggeredAt)}</span>
                            </td>
                            <td>
                              <AlertSwitch id={a.id} enabled={a.enabled} name={a.label ?? condition} busy={busy} />
                            </td>
                            <td data-num="">
                              <DemoGuardedForm method="post">
                                <input type="hidden" name="_action" value="delete" />
                                <input type="hidden" name="alertId" value={a.id} />
                                <Button type="submit" size="sm" pending={busy}>
                                  Delete alert
                                </Button>
                              </DemoGuardedForm>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {creating ? <CreateAlertForm busy={busy} error={createError} initialMetric={params.get("metric")} /> : null}
          </div>
        </div>
      </div>

      <div className="mb-6">
        <Panel title="Recent triggers">
          {history.length === 0 ? (
            <p className="m-0 text-label text-text-subtle">
              No alerts have fired yet. Triggers will appear here when a threshold crosses.
            </p>
          ) : (
            <div className="cap-table-wrap" data-cap="table" role="region" aria-label="Recent triggers" tabIndex={0}>
              <table className="cap-table">
                <thead>
                  <tr>
                    <th scope="col">Metric</th>
                    <th scope="col">Condition</th>
                    <th scope="col">Actual value</th>
                    <th scope="col">Fired at</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{alertMetricLabel(h.metric)}</td>
                      <td>
                        <span className="text-text-subtle">
                          {alertShortCondition(h.direction, h.metric, h.thresholdValue)}
                        </span>
                      </td>
                      <td>
                        <span className="font-mono">{formatThresholdValue(h.metric, h.actualValue)}</span>
                      </td>
                      <td>
                        <span className="font-mono text-text-subtle">{formatDateTime(h.firedAt)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}

/**
 * Recova's On and Off status control, on Capsomer's Switch: a real switch with
 * its On or Off word beside it, named for its alert so a screen reader hears
 * which one it moves. Changing it posts the toggle at once, as Recova's pill
 * does. The switch follows the stored value, so a refused change (the demo, a
 * failed write) springs back rather than showing a state nothing saved.
 */
function AlertSwitch({ id, enabled, name, busy }: { id: string; enabled: boolean; name: string; busy: boolean }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <DemoGuardedForm method="post" ref={form}>
      <input type="hidden" name="_action" value="toggle" />
      <input type="hidden" name="alertId" value={id} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <Switch
        label={<span className="sr-only">{name} alert</span>}
        checked={enabled}
        busy={busy}
        onCheckedChange={() => form.current?.requestSubmit()}
      />
    </DemoGuardedForm>
  );
}

/** Recova's order and default: "Drops below" first and chosen. The evaluator's
 *  enum lists "above" first, so the page orders its own copy. */
const DIRECTION_ORDER: readonly AlertDirection[] = ["below", "above"];

/**
 * Recova's "Create a new alert" form, nested in the first card, with its fields
 * in Recova's order: Metric, Direction, Threshold, Label. The metric is held in
 * state so the threshold shows Recova's $ for a money metric and its
 * placeholder follows the metric, as Recova's does.
 */
function CreateAlertForm({
  busy,
  error,
  initialMetric,
}: {
  busy: boolean;
  error?: string;
  initialMetric: string | null;
}) {
  const [metric, setMetric] = useState<string>(alertFormMetric(initialMetric));
  const [direction, setDirection] = useState<AlertDirection>(DIRECTION_ORDER[0]);
  const prefix = alertThresholdPrefix(metric);

  return (
    <div className="mt-6 min-w-0">
      <Panel title="Create a new alert" level={3}>
        <DemoGuardedForm method="post" className="min-w-0">
          <input type="hidden" name="_action" value="create" />
          <div className="flex flex-col gap-4 text-label">
            <Field label="Metric">
              {/* Only what the nightly evaluator computes. */}
              <Select
                native
                name="metric"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                options={ALERT_METRICS.map((m) => ({ value: m, label: ALERT_METRIC_LABELS[m] }))}
              />
            </Field>

            <Segmented
              legend="Direction"
              name="direction"
              fill
              value={direction}
              onChange={setDirection}
              options={DIRECTION_ORDER.map((d) => ({ value: d, label: ALERT_DIRECTION_LABELS[d] }))}
            />

            {/* Field clones its one child, and here the child is a group, so
                the threshold is composed from Field's own parts around
                Capsomer's InputGroup. */}
            <div className="cap-field">
              <label className="cap-field-label" htmlFor="alert-threshold">
                Threshold
              </label>
              <InputGroup>
                {prefix ? <InputGroupAddon align="inline-start">{prefix}</InputGroupAddon> : null}
                <input
                  className="cap-input"
                  id="alert-threshold"
                  name="threshold"
                  type="number"
                  min={0}
                  step={1}
                  required
                  placeholder={prefix ? "5000" : "10"}
                />
              </InputGroup>
            </div>

            <Field
              label={
                <>
                  Label <span className="text-text-subtle">(optional)</span>
                </>
              }
            >
              <input className="cap-input" name="label" type="text" placeholder="e.g. Low health score warning" />
            </Field>
          </div>

          {error ? (
            <div className="mt-4">
              <Alert tone="crit">{error}</Alert>
            </div>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" pending={busy}>
              {busy ? "Creating..." : "Create alert"}
            </Button>
            {/* Recova's Cancel closes the form. A link back to the page, in
                Capsomer's quiet button markup, closes it with no script. */}
            <Link className="cap-btn" data-variant="quiet" to="/settings/alerts">
              Cancel
            </Link>
          </div>
        </DemoGuardedForm>
      </Panel>
    </div>
  );
}
