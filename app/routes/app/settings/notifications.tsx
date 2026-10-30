import { useId } from "react";
import { data, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import { Status } from "capsomer/react/status";
import "capsomer/button.css";
import "capsomer/field.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
import "capsomer/status.css";
import "capsomer/switch.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/api-keys does.
import "~/site-header.css";

import { AlertsSection } from "~/components/alerts-section";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { ToggleRow } from "~/components/settings-toggle-row";
import { SettingsBackLink } from "~/components/settings-back-link";
import { accounts, getDb } from "~/db";
import { eq } from "drizzle-orm";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { syncPlatformCustomerEmail } from "~/lib/billing/platform-customer";
import {
  ALERT_INTENTS,
  answerAlertsAction,
  loadAlertsSection,
  type AlertActionResult,
} from "~/lib/settings/alerts-section.server";
import { applyNotificationSettings } from "~/lib/settings/apply.server";
import {
  SLACK_WEBHOOK_ERROR,
  SLACK_WEBHOOK_PLACEHOLDER,
} from "~/lib/settings/slack-webhook";

import type { Route } from "./+types/notifications";
import { NOINDEX } from "~/lib/seo/meta";

// S36, /settings/notifications. THE SURFACE FIVE ENGINES HAVE BEEN WAITING ON.
//
// Sessions 47, 48, 49, 52 and 55 each built a subsystem gated on a column with
// no writer. 350 binding 2 recorded the sharpest case: the weekly digest cron
// is correct, proven, and mails NOBODY, because `digest_enabled` is NULL-is-OFF
// and nothing could set it. This page is what ends that.
//
// LEGACY IS THE SPEC, read whole at HEAD:
//   settings/notifications/page.tsx               blob 93126fd2  1,669 bytes
//   settings/notifications/NotificationsForm.tsx  blob 316c15cf  1,734 bytes
//   settings/components/NotificationsSection.tsx  blob 494c6dfa  4,573 bytes
//   settings/SaveBar.tsx                          blob f1d6eb23
//   components/Toggle.tsx                         blob 0ebdd395
//   components/SettingsBackLink.tsx               blob 64d4a153
//   settings/update/route.ts                      blob 878c0637
//
// J39 rebuilt it from Capsomer 0.9.0's parts under Dustin's
// Q10 and Q11 answers of 2026-10-14: PageHead, the panel, the field parts,
// Switch, Status and Button, amber throughout. Recova stays the spec for what
// is here and in what order: the phone-only back link, the title and its line,
// one card holding the notification email, the Slack webhook URL, then four
// toggles (Slack notifications, Weekly digest, Payment recovered notification,
// Sequence complete notification), and under the card, right-aligned, Saved or
// the failure sentence beside Save changes. Each field's help sits under its
// input, as Recova's does, so the field is composed from Capsomer's field
// classes rather than its <Field>, which puts help above the control.
//
// The win-back and expiring-card toggles are NOT here: legacy renders them on
// its features page (S34).
//
// THE NULL MAP IS LEGACY'S OWN, read off its page defaults:
//   slack_notifications_enabled ?? false            NULL renders OFF
//   digest_enabled ?? false                         NULL renders OFF
//   recovery_notifications_enabled ?? true          NULL renders ON
//   sequence_complete_notifications_enabled ?? true NULL renders ON
// The engine agrees: the digest cron selects `digest_enabled = true` and the
// Slack sender gates on a truthy `slack_notifications_enabled`.
//
// ONE TRUTHFULNESS FIX: Recova's help line ends "Defaults to
// your account email if blank." That was untrue there and is untrue here: a
// blank box saves NULL (legacy's `|| null`), the payment recovered and sequence
// complete notices skip a NULL address as `no_recipient`, and the digest cron
// drops it. So the line says what a blank box does. Recova's prefill of the
// signed-in email into the box is kept (Save stores it), but its placeholder
// is not, because a cleared box showing that address grayed in would imply it
// gets mail. A real fallback in the senders would be a behavior change and is
// Dustin's ruling, not this page's.
//
// ONE DIVERGENCE, approved (APPROVED-DIFFERENCES, "Slack webhook addresses must
// be on hooks.slack.com", 2026-09-19; RULES.md 4.16): the webhook URL is
// validated to `https://hooks.slack.com`, and its refusal is said beside the
// field. Legacy stores any string verbatim.

export function meta() {
  return [{ title: "Notification settings - Foxhound" }, NOINDEX];
}

/** Legacy's `?? true` pair. A column nobody has touched means the merchant is
 *  notified, which is what every engine's reader already assumes. */
const NULL_IS_ON = true;
/** Legacy's `?? false` pair. Explicit opt-in. */
const NULL_IS_OFF = false;

/** Legacy's SaveBar failure sentence, said when the action returns
 *  `failed: true` because the write itself threw. */
const SAVE_FAILED = "Failed to save. Please try again.";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const alertsSection = loadAlertsSection(db, auth.membership.accountId);
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
    // Recova's `notification_email ?? user.email`: a NULL address shows the
    // signed-in email IN the box, so the first Save stores it. The box is
    // truthful because Save writes what it shows.
    notificationEmail: row?.notificationEmail ?? auth.email,
    slackWebhookUrl: row?.slackWebhookUrl ?? "",
    slackNotificationsEnabled: row?.slackNotificationsEnabled ?? NULL_IS_OFF,
    digestEnabled: row?.digestEnabled ?? NULL_IS_OFF,
    recoveryNotificationsEnabled: row?.recoveryNotificationsEnabled ?? NULL_IS_ON,
    sequenceCompleteNotificationsEnabled:
      row?.sequenceCompleteNotificationsEnabled ?? NULL_IS_ON,
    // The alerts, once /settings/alerts, under the delivery settings
    // (Dustin, 2026-10-29).
    alerts: await alertsSection,
  };
}

