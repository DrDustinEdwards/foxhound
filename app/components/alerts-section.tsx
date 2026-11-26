import { plural } from "@drdustinedwards/site-helpers/text";
import { formatDate } from "capsomer/behavior/time";
import { Table } from "capsomer/react/table";
import { useRef, useState } from "react";
import { Form, useNavigation, useSearchParams } from "react-router";
import { ButtonLink } from "capsomer/react/link";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { Field, InputGroup, InputGroupAddon, TextField } from "capsomer/react/field";
import { Panel } from "capsomer/react/panel";
import { Segmented } from "capsomer/react/segmented";
import { Select } from "capsomer/react/select";
import { Switch } from "capsomer/react/switch";
import "capsomer/banner.css";
import "capsomer/empty.css";
import "capsomer/segmented.css";
import "capsomer/select.css";
import "capsomer/table.css";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import {
  ALERT_DIRECTION_LABELS,
  ALERT_METRICS,
  ALERT_METRIC_LABELS,
  alertConditionLabel,
  alertFormMetric,
  alertMetricLabel,
  alertShortCondition,
  alertThresholdPrefix,
  alertThresholdSuffix,
  formatThresholdValue,
  type AlertDirection,
} from "~/lib/settings/alert-metrics";
import type { AlertActionResult, loadAlertsSection } from "~/lib/settings/alerts-section.server";

// The alerts part of /settings/notifications. The nightly evaluator (evaluateAlerts) reads alerts and writes alert_history; this is the UI that creates the rows. Email or Slack channel (Slack disabled until a webhook is saved). A failed action is shown, never silently reverted.

function dateOrNever(at: Date | null): string {
  return at ? (formatDate(new Date(at), { style: "medium" }) ?? "") : "Never";
}

function formatDateTime(at: Date): string {
  return formatDate(at, { style: "medium", time: true, zoneName: true }) ?? "";
}

