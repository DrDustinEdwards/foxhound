import { SaveBar } from "capsomer/react/save-bar";
import { TextField } from "capsomer/react/field";
import { data, useNavigation } from "react-router";

import { AlertsSection } from "~/components/alerts-section";
import { DemoForm } from "~/lib/demo/use-demo-guard";
import { SettingsLayout, SwitchRow } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { accounts, getDb } from "~/db";
import { eq } from "drizzle-orm";
import { accountScope } from "~/lib/auth/context";
import { syncPlatformCustomerEmail } from "~/lib/billing/platform-customer";
import {
  ALERT_INTENTS,
  answerAlertsAction,
  loadAlertsSection,
  type AlertActionResult,
} from "~/lib/settings/alerts-section.server";
import { applyNotificationSettings } from "~/lib/settings/apply.server";
import { openSlackWebhook } from "~/lib/notify/slack-webhook-secret.server";
import { SLACK_WEBHOOK_ERROR, SLACK_WEBHOOK_PLACEHOLDER } from "~/lib/settings/slack-webhook";

import type { Route } from "./+types/notifications";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /settings/notifications: the phone-only back link, the title and its line, one card holding the notification email, the Slack webhook URL, then four toggles (Slack notifications, Weekly digest, Payment recovered notification, Sequence complete notification), and under the card, right-aligned, Saved or the failure sentence beside Save changes. Each field is Capsomer's TextField, its help under the input. This page is the writer of the columns the digest, Slack and notice engines are gated on (the weekly digest cron mails NOBODY while `digest_enabled` is NULL-is-OFF and nothing sets it). The win-back and expiring-card toggles are on /settings/email.
// THE NULL MAP: slack_notifications_enabled ?? false (NULL renders OFF); digest_enabled ?? false (OFF); recovery_notifications_enabled ?? true (ON); sequence_complete_notifications_enabled ?? true (ON). The digest cron selects `digest_enabled = true` and the Slack sender gates on a truthy `slack_notifications_enabled`.
// A blank notification email box saves NULL: the payment recovered and sequence complete notices skip a NULL address as `no_recipient`, and the digest cron drops it, so the help line says what a blank box does, and the placeholder does not show the signed-in address grayed in (it would imply it gets mail). A real fallback in the senders would be a behavior change. The signed-in email is prefilled in the box, and Save stores it.
// The Slack webhook URL is validated to `https://hooks.slack.com`, and its refusal is said beside the field.

export function meta() {
  return [{ title: "Notification settings - Foxhound" }, NOINDEX];
}

/** A column nobody has touched means the merchant is notified, which is what every engine's reader already assumes. */
const NULL_IS_ON = true;
/** Explicit opt-in. */
const NULL_IS_OFF = false;

const SAVE_FAILED = "Failed to save. Please try again.";

export async function loader({ context }: Route.LoaderArgs) {
  const { env, auth, db } = accountScope(context);
  const alertsSection = loadAlertsSection(env, db, auth.membership.accountId);
  const [row] = await db
    .select({
      notificationEmail: accounts.notificationEmail,
      slackWebhookUrl: accounts.slackWebhookUrl,
      slackNotificationsEnabled: accounts.slackNotificationsEnabled,
      digestEnabled: accounts.digestEnabled,
      recoveryNotificationsEnabled: accounts.recoveryNotificationsEnabled,
      sequenceCompleteNotificationsEnabled: accounts.sequenceCompleteNotificationsEnabled,
    })
    .from(accounts)
    .where(eq(accounts.id, auth.membership.accountId))
    .limit(1);

  return {
    // A NULL address shows the signed-in email IN the box, so the first Save stores it. The box is truthful because Save writes what it shows.
    notificationEmail: row?.notificationEmail ?? auth.email,
    // Opened for the merchant's own form only; the column holds it sealed.
    slackWebhookUrl: (await openSlackWebhook(env, row?.slackWebhookUrl ?? null)) ?? "",
    slackNotificationsEnabled: row?.slackNotificationsEnabled ?? NULL_IS_OFF,
    digestEnabled: row?.digestEnabled ?? NULL_IS_OFF,
    recoveryNotificationsEnabled: row?.recoveryNotificationsEnabled ?? NULL_IS_ON,
    sequenceCompleteNotificationsEnabled: row?.sequenceCompleteNotificationsEnabled ?? NULL_IS_ON,
    // The alerts sit under the delivery settings.
    alerts: await alertsSection,
  };
}

interface ActionResult {
  ok: boolean;
  /** A refusal with a field of its own, said beside that field. */
  error?: string;
  field?: "slackWebhookUrl";
  failed?: boolean;
}

