import { useEffect, useId, useState } from "react";
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
// page whole under any layout, as /settings/notifications does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { ToggleRow } from "~/components/settings-toggle-row";
import { SettingsBackLink } from "~/components/settings-back-link";
import { accounts, getDb } from "~/db";
import { eq } from "drizzle-orm";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { REPLY_TO_EMAIL_MAX_LENGTH } from "~/lib/settings/reply-to";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";
import { applyFeatureSettings, applySenderName } from "~/lib/settings/apply.server";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";
import { sendTestEmail } from "~/lib/settings/test-email.server";

import type { Route } from "./+types/email";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "~/lib/http/body";

// S33, /settings/email, a named launch blocker in core.md: with no writer for
// `sender_name`, `toEmailContext` fell back to "your subscription" and that
// phrase became the From display name of every recovery email. This page is
// that writer.
//
// LEGACY IS THE SPEC, read whole at blob shas: email/page.tsx 62de18af (1,169),
// EmailSectionForm.tsx 57b2fb09 (1,559), components/EmailSection.tsx 3c89ca41
// (3,048), settings/update/route.ts 878c0637 (10,356), settings/test-email/
// route.ts dcc3a06f (11,006), lib/email-utils.ts 9f0e7a8c (3,775).
//
// DIVERGENCES, each classed rather than glossed:
//
// 1. ONE OF LEGACY'S THREE FIELDS IS NOT RENDERED. `sender_domain` has no
//    reader and is deliberately not built; its legacy job ("Used
//    in billing portal links", its own help string) is a different subsystem.
//    `reply_to_email` IS rendered since J03, with its reader: send.ts sets
//    Reply-To on merchant-customer email only when a valid address is saved,
//    and sets none otherwise, so a reply goes to the From. The writer landed
//    with the reader. Two differences from legacy, both flagged
//    for Dustin: a server-side format check and a 254-character bound
//    (app/lib/settings/reply-to.ts), input hygiene like the sender name's bound;
//    and no Reply-To fallback to the From when the box is empty, which legacy's
//    engine has and which changes nothing for the recipient.
// 2. `sender_name` IS OPTIONAL, matching legacy, and BOUNDED AT 80, which
//    legacy is not. The requirement shipped for one session and 335 reverted it:
//    legacy writes `|| null` on an empty box and its empty case delivers through
//    the `|| 'Support'` fallback Foxhound matches, so requiring it was an
//    unratified user-visible divergence. The BOUND stays, flagged for Dustin as
//    input hygiene on a header field, and is still an addition rather than a
//    port.
// 3. THE WRITE PATH is this route's own action rather than legacy's shared
//    `/settings/update` (unbuilt). Class (a), exactly S30's divergence
//    1, and it avoids building S38 as a side effect.
// 4. THE TEST EMAIL'S OUTCOMES. Recova's button says "Sent! Check your inbox"
//    or "Failed. Try again." and goes back to "Send test email" after four
//    seconds; so does this one. Foxhound's send path also refuses a suppressed
//    address, which Recova's has no such gate for, and "Try again" would not
//    help there, so that outcome says why nothing was sent.
//
// J37 rebuilt the page from Capsomer 0.9.0's parts under
// Dustin's Q10 and Q11 answers of 2026-10-14: PageHead, the panel, the field
// parts, Button and Status, amber throughout. Recova stays the spec for what is
// here and in what order: the phone-only back link, the title and its line, one
// card holding Sender name, Reply-to email and the Send test email button, and
// under the card, right-aligned, Saved or the failure sentence beside Save
// changes. Each field's help sits under its input, as Recova's does, so the
// field is composed from Capsomer's field classes rather than its <Field>,
// which puts help above the control (as /settings/notifications does).
//
// THE TEST BUTTON SITS IN THE CARD BUT POSTS ITS OWN FORM, through the HTML
// `form` attribute. Recova's is a type="button" inside the save form that
// fetches its own route; a submit button owned by the save form would be the
// one an Enter key in the sender name presses, and would send mail. Owned by
// its own DemoGuardedForm it keeps the demo refusal and works without script.

// THE RECOVERY EMAILS CARD was /settings/features (S34, J38): Recova's two
// switches, win-back sequences and expiring card alerts. Dustin had the page
// combined with this one on 2026-10-29, since both switches turn emails to
// customers on or off. It keeps its own form and save bar, and the NULL-is-ON
// pair: a merchant who never touched it has both on.

export function meta() {
  return [{ title: "Email settings - Foxhound" }, NOINDEX];
}

const NULL_IS_ON = true;

/** Legacy's SaveBar failure sentence, said when the write itself threw. */
const SAVE_FAILED = "Failed to save. Please try again.";

/** Legacy's button labels, one per state of its `testEmailStatus`. */
const TEST_IDLE = "Send test email";
const TEST_SENDING = "Sending...";
const TEST_SENT = "Sent! Check your inbox";
const TEST_FAILED = "Failed. Try again.";
/** The suppressed outcome (divergence 4). The send path suppresses an address
 *  on an unsubscribe (suppression.ts) or a bounce or complaint event
 *  (events.ts), and on nothing else. */
