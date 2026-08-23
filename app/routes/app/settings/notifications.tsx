import { data, useNavigation } from "react-router";

import { Alert, Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { accounts, getDb } from "~/db";
import { eq } from "drizzle-orm";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildNotificationSettingsUpdate } from "~/lib/settings/persist.server";
import {
  normalizeSlackWebhookUrl,
  SLACK_WEBHOOK_PLACEHOLDER,
} from "~/lib/settings/slack-webhook";

import type { Route } from "./+types/notifications";

// S36, /settings/notifications. THE SURFACE FIVE ENGINES HAVE BEEN WAITING ON.
//
// Sessions 47, 48, 49, 52 and 55 each built a subsystem gated on a column with
// no writer. 350 binding 2 recorded the sharpest case: the weekly digest cron
// is correct, proven, and mails NOBODY, because `digest_enabled` is NULL-is-OFF
// and nothing could set it. This page is what ends that, and it is ruling 315's
// order finally satisfied rather than inverted.
//
// LEGACY IS THE SPEC, read whole:
//   components/NotificationsSection.tsx  blob 494c6dfa  4,573 bytes
//   settings/notifications/page.tsx      blob 93126fd2  1,669 bytes
//   settings/update/route.ts             lines 53 to 63
//
// ONE PAGE, FOUR TOGGLES, TWO FIELDS, in legacy's order. The win-back and
// expiring-card toggles are NOT here: legacy renders them on its features page,
// which is 336's reversal against the docs' "six toggles" and is S34's work.
//
// THE NULL MAP IS LEGACY'S OWN, read off its page defaults rather than assumed:
//   slack_notifications_enabled ?? false            NULL renders OFF
//   digest_enabled ?? false                         NULL renders OFF
//   recovery_notifications_enabled ?? true          NULL renders ON
//   sequence_complete_notifications_enabled ?? true NULL renders ON
// 337 binding 3 says "only digest_enabled" is NULL-is-OFF; there are TWO, and
// the SENDER agrees, gating Slack on a truthy `slack_notifications_enabled &&`.
//
// ONE DIVERGENCE, ratified by Dustin this session: the Slack webhook URL is
// validated to `https://hooks.slack.com`. Legacy stores any string verbatim,
// and Foxhound would then fetch it from the Worker on every dunning email with
// nothing in the tree constraining egress. See lib/settings/slack-webhook.ts.

export function meta() {
  return [{ title: "Notification settings - Foxhound" }];
}

/** Legacy's `?? true` pair. A column nobody has touched means the merchant is
 *  notified, which is what every engine's reader already assumes. */
const NULL_IS_ON = true;
/** Legacy's `?? false` pair. Explicit opt-in, and 315's rejected alternative
 *  was defaulting these on. */
const NULL_IS_OFF = false;

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
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
    // Legacy places the account email in the FIELD, not the placeholder, so a
    // save with an untouched box keeps writing it. Ported as found.
    notificationEmail: row?.notificationEmail ?? auth.email,
    slackWebhookUrl: row?.slackWebhookUrl ?? "",
    slackNotificationsEnabled: row?.slackNotificationsEnabled ?? NULL_IS_OFF,
    digestEnabled: row?.digestEnabled ?? NULL_IS_OFF,
    recoveryNotificationsEnabled: row?.recoveryNotificationsEnabled ?? NULL_IS_ON,
    sequenceCompleteNotificationsEnabled:
      row?.sequenceCompleteNotificationsEnabled ?? NULL_IS_ON,
  };
}

interface ActionResult {
  ok: boolean;
  error?: string;
}

/** A checkbox posts its name only when checked, so an absent key is OFF. */
function checked(form: FormData, name: string): boolean {
  return form.get(name) === "on";
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const form = await request.formData();

  const webhook = normalizeSlackWebhookUrl(String(form.get("slackWebhookUrl") ?? ""));
  if (!webhook.ok) {
    return data<ActionResult>({ ok: false, error: webhook.error }, { status: 400 });
  }

  const email = String(form.get("notificationEmail") ?? "").trim();

  await buildNotificationSettingsUpdate(db, auth.membership.accountId, {
    // Legacy's `|| null`: clearing the box is how a merchant turns every
    // notification off, which 339 binding 1 already relies on.
    notificationEmail: email.length > 0 ? email : null,
    slackWebhookUrl: webhook.value,
    slackNotificationsEnabled: checked(form, "slackNotificationsEnabled"),
    digestEnabled: checked(form, "digestEnabled"),
    recoveryNotificationsEnabled: checked(form, "recoveryNotificationsEnabled"),
    sequenceCompleteNotificationsEnabled: checked(form, "sequenceCompleteNotificationsEnabled"),
  });
  return data<ActionResult>({ ok: true });
}

function ToggleRow({
  name,
  label,
  help,
  defaultChecked,
}: {
  name: string;
  label: string;
  help: string;
  defaultChecked: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border py-4">
      <div>
        <label htmlFor={name} className="text-label text-text">
          {label}
        </label>
        <p className="mt-0.5 text-caption text-text-subtle">{help}</p>
      </div>
      <input id={name} type="checkbox" name={name} defaultChecked={defaultChecked} />
    </div>
  );
}

export default function NotificationSettings({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const result = actionData as ActionResult | undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">Notifications</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Email, Slack, and digest delivery preferences.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {result?.ok ? <Alert tone="success">Saved.</Alert> : null}
        {result && !result.ok && result.error ? <Alert tone="error">{result.error}</Alert> : null}

        <DemoGuardedForm method="post">
          <div className="mb-5">
            <label htmlFor="notificationEmail" className="text-label text-text-tertiary">
              Notification email
            </label>
            <input
              id="notificationEmail"
              type="email"
              name="notificationEmail"
              defaultValue={loaderData.notificationEmail}
              className="mt-2 w-full rounded-md border border-border-i bg-surface px-3 py-2 text-body text-text"
            />
            <p className="mt-1.5 text-caption text-text-subtle">
              Where all notifications are sent: recovery alerts, sequence updates, and weekly
              digest. Defaults to your account email if blank.
            </p>
          </div>

          <div className="mb-5 border-t border-border pt-4">
            <label htmlFor="slackWebhookUrl" className="text-label text-text-tertiary">
              Slack webhook URL
            </label>
            <input
              id="slackWebhookUrl"
              type="text"
              name="slackWebhookUrl"
              defaultValue={loaderData.slackWebhookUrl}
              placeholder={SLACK_WEBHOOK_PLACEHOLDER}
              className="mt-2 w-full rounded-md border border-border-i bg-surface px-3 py-2 text-body text-text"
            />
            <p className="mt-1.5 text-caption text-text-subtle">
              Get notified in Slack when payments are recovered
            </p>
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

          <div className="mt-5">
            <Submit disabled={busy}>{busy ? "Saving..." : "Save"}</Submit>
          </div>
        </DemoGuardedForm>
      </section>
    </div>
  );
}