interface ActionResult {
  ok: boolean;
  /** A refusal with a field of its own, said beside that field. */
  error?: string;
  field?: "slackWebhookUrl";
  /** The write itself failed: legacy's SaveBar sentence. */
  failed?: boolean;
}

/** A checkbox posts its name only when checked, so an absent key is OFF. */
function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const form = await request.formData();

  // The alerts' own forms carry an intent; the delivery form carries none.
  const intent = String(form.get("_action") ?? "");
  if ((ALERT_INTENTS as readonly string[]).includes(intent)) {
    return answerAlertsAction(getDb(env), auth.membership.accountId, form, intent);
  }

  // THE WEBHOOK RULE AND THE SIX COLUMNS live in apply.server.ts, shared with
  // the MCP `set_notification_settings` tool, so an agent sees the same
  // refusal sentence a person does.
  let result: Awaited<ReturnType<typeof applyNotificationSettings>>;
  let before: { notificationEmail: string | null; platformStripeCustomerId: string | null } | undefined;
  try {
    const db = getDb(env);
    // Read before the write, as Recova does, so a changed address can be
    // pushed to the billing customer below.
    [before] = await db
      .select({
        notificationEmail: accounts.notificationEmail,
        platformStripeCustomerId: accounts.platformStripeCustomerId,
      })
      .from(accounts)
      .where(eq(accounts.id, auth.membership.accountId))
      .limit(1);
    result = await applyNotificationSettings(db, auth.membership.accountId, {
      notificationEmail: form.get("notificationEmail"),
      slackWebhookUrl: String(form.get("slackWebhookUrl") ?? ""),
      slackNotificationsEnabled: checked(form, "slackNotificationsEnabled"),
      digestEnabled: checked(form, "digestEnabled"),
      recoveryNotificationsEnabled: checked(form, "recoveryNotificationsEnabled"),
      sequenceCompleteNotificationsEnabled: checked(form, "sequenceCompleteNotificationsEnabled"),
    });
  } catch (err) {
    // Legacy answers a failed update with its SaveBar sentence, not an error
    // page. The whole error is logged, stack included, so a D1 failure can be
    // traced; it carries no form values.
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
  // Recova's two-way sync with Stripe: a changed, non-empty notification email
  // goes to the platform billing customer, when there is one. A failed push
  // neither undoes nor fails the save.
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

/** One of Recova's text fields: label, input, then help under it, as
 *  NotificationsSection draws them, from Capsomer's field parts. */
function TextField({
  name,
  type,
  label,
  help,
  defaultValue,
  placeholder,
  error,
}: {
  name: string;
  type: "email" | "text";
  label: string;
  help: string;
  defaultValue: string;
  placeholder?: string;
  error?: string;
}) {
  const base = useId();
  const id = `${base}-control`;
  const helpId = `${base}-help`;
  const errorId = `${base}-error`;
  return (
    <div className="cap-field" data-invalid={error ? "true" : undefined}>
      <label className="cap-field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type={type}
        name={name}
        className="cap-input"
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-describedby={error ? `${errorId} ${helpId}` : helpId}
        aria-invalid={error ? true : undefined}
      />
      <p className="cap-field-help" id={helpId}>
        {help}
      </p>
      <p className="cap-field-error" id={errorId} role={error ? "alert" : undefined} hidden={!error}>
        {error ?? null}
      </p>
    </div>
  );
}

export default function NotificationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  // An alert's toggle or delete is not a save of this form.
  const busy = navigation.state !== "idle" && !navigation.formData?.has("_action");
  const posted = actionData as (ActionResult & { action?: string }) | undefined;
  const alertResult = posted?.action ? (posted as AlertActionResult) : undefined;
  const result = posted?.action ? undefined : posted;
  const webhookError = result?.field === "slackWebhookUrl" ? result.error : undefined;
  const otherError = result && !result.ok && !result.field ? (result.error ?? SAVE_FAILED) : undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead title="Notifications" lead="Email, Slack, and digest delivery preferences, and alerts on your metrics." />
      </div>

      <DemoGuardedForm method="post">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="mb-5">
              <TextField
                name="notificationEmail"
                type="email"
                label="Notification email"
                help="Where all notifications are sent: recovery alerts, sequence updates, and weekly digest. Leave it blank and no notification emails are sent."
                defaultValue={loaderData.notificationEmail}
              />
            </div>

            <div className="mb-5 border-t border-border pt-4">
              <TextField
                name="slackWebhookUrl"
                type="text"
                label="Slack webhook URL"
                help="Get notified in Slack when payments are recovered"
                defaultValue={loaderData.slackWebhookUrl}
                placeholder={SLACK_WEBHOOK_PLACEHOLDER}
                error={webhookError}
              />
            </div>

            <ToggleRow
              name="slackNotificationsEnabled"
              label="Slack notifications"
              help="Notify when a payment is recovered or an email is sent"
              defaultChecked={loaderData.slackNotificationsEnabled}
            />
            <ToggleRow
              name="digestEnabled"
              label="Weekly digest"
              help="Monday summary of recovered revenue and active sequences"
              defaultChecked={loaderData.digestEnabled}
            />
            <ToggleRow
              name="recoveryNotificationsEnabled"
              label="Payment recovered notification"
              help="Email me when a payment is successfully recovered"
              defaultChecked={loaderData.recoveryNotificationsEnabled}
            />
            <ToggleRow
              name="sequenceCompleteNotificationsEnabled"
              label="Sequence complete notification"
              help="Email me when a recovery sequence ends without recovering the payment"
              defaultChecked={loaderData.sequenceCompleteNotificationsEnabled}
            />
          </div>
        </section>

        {/* Legacy's SaveBar: right-aligned under the card, the result beside
            the button. The live region is on the page from the start, so the
            result is announced when it arrives. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <span role="status">
            {result?.ok ? <Status tone="ok">Saved</Status> : null}
            {otherError ? <Status tone="crit">{otherError}</Status> : null}
          </span>
          <Button type="submit" variant="primary" pending={busy}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>

      <AlertsSection data={loaderData.alerts} result={alertResult} />
    </>
  );
}