/** A checkbox posts its name only when checked, so an absent key is OFF. */
function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, auth } = accountScope(context);
  const form = await readForm(request, BODY_MAX_BYTES);

  // The alerts' own forms carry an intent; the delivery form carries none.
  const intent = String(form.get("_action") ?? "");
  if ((ALERT_INTENTS as readonly string[]).includes(intent)) {
    return answerAlertsAction(getDb(env), auth.membership.accountId, form, intent);
  }

  // THE WEBHOOK RULE AND THE SIX COLUMNS live in apply.server.ts, shared with the MCP `set_notification_settings` tool, so an agent sees the same refusal sentence a person does.
  let result: Awaited<ReturnType<typeof applyNotificationSettings>>;
  let before:
    | { notificationEmail: string | null; platformStripeCustomerId: string | null }
    | undefined;
  try {
    const db = getDb(env);
    // Read before the write, so a changed address can be pushed to the billing customer below.
    [before] = await db
      .select({
        notificationEmail: accounts.notificationEmail,
        platformStripeCustomerId: accounts.platformStripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.id, auth.membership.accountId))
      .limit(1);
    result = await applyNotificationSettings(env, db, auth.membership.accountId, {
      notificationEmail: form.get("notificationEmail"),
      slackWebhookUrl: String(form.get("slackWebhookUrl") ?? ""),
      slackNotificationsEnabled: checked(form, "slackNotificationsEnabled"),
      digestEnabled: checked(form, "digestEnabled"),
      recoveryNotificationsEnabled: checked(form, "recoveryNotificationsEnabled"),
      sequenceCompleteNotificationsEnabled: checked(form, "sequenceCompleteNotificationsEnabled"),
    });
  } catch (err) {
    // A failed update answers with the SaveBar sentence, not an error page. The whole error is logged, stack included, so a D1 failure can be traced; it carries no form values.
    console.error("notification settings write failed:", err);
    return data<ActionResult>({ ok: false, failed: true }, { status: 500 });
  }
  if (!result.ok) {
    return data<ActionResult>(
      result.error === SLACK_WEBHOOK_ERROR
        ? { ok: false, error: result.error, field: "slackWebhookUrl" }
        : { ok: false, error: result.error },
      { status: 400 },
    );
  }
  // Two-way sync with Stripe: a changed, non-empty notification email goes to the platform billing customer, when there is one. A failed push neither undoes nor fails the save.
  const newEmail = result.state.notificationEmail;
  if (
    newEmail &&
    newEmail !== (before?.notificationEmail ?? null) &&
    before?.platformStripeCustomerId
  ) {
    await syncPlatformCustomerEmail(env, {
      customerId: before.platformStripeCustomerId,
      email: newEmail,
    });
  }
  return data<ActionResult>({ ok: true });
}

export default function NotificationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // An alert's toggle or delete is not a save of this form.
  const busy = navigation.state !== "idle" && !navigation.formData?.has("_action");
  const posted = actionData as (ActionResult & { action?: string }) | undefined;
  const alertResult = posted?.action ? (posted as AlertActionResult) : undefined;
  const result = posted?.action ? undefined : posted;
  const webhookError = result?.field === "slackWebhookUrl" ? result.error : undefined;
  const otherError =
    result && !result.ok && !result.field ? (result.error ?? SAVE_FAILED) : undefined;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="Notifications">
      <DemoForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="fh-email-block">
              {/* Recova puts help under the control. */}
              <TextField
                helpPlacement="after"
                announce
                name="notificationEmail"
                type="email"
                label="Notification email"
                defaultValue={loaderData.notificationEmail}
              />
            </div>

            {/* The rule under the webhook field stands above the first switch row. */}
            <div className="fh-notify-group">
              <TextField
                announce
                name="slackWebhookUrl"
                type="text"
                label="Slack webhook URL"
                defaultValue={loaderData.slackWebhookUrl}
                placeholder={SLACK_WEBHOOK_PLACEHOLDER}
                error={webhookError}
              />
            </div>

            <SwitchRow
              name="slackNotificationsEnabled"
              label="Slack notifications"
              defaultChecked={loaderData.slackNotificationsEnabled}
            />
            <SwitchRow
              name="digestEnabled"
              label="Weekly digest, sent Mondays"
              defaultChecked={loaderData.digestEnabled}
            />
            <SwitchRow
              name="recoveryNotificationsEnabled"
              label="Payment recovered notification"
              defaultChecked={loaderData.recoveryNotificationsEnabled}
            />
            <SwitchRow
              name="sequenceCompleteNotificationsEnabled"
              label="Sequence complete notification"
              defaultChecked={loaderData.sequenceCompleteNotificationsEnabled}
            />
          </div>
        </section>

        {/* Legacy's SaveBar: right-aligned under the card, the result beside the button. */}
        <SaveBar pending={busy} saved={result?.ok === true} error={otherError} />
      </DemoForm>

      <AlertsSection data={loaderData.alerts} result={alertResult} />
    </SettingsLayout>
  );
}