const TEST_SUPPRESSED = "Not sent. Your address is blocked after an unsubscribe, bounce or complaint.";
/** Legacy's `setTimeout(() => setTestEmailStatus('idle'), 4000)`. */
const TEST_RESULT_MS = 4000;

const TEST_FORM_ID = "settings-test-email";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const [connection, [features]] = await Promise.all([
    getPrimarySenderConnection(db, auth.membership.accountId),
    db
      .select({
        winbackNotificationsEnabled: accounts.winbackNotificationsEnabled,
        expiringCardNotificationsEnabled: accounts.expiringCardNotificationsEnabled,
      })
      .from(accounts)
      .where(eq(accounts.id, auth.membership.accountId))
      .limit(1),
  ]);
  return {
    connectionId: connection?.id ?? null,
    senderName: connection?.senderName ?? "",
    replyToEmail: connection?.replyToEmail ?? "",
    winbackNotificationsEnabled: features?.winbackNotificationsEnabled ?? NULL_IS_ON,
    expiringCardNotificationsEnabled: features?.expiringCardNotificationsEnabled ?? NULL_IS_ON,
  };
}

type SenderField = "senderName" | "replyToEmail";

interface ActionResult {
  action: string;
  ok: boolean;
  /** A refusal, said beside `field` when it names one, else in the save bar. */
  error?: string;
  field?: SenderField;
  /** The write itself failed: legacy's SaveBar sentence. */
  failed?: boolean;
  /** The test email's named outcome (EmailSendStatus). */
  status?: string;
}

/** Which field a refusal from applySenderName belongs to. Its sentences name
 *  the field they are about; "Connect Stripe..." names none. */
