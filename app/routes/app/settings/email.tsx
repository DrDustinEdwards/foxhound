import { data, useNavigation } from "react-router";

import { Alert } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { buildSenderSettingsUpdate } from "~/lib/settings/persist.server";
import { SENDER_NAME_MAX_LENGTH } from "~/lib/settings/sender-name";
import { getPrimarySenderConnection } from "~/lib/settings/queries.server";
import { sendTestEmail } from "~/lib/settings/test-email.server";

import type { Route } from "./+types/email";

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
// 1. TWO OF LEGACY'S THREE FIELDS ARE NOT RENDERED, and this is the sharp one.
//    `sender_domain` and `reply_to_email` have NO READER in Foxhound: the send
//    path emits from/to/subject/html plus two List-Unsubscribe headers and
//    nothing else, and `sender_domain`'s legacy job ("Used in billing portal
//    links", its own help string) is a different subsystem. A field that writes
//    a column nothing reads is a false promise, so both are PORTABLE AFTER
//    their readers rather than ported now. Recorded in
//    parity/SETTINGS-SPEC-FROM-DOCS.md, not silently dropped.
// 2. `sender_name` IS OPTIONAL, matching legacy, and BOUNDED AT 80, which
//    legacy is not. The requirement shipped for one session and 335 reverted it:
//    legacy writes `|| null` on an empty box and its empty case delivers through
//    the `|| 'Support'` fallback Foxhound matches, so requiring it was an
//    unratified user-visible divergence. The BOUND stays, flagged for Dustin as
//    input hygiene on a header field, and is still an addition rather than a
//    port.
// 3. THE WRITE PATH is this route's own action rather than legacy's shared
//    `/settings/update` (row S38, unbuilt). Class (a), exactly S30's divergence
//    1, and it avoids building S38 as a side effect.
// 4. NO SETTINGS SIDEBAR. Legacy lists this page in one; Foxhound has none, so
//    it rides PLATFORM_LINKS beside Team and Audit settings, for the same
//    reason and leaving when S25 ships.
//
// UNRESOLVED: legacy's inputs carry a global `settings-input` class defined
// outside the render chain, so its box treatment (height, padding, radius) was
// not read. `border-i` and `--amber` ARE Foxhound tokens; the inputs below use
// this codebase's own settings-field treatment.

export function meta() {
  return [{ title: "Email settings - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const connection = await getPrimarySenderConnection(db, auth.membership.accountId);
  return {
    connectionId: connection?.id ?? null,
    senderName: connection?.senderName ?? "",
    recipientEmail: auth.email,
  };
}

interface ActionResult {
  action: string;
  ok: boolean;
  error?: string;
  status?: string;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (intent === "sender") {
    const connectionId = String(form.get("connectionId") ?? "").trim();
    if (!connectionId) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Connect Stripe before setting a sender name." },
        { status: 400 },
      );
    }
    // OPTIONAL, per ruling 335. It was required for one session and that was an
    // unratified divergence: legacy writes `|| null` on an empty box, and its
    // empty case delivers through the `|| 'Support'` fallback Foxhound matches.
    // A user-visible divergence stands only on Dustin's ratification.
    const raw = String(form.get("senderName") ?? "").trim();
    const senderName = raw.length > 0 ? raw : null;
    if (senderName && senderName.length > SENDER_NAME_MAX_LENGTH) {
      return data<ActionResult>(
        {
          action: intent,
          ok: false,
          error: `Sender name must be ${SENDER_NAME_MAX_LENGTH} characters or fewer.`,
        },
        { status: 400 },
      );
    }
    // ONE column. A form posting brandVoice or billingExempt beside it writes
    // neither, because the builder names sender_name and nothing else.
    await buildSenderSettingsUpdate(db, accountId, connectionId, { senderName });
    return data<ActionResult>({ action: intent, ok: true });
  }

  if (intent === "test-email") {
    // The address is the SESSION user's, never the form's, so this cannot be
    // pointed at a third party.
    const { result } = await sendTestEmail(env, accountId, auth.email);
    if (result.status === "sent") {
      return data<ActionResult>({ action: intent, ok: true, status: result.status });
    }
    return data<ActionResult>({
      action: intent,
      ok: false,
      status: result.status,
      error:
        result.status === "suppressed"
          ? "That address has unsubscribed, so no email was sent."
          : "Could not send the test email. Try again or contact support.",
    });
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}

export default function EmailSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connectionId, senderName, recipientEmail } = loaderData;
  const result = actionData as ActionResult | undefined;
  const busy = useNavigation().state !== "idle";
  const saveResult = result?.action === "sender" ? result : undefined;
  const testResult = result?.action === "test-email" ? result : undefined;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-8">
      <header>
        <h1 className="text-h2 text-text">Email</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Configure how recovery emails appear to your customers.
        </p>
      </header>

      <section className="rounded-lg border border-border bg-surface p-5">
        {saveResult?.ok ? <Alert tone="success">Saved.</Alert> : null}
        {saveResult && !saveResult.ok && saveResult.error ? (
          <Alert tone="error">{saveResult.error}</Alert>
        ) : null}

        <DemoGuardedForm method="post" className="flex flex-col gap-4">
          <input type="hidden" name="_action" value="sender" />
          <input type="hidden" name="connectionId" value={connectionId ?? ""} />
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              Sender name
            </span>
            <input
              name="senderName"
              type="text"
              defaultValue={senderName}
              placeholder="e.g. Alex from Acme"
              maxLength={SENDER_NAME_MAX_LENGTH}
              className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
            />
            <span className="text-micro text-text-subtle">
              Name that appears in the From field of recovery emails
            </span>
          </label>
          <div>
            <button
              type="submit"
              disabled={busy}
              className="rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber transition-opacity duration-500 hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? "Saving..." : "Save"}
            </button>
          </div>
        </DemoGuardedForm>
      </section>

      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-label font-semibold text-text">Test email</h2>
        <p className="mt-1 text-label text-text-tertiary">
          Sends a sample recovery email to {recipientEmail} through the real sending path, so
          the From line is the one your customers will see.
        </p>
        {testResult?.ok ? <Alert tone="success">Sent. Check your inbox.</Alert> : null}
        {testResult && !testResult.ok && testResult.error ? (
          <Alert tone="error">{testResult.error}</Alert>
        ) : null}
        <DemoGuardedForm method="post" className="mt-4">
          <input type="hidden" name="_action" value="test-email" />
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-border bg-transparent px-4 py-2 text-label text-text-subtle transition-colors duration-150 hover:border-text-tertiary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Sending..." : "Send test email"}
          </button>
        </DemoGuardedForm>
      </section>
    </div>
  );
}
