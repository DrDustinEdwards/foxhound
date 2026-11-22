import { SaveBar } from "capsomer/react/save-bar";
import { useShownFor } from "capsomer/react/hooks";
import { TextField } from "capsomer/react/field";
import { data, useNavigation } from "react-router";
import { Button } from "capsomer/react/button";

import { DemoForm } from "~/lib/demo/use-demo-guard";
import { SettingsLayout, SwitchRow } from "capsomer/react/settings-row";
import { routerRenderLink } from "capsomer/react/link";
import { accounts, getDb } from "~/db";
import { eq } from "drizzle-orm";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "@dustinedwards/site-runtime/context";
import { REPLY_TO_EMAIL_MAX_LENGTH } from "~/lib/settings/reply-to";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";
import { applyFeatureSettings, applySenderName } from "~/lib/settings/apply.server";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";
import { sendTestEmail } from "~/lib/settings/test-email.server";

import type { Route } from "./+types/email";
import { NOINDEX } from "~/lib/seo/meta";
import { readForm } from "@dustinedwards/site-runtime/body";
import { BODY_MAX_BYTES } from "~/lib/http/body";

// /settings/email: the phone-only back link, the title and its line, one card holding Sender name, Reply-to email and the Send test email button, and under the card, right-aligned, Saved or the failure sentence beside Save changes. Each field is Capsomer's TextField, its help under the input. This page is the writer of `sender_name`; without it every recovery email's From display name fell back to "your subscription".
// `sender_domain` has no reader and is deliberately not built. `reply_to_email` has its reader: send.ts sets Reply-To on merchant-customer email only when a valid address is saved, and none otherwise, so a reply goes to the From. It has a server-side format check and a 254-character bound (app/lib/settings/reply-to.ts).
// `sender_name` is OPTIONAL and BOUNDED AT 80: an empty box writes null and delivers through the `|| 'Support'` fallback.
// The route's own action writes (no shared /settings/update handler).
// THE TEST EMAIL'S OUTCOMES: "Sent! Check your inbox" or "Failed. Try again.", going back to "Send test email" after four seconds. Foxhound's send path also refuses a suppressed address, where "Try again" would not help, so that outcome says why nothing was sent.
// THE TEST BUTTON SITS IN THE CARD BUT POSTS ITS OWN FORM, through the HTML `form` attribute: a submit button owned by the save form would be the one an Enter key in the sender name presses, and would send mail. Owned by its own ReadOnlyForm it keeps the demo refusal and works without script.

// THE RECOVERY EMAILS CARD: win-back sequences and expiring card alerts, the switches that turn emails to customers on or off. It keeps its own form and save bar, and the NULL-is-ON pair: a merchant who never touched it has both on.

export function meta() {
  return [{ title: "Email settings - Foxhound" }, NOINDEX];
}

const NULL_IS_ON = true;

/** The failure sentence, said when the write itself threw. */
const SAVE_FAILED = "Failed to save. Please try again.";

const TEST_IDLE = "Send test email";
const TEST_SENDING = "Sending...";
const TEST_SENT = "Sent! Check your inbox";
const TEST_FAILED = "Failed. Try again.";
/** The suppressed outcome. The send path suppresses an address on an unsubscribe (suppression.ts) or a bounce or complaint event (events.ts), and on nothing else. */
const TEST_SUPPRESSED =
  "Not sent. Your address is blocked after an unsubscribe, bounce or complaint.";
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
  failed?: boolean;
  /** The test email's named outcome (EmailSendStatus). */
  status?: string;
}

