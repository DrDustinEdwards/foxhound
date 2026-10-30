// The alerts part of /settings/notifications: its read and its writes. The
// alerts list used to be its own page, /settings/alerts (S28); Dustin had it
// combined with Notifications on 2026-10-29, since both decide what you are
// told and where. The UI is app/components/alerts-section.tsx.
import { data, redirect } from "react-router";

import type { Db } from "~/db";
import { loadAlertTarget } from "~/lib/intelligence/alert-notify.server";
import { getAlertsView } from "~/lib/intelligence/views.server";
import { applyAlertConfig, applyAlertCreate } from "~/lib/settings/apply.server";

/** Where the alerts live now. A created alert redirects here. */
const ALERTS_PAGE = "/settings/notifications";

/** The form intents the alerts part answers. */
export const ALERT_INTENTS = ["create", "toggle", "delete"] as const;

/** Recova's page reads the twenty most recent firings. */
const RECENT_TRIGGERS = 20;

export async function loadAlertsSection(db: Db, accountId: string) {
  const [view, target] = await Promise.all([getAlertsView(db, accountId), loadAlertTarget(db, accountId)]);
  return {
    alerts: view.alerts,
    history: view.history.slice(0, RECENT_TRIGGERS),
    notificationEmail: target.notificationEmail,
    hasSlack: !!target.slackWebhookUrl,
  };
}

export interface AlertActionResult {
  action: string;
  ok: boolean;
  error?: string;
}

export async function answerAlertsAction(db: Db, accountId: string, form: FormData, intent: string) {
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
        channel: form.get("channel"),
      },
      new Date(),
    );
    if (!result.ok) {
      return data<AlertActionResult>(
        { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
    }
    // Recova's dismissPanel: a created alert closes the form, clears its
    // fields and re-enables Create alert. Redirecting drops ?new=1, so the
    // form cannot be sent twice with the same values. A refusal above keeps
    // the form open with its message.
    return redirect(ALERTS_PAGE);
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
      return data<AlertActionResult>(
        { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
    }
    return data<AlertActionResult>({ action: intent, ok: true });
  }

  return data<AlertActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}