function fieldOf(error: string): SenderField | undefined {
  if (/^Sender name\b/.test(error)) return "senderName";
  if (/reply-to/i.test(error)) return "replyToEmail";
  return undefined;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const form = await readForm(request);
  const intent = String(form.get("_action") ?? "");

  if (intent === "sender") {
    // THE SENDER BRANCH'S CORE is in apply.server.ts, shared with the MCP
    // `set_sender_name` tool, so an agent is refused with this form's own
    // sentences. The name stays OPTIONAL, per ruling 335: legacy writes
    // `|| null` on an empty box and its empty case delivers through the
    // `|| 'Support'` fallback Foxhound matches.
    let result: Awaited<ReturnType<typeof applySenderName>>;
    try {
      result = await applySenderName(getDb(env), accountId, {
        connectionId: form.get("connectionId"),
        senderName: form.get("senderName"),
        // Sent only when the form carries the field, as legacy's
        // `formData.has('reply_to_email')`.
        replyToEmail: form.has("replyToEmail") ? form.get("replyToEmail") : undefined,
      });
    } catch (err) {
      // Legacy answers a failed update with its SaveBar sentence, not an error
      // page. The whole error is logged, stack included, so a D1 failure can be
      // traced; it carries no form values.
      console.error("email settings write failed:", err);
      return data<ActionResult>({ action: intent, ok: false, failed: true }, { status: 500 });
    }
    if (!result.ok) {
      const field = fieldOf(result.error);
      return data<ActionResult>(
        field ? { action: intent, ok: false, error: result.error, field } : { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  if (intent === "features") {
    // TWO columns, through the shared apply layer so this form
    // and the MCP `set_feature_settings` tool cannot disagree. A checkbox posts
    // its name only when checked, so an absent key is OFF.
    try {
      await applyFeatureSettings(getDb(env), accountId, {
        winbackNotificationsEnabled: form.get("winbackNotificationsEnabled") === "on",
        expiringCardNotificationsEnabled: form.get("expiringCardNotificationsEnabled") === "on",
      });
    } catch (err) {
      console.error("feature settings write failed:", err);
      return data<ActionResult>({ action: intent, ok: false, failed: true }, { status: 500 });
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  if (intent === "test-email") {
    // The address is the SESSION user's, never the form's, so this cannot be
    // pointed at a third party. It sends with the account's live
    // sending off, as Recova's does, because its audience is "preview".
    try {
      const { result } = await sendTestEmail(env, accountId, auth.email);
      return data<ActionResult>({ action: intent, ok: result.status === "sent", status: result.status });
    } catch (err) {
      // sendTestEmail returns a named outcome for every refused send; what
      // throws is the read before it. Recova's button says it failed.
      console.error("test email failed:", err);
      return data<ActionResult>({ action: intent, ok: false, status: "failed" }, { status: 500 });
    }
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}

/** One of Recova's text fields: label, input, then help under it, as
 *  EmailSection draws them, from Capsomer's field parts. */
function TextField({
  name,
  type,
  label,
  help,
  defaultValue,
  placeholder,
  maxLength,
  error,
}: {
  name: string;
  type: "email" | "text";
  label: string;
  help: string;
  defaultValue: string;
  placeholder: string;
  maxLength: number;
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
        maxLength={maxLength}
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

/** The test email's last outcome, held for legacy's four seconds and then
 *  dropped, so the button goes back to "Send test email". */
function useShownTestResult(result: ActionResult | undefined): ActionResult | undefined {
  const [dismissed, setDismissed] = useState<ActionResult | undefined>(undefined);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setDismissed(result), TEST_RESULT_MS);
    return () => clearTimeout(timer);
  }, [result]);
  return result && result !== dismissed ? result : undefined;
}

function testOutcome(result: ActionResult | undefined): string | null {
  if (!result) return null;
  if (result.ok) return TEST_SENT;
  if (result.status === "suppressed") return TEST_SUPPRESSED;
  return TEST_FAILED;
}

export default function EmailSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connectionId, senderName, replyToEmail } = loaderData;
  const result = actionData as ActionResult | undefined;
  const navigation = useNavigation();
  const pendingAction = navigation.state === "idle" ? null : String(navigation.formData?.get("_action") ?? "");
  const saveResult = result?.action === "sender" ? result : undefined;
  const featuresResult = result?.action === "features" ? result : undefined;
  const testResult = useShownTestResult(result?.action === "test-email" ? result : undefined);
  const outcome = pendingAction === "test-email" ? null : testOutcome(testResult);

  const fieldError = (field: SenderField) => (saveResult?.field === field ? saveResult.error : undefined);
  const barError =
    saveResult && !saveResult.ok && !saveResult.field ? (saveResult.error ?? SAVE_FAILED) : undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead title="Email" lead="Configure how recovery emails appear to your customers, and which ones are sent." />
      </div>

      <DemoGuardedForm method="post">
        <input type="hidden" name="_action" value="sender" />
        <input type="hidden" name="connectionId" value={connectionId ?? ""} />
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="mb-5">
              <TextField
                name="senderName"
                type="text"
                label="Sender name"
                help="Name that appears in the From field of recovery emails"
                defaultValue={senderName}
                placeholder="e.g. Alex from Acme"
                maxLength={SENDER_NAME_MAX_LENGTH}
                error={fieldError("senderName")}
              />
            </div>

            <div className="mb-6">
              <TextField
                name="replyToEmail"
                type="email"
                label="Reply-to email"
                help="Customer replies go here. Use your support inbox."
                defaultValue={replyToEmail}
                placeholder="support@yourapp.com"
                maxLength={REPLY_TO_EMAIL_MAX_LENGTH}
                error={fieldError("replyToEmail")}
              />
            </div>

            {/* Legacy's test button, last in the card, at its own width,
                saying each outcome on itself. It belongs to the test form
                below. The words are the button's own color: Recova tints them
                green or red, and a Capsomer status inside a button measured
                4.18:1 in dark, so the tint waits for the per-site layer. The
                live region repeats the outcome so it is announced. */}
            <div>
              <Button type="submit" form={TEST_FORM_ID} pending={pendingAction === "test-email"}>
                {pendingAction === "test-email" ? TEST_SENDING : (outcome ?? TEST_IDLE)}
              </Button>
              <span role="status" className="sr-only">
                {outcome ?? ""}
              </span>
            </div>
          </div>
        </section>

        {/* Legacy's SaveBar: right-aligned under the card, the result beside
            the button. The live region is on the page from the start. */}
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <span role="status">
            {saveResult?.ok ? <Status tone="ok">Saved</Status> : null}
            {barError ? <Status tone="crit">{barError}</Status> : null}
          </span>
          <Button type="submit" variant="primary" pending={pendingAction === "sender"}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>

      {/* The recovery emails card, once /settings/features. */}
      <DemoGuardedForm method="post" className="mt-10">
        <input type="hidden" name="_action" value="features" />
        <h2 className="m-0 mb-3 text-heading font-semibold text-text">Recovery emails</h2>
        <section className="cap-panel">
          <div className="cap-panel-body">
            <ToggleRow
              first
              name="winbackNotificationsEnabled"
              label="Win-back sequences"
              help="Send re-engagement emails to customers who cancel their subscription"
              defaultChecked={loaderData.winbackNotificationsEnabled}
            />
            <ToggleRow
              name="expiringCardNotificationsEnabled"
              label="Expiring card alerts"
              help="Email customers before their card expires to prevent future failures"
              defaultChecked={loaderData.expiringCardNotificationsEnabled}
            />
          </div>
        </section>
        <div className="mt-6 flex flex-wrap items-center justify-end gap-3">
          <span role="status">
            {featuresResult?.ok ? <Status tone="ok">Saved</Status> : null}
            {featuresResult && !featuresResult.ok ? <Status tone="crit">{SAVE_FAILED}</Status> : null}
          </span>
          <Button type="submit" variant="primary" pending={pendingAction === "features"}>
            Save changes
          </Button>
        </div>
      </DemoGuardedForm>

      {/* The test email's own form: nothing typed, only the intent. */}
      <DemoGuardedForm method="post" id={TEST_FORM_ID}>
        <input type="hidden" name="_action" value="test-email" />
      </DemoGuardedForm>
    </>
  );
}