export function AlertsSection({
  data: { alerts, history, notificationEmail, hasSlack },
  result,
}: {
  data: Awaited<ReturnType<typeof loadAlertsSection>>;
  result?: AlertActionResult;
}) {
  const busy = useNavigation().state !== "idle";
  const [params] = useSearchParams();
  const creating = params.get("new") === "1";
  const createError = result && !result.ok && result.action === "create" ? result.error : undefined;
  const rowError = result && !result.ok && result.action !== "create" ? result.error : undefined;

  return (
    <section aria-labelledby="alerts-heading" className="fh-alerts">
      <div className="fh-mb-6">
        <h2 id="alerts-heading" className="fh-semibold fh-text">
          Alerts
        </h2>
      </div>

      <div className="fh-mb-6">
        <div className="cap-panel">
          <div className="cap-panel-body">
            {rowError ? (
              <div className="fh-alerts-banner">
                <Alert tone="crit">{rowError}</Alert>
              </div>
            ) : null}

            {/* min-w-0 on each of the page's own blocks in Capsomer's panel
                body, which is a grid: without it a wide table pushes the
                card past the 800px column instead of scrolling inside it. */}
            <div className="fh-alerts-banner-row fh-small">
              <p className="fh-soft">
                {plural(alerts.length, "alert")} configured
                {notificationEmail ? (
                  <span className="fh-quiet"> · email goes to {notificationEmail}</span>
                ) : null}
              </p>
              {creating ? (
                // The button stays on screen, disabled while the form is open; Capsomer's Button says why it is disabled.
                <div className="cap-cluster" data-gap="3">
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
              <p className="fh-alerts-empty fh-center fh-small fh-quiet">No alerts yet.</p>
            ) : null}

            {alerts.length > 0 ? (
              <div className="fh-alerts-table">
                <Table caption="Alerts" captionHidden reflow="medium">
                  <thead>
                    <tr>
                      <th scope="col">Label</th>
                      <th scope="col">Metric</th>
                      <th scope="col">Condition</th>
                      <th scope="col">Channel</th>
                      <th scope="col">Last triggered</th>
                      <th scope="col">Status</th>
                      <th scope="col" data-num="">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts.map((a) => {
                      const condition = alertConditionLabel(
                        a.metric,
                        a.direction,
                        a.thresholdValue,
                      );
                      return (
                        <tr key={a.id}>
                          <td>{a.label ?? "-"}</td>
                          <td data-label="Metric">
                            <span className="fh-quiet">{alertMetricLabel(a.metric)}</span>
                          </td>
                          <td data-label="Condition">{condition}</td>
                          <td data-label="Channel">
                            <span className="fh-caps-fine fh-mono fh-tiny fh-quiet">
                              {a.channel}
                            </span>
                          </td>
                          <td data-label="Last triggered">
                            <span className="fh-mono fh-quiet">
                              {dateOrNever(a.lastTriggeredAt)}
                            </span>
                          </td>
                          <td data-label="Status">
                            <AlertSwitch
                              id={a.id}
                              enabled={a.enabled}
                              name={a.label ?? condition}
                              busy={busy}
                            />
                          </td>
                          <td data-label="Actions" data-num="">
                            <DemoForm method="post">
                              <input type="hidden" name="_action" value="delete" />
                              <input type="hidden" name="alertId" value={a.id} />
                              <Button type="submit" size="sm" pending={busy}>
                                Delete alert
                              </Button>
                            </DemoForm>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              </div>
            ) : null}

            {creating ? (
              <CreateAlertForm
                busy={busy}
                error={createError}
                initialMetric={params.get("metric")}
                hasSlack={hasSlack}
              />
            ) : null}
          </div>
        </div>
      </div>

      <div className="fh-mb-6">
        <Panel title="Recent triggers">
          {history.length === 0 ? (
            <p className="fh-small fh-quiet">No alerts have fired yet.</p>
          ) : (
            <Table caption="Recent triggers" captionHidden reflow>
              <thead>
                <tr>
                  <th scope="col">Metric</th>
                  <th scope="col">Condition</th>
                  <th scope="col">Actual value</th>
                  <th scope="col">Channel</th>
                  <th scope="col">Fired at</th>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td>{alertMetricLabel(h.metric)}</td>
                    <td data-label="Condition">
                      <span className="fh-quiet">
                        {alertShortCondition(h.direction, h.metric, h.thresholdValue)}
                      </span>
                    </td>
                    <td data-label="Actual value">
                      <span className="fh-mono">
                        {formatThresholdValue(h.metric, h.actualValue)}
                      </span>
                    </td>
                    <td data-label="Channel">
                      <span className="fh-caps-fine fh-mono fh-tiny fh-quiet">{h.channel}</span>
                    </td>
                    <td data-label="Fired at">
                      <span className="fh-mono fh-quiet">{formatDateTime(h.firedAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </section>
  );
}

/** On and Off status control on Capsomer's Switch: a real switch with its word beside it, named for its alert. Changing it posts the toggle at once. The switch follows the stored value, so a refused change (the demo, a failed write) springs back. */
function AlertSwitch({
  id,
  enabled,
  name,
  busy,
}: {
  id: string;
  enabled: boolean;
  name: string;
  busy: boolean;
}) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <DemoForm method="post" ref={form}>
      <input type="hidden" name="_action" value="toggle" />
      <input type="hidden" name="alertId" value={id} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <Switch
        label={<span className="cap-sr-only">{name} alert</span>}
        checked={enabled}
        busy={busy}
        onCheckedChange={() => form.current?.requestSubmit()}
      />
    </DemoForm>
  );
}

/** "Drops below" first and chosen; the evaluator's enum lists "above" first, so the page orders its own copy. */
const DIRECTION_ORDER: readonly AlertDirection[] = ["below", "above"];

/** The "Create a new alert" form, nested in the first card: Metric, Direction, Threshold, Label. The metric is held in state so the threshold shows $ for a money metric and its placeholder follows the metric. */
function CreateAlertForm({
  busy,
  error,
  initialMetric,
  hasSlack,
}: {
  busy: boolean;
  error?: string;
  initialMetric: string | null;
  hasSlack: boolean;
}) {
  const [metric, setMetric] = useState<string>(alertFormMetric(initialMetric));
  const [direction, setDirection] = useState<AlertDirection>(DIRECTION_ORDER[0]);
  const [channel, setChannel] = useState<"email" | "slack">("email");
  const prefix = alertThresholdPrefix(metric);
  const suffix = alertThresholdSuffix(metric);

  return (
    <div className="fh-alerts-form">
      <Panel title="Create a new alert" level={3}>
        <DemoForm method="post" className="cap-shrink">
          <input type="hidden" name="_action" value="create" />
          <div className="cap-stack fh-small" data-gap="5">
            <Field label="Metric">
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

            <Field label="Threshold" id="alert-threshold" required showRequired={false}>
              {(p) => (
                <InputGroup>
                  {prefix ? <InputGroupAddon align="inline-start">{prefix}</InputGroupAddon> : null}
                  <input
                    {...p}
                    className="cap-input"
                    name="threshold"
                    type="number"
                    min={0}
                    step={1}
                    placeholder={suffix ? "25" : prefix ? "5000" : "10"}
                  />
                  {suffix ? <InputGroupAddon align="inline-end">{suffix}</InputGroupAddon> : null}
                </InputGroup>
              )}
            </Field>

            <TextField
              label={
                <>
                  Label <span className="fh-quiet">(optional)</span>
                </>
              }
              name="label"
              placeholder="e.g. Low recovery rate warning"
            />

            <div className="cap-shrink">
              <Segmented
                legend="Channel"
                name="channel"
                fill
                value={channel}
                onChange={setChannel}
                options={[
                  { value: "email", label: "Email" },
                  { value: "slack", label: "Slack", disabled: !hasSlack },
                ]}
              />
              {!hasSlack ? (
                <p className="fh-mt-2 fh-tiny fh-quiet">
                  Add a Slack webhook above and save it first.
                </p>
              ) : null}
            </div>
          </div>

          {error ? (
            <div className="fh-mt-5">
              <Alert tone="crit">{error}</Alert>
            </div>
          ) : null}

          <div className="cap-cluster fh-alerts-actions" data-gap="4">
            <Button type="submit" variant="primary" pending={busy}>
              {busy ? "Creating..." : "Create alert"}
            </Button>
            <ButtonLink variant="quiet" to="/settings/notifications">
              Cancel
            </ButtonLink>
          </div>
        </DemoForm>
      </Panel>
    </div>
  );
}