/** Which field a refusal from applySenderName belongs to. Its sentences name the field they are about; "Connect Stripe..." names none. */
function fieldOf(error: string): SenderField | undefined {
  if (/^Sender name\b/.test(error)) return "senderName";
  if (/reply-to/i.test(error)) return "replyToEmail";
  return undefined;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const form = await readForm(request, BODY_MAX_BYTES);
  const intent = String(form.get("_action") ?? "");

  if (intent === "sender") {
    // THE SENDER BRANCH'S CORE is in apply.server.ts, shared with the MCP `set_sender_name` tool, so an agent is refused with this form's own sentences. The name stays OPTIONAL: an empty box writes null and delivers through the `|| 'Support'` fallback.
    let result: Awaited<ReturnType<typeof applySenderName>>;
    try {
      result = await applySenderName(getDb(env), accountId, {
        connectionId: form.get("connectionId"),
        senderName: form.get("senderName"),
        // Sent only when the form carries the field (`formData.has('reply_to_email')`).
        replyToEmail: form.has("replyToEmail") ? form.get("replyToEmail") : undefined,
      });
    } catch (err) {
      // A failed update answers with the SaveBar sentence, not an error page. The whole error is logged, stack included, so a D1 failure can be traced; it carries no form values.
      console.error("email settings write failed:", err);
      return data<ActionResult>({ action: intent, ok: false, failed: true }, { status: 500 });
    }
    if (!result.ok) {
      const field = fieldOf(result.error);
      return data<ActionResult>(
        field
          ? { action: intent, ok: false, error: result.error, field }
          : { action: intent, ok: false, error: result.error },
        { status: 400 },
      );
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  if (intent === "features") {
    // TWO columns, through the shared apply layer so this form and the MCP `set_feature_settings` tool cannot disagree. A checkbox posts its name only when checked, so an absent key is OFF.
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
    // The address is the SESSION user's, never the form's, so this cannot be pointed at a third party. It sends with the account's live sending off, because its audience is "preview".
    try {
      const { result } = await sendTestEmail(env, accountId, auth.email);
      return data<ActionResult>({
        action: intent,
        ok: result.status === "sent",
        status: result.status,
      });
    } catch (err) {
      // sendTestEmail returns a named outcome for every refused send; what throws is the read before it.
      console.error("test email failed:", err);
      return data<ActionResult>({ action: intent, ok: false, status: "failed" }, { status: 500 });
    }
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
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
  const pendingAction =
    navigation.state === "idle" ? null : String(navigation.formData?.get("_action") ?? "");
  const saveResult = result?.action === "sender" ? result : undefined;
  const featuresResult = result?.action === "features" ? result : undefined;
  // The test email's last outcome, held four seconds and then dropped, so the button goes back to "Send test email".
  const [testResult] = useShownFor(
    result?.action === "test-email" ? result : undefined,
    TEST_RESULT_MS,
  );
  const outcome = pendingAction === "test-email" ? null : testOutcome(testResult);

  const fieldError = (field: SenderField) =>
    saveResult?.field === field ? saveResult.error : undefined;
  const barError =
    saveResult && !saveResult.ok && !saveResult.field
      ? (saveResult.error ?? SAVE_FAILED)
      : undefined;

  return (
    <SettingsLayout renderLink={routerRenderLink} title="Email">
      <DemoForm method="post">
        <input type="hidden" name="_action" value="sender" />
        <input type="hidden" name="connectionId" value={connectionId ?? ""} />
        <section className="cap-panel">
          <div className="cap-panel-body">
            <div className="fh-email-block">
              <TextField
                announce
                name="senderName"
                type="text"
                label="Sender name"
                defaultValue={senderName}
                placeholder="e.g. Alex from Acme"
                maxLength={SENDER_NAME_MAX_LENGTH}
                error={fieldError("senderName")}
              />
            </div>

            <div className="fh-email-group">
              {/* Recova puts help under the control. */}
              <TextField
                announce
                name="replyToEmail"
                type="email"
                label="Reply-to email"
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
              <span role="status" className="cap-sr-only">
                {outcome ?? ""}
              </span>
            </div>
          </div>
        </section>

        {/* Legacy's SaveBar: right-aligned under the card, the result beside
            the button. The live region is on the page from the start. */}
        <SaveBar
          pending={pendingAction === "sender"}
          saved={saveResult?.ok === true}
          error={barError}
        />
      </DemoForm>

      {/* The recovery emails card, once /settings/features. */}
      <DemoForm method="post" className="fh-email-sequence">
        <input type="hidden" name="_action" value="features" />
        <h2 className="fh-email-sequence-title fh-semibold fh-text">Recovery emails</h2>
        <section className="cap-panel">
          <div className="cap-panel-body">
            <SwitchRow
              name="winbackNotificationsEnabled"
              label="Win-back sequences"
              defaultChecked={loaderData.winbackNotificationsEnabled}
            />
            <SwitchRow
              name="expiringCardNotificationsEnabled"
              label="Expiring card alerts"
              defaultChecked={loaderData.expiringCardNotificationsEnabled}
            />
          </div>
        </section>
        <SaveBar
          pending={pendingAction === "features"}
          saved={featuresResult?.ok === true}
          error={featuresResult && !featuresResult.ok ? SAVE_FAILED : null}
        />
      </DemoForm>

      {/* The test email's own form: nothing typed, only the intent. */}
      <DemoForm method="post" id={TEST_FORM_ID}>
        <input type="hidden" name="_action" value="test-email" />
      </DemoForm>
    </SettingsLayout>
  );
}
