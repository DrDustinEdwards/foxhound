import { data, Form, useNavigation } from "react-router";

import { Alert, Field } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsCard, type ActionResult } from "~/components/settings-card";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  buildAccountProfileUpdate,
  buildIntelligenceContextUpdate,
} from "~/lib/settings/persist.server";
import { formatCentsAsDollars, parseDollarsToCents } from "~/lib/settings/dollars";
import { getAccount } from "~/lib/settings/queries.server";
import { cancelMerchant } from "~/lib/admin/merchants.server";
import { getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";

import type { Route } from "./+types/account";

// Legacy's hub entry 12, "My account", "Profile, appearance, sign out".
// Relocated from the /settings index when session 59 built the hub (336
// binding 2), carrying three surfaces unchanged: the account name, the
// Intelligence context fields, and the danger zone.
//
// THE INTELLIGENCE CONTEXT FIELDS BELONG HERE, and legacy's own docs say so:
// DOCS-HEADING-MAP records them as "industry, customer type, MRR, in Settings,
// Account". Legacy's hub has no separate entry for them, and its
// /settings/intelligence is "Notification preferences" (S35), a different page.
//
// THE DANGER ZONE IS HERE for the same reason: legacy puts its account
// destructive control on its account page. Foxhound CANCELS where legacy
// deletes (333 binding 2), and the label says what the control does.

export function meta() {
  return [{ title: "My account - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const account = await getAccount(getDb(env), auth.membership.accountId);
  if (!account) throw new Response("Not Found", { status: 404 });
  // The signed-in address, which legacy's AccountSection displays above its
  // sign-out control (blob a154ac8f, 3,839 bytes).
  return { account, cancelledAt: account.cancelledAt, userEmail: auth.email };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");
  const str = (name: string) => {
    const v = form.get(name);
    const trimmed = typeof v === "string" ? v.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };

  switch (intent) {
    case "profile": {
      const name = str("name");
      if (!name) {
        return data<ActionResult>(
          { action: intent, ok: false, error: "Account name is required." },
          { status: 400 },
        );
      }
      await buildAccountProfileUpdate(db, accountId, { name });
      return data<ActionResult>({ action: intent, ok: true });
    }
    case "intelligence-context": {
      await buildIntelligenceContextUpdate(db, accountId, {
        merchantIndustry: str("merchantIndustry"),
        primaryCustomerType: str("primaryCustomerType"),
        merchantMrrSelfReportedCents: parseDollarsToCents(
          String(form.get("merchantMrrSelfReported") ?? ""),
        ),
      });
      return data<ActionResult>({ action: intent, ok: true });
    }
    case "cancel-account": {
      const outcome = await cancelMerchant(env, accountId);
      // Move this session to another account the caller holds, if any. With none
      // left, the marker is cleared and the app shell lands them on the
      // signed-in empty state at /connect the way an accountless session does.
      const session = await getSession(env, request);
      if (session) {
        const remaining = (await listMemberships(db, auth.userId)).filter(
          (m) => m.accountId !== accountId,
        );
        if (remaining.length > 0) {
          await setSessionActiveAccount(db, session.session.id, remaining[0].accountId);
        }
      }
      return data<ActionResult>({
        action: intent,
        ok: true,
        warning:
          outcome.deauthorizeErrors.length > 0
            ? "Account cancelled. Revoking access at Stripe did not complete for every connection, so check your Stripe dashboard."
            : undefined,
      });
    }
    default:
      return data<ActionResult>(
        { action: intent, ok: false, error: "Unknown settings action." },
        { status: 400 },
      );
  }
}

/**
 * The Danger zone, at legacy's AccountSection.tsx geometry (blob a154ac8f): the
 * label, a red-bordered button, and a red-tinted callout carrying the
 * consequence above the confirm row.
 *
 * THE LABEL READS "Cancel account", NEVER "Delete account" (333). Legacy's
 * control deletes: its route runs delete_account_cascade over
 * recovered_payments, the table PRICING rev 3 bills on. Foxhound cancels
 * instead, and a label must say what its control does. Account DELETION is a
 * separate row and is not built here.
 */
function DangerZone({ cancelledAt, result }: { cancelledAt: Date | null; result?: ActionResult }) {
  const busy = useNavigation().state !== "idle";
  if (cancelledAt) {
    return (
      <section className="rounded-lg border border-border bg-surface p-5">
        <h2 className="text-label font-semibold text-text">Danger zone</h2>
        <p className="mt-1 text-label text-text-tertiary">
          This account is cancelled. Recovery processing is stopped. Fees already earned on
          recoveries Foxhound attributed remain owed.
        </p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">Danger zone</h2>
      {result?.action === "cancel-account" && result.warning ? (
        <Alert tone="error">{result.warning}</Alert>
      ) : null}
      <DemoGuardedForm method="post" className="mt-4 flex flex-col gap-3">
        <input type="hidden" name="_action" value="cancel-account" />
        <div className="rounded-lg border border-red-dark bg-red-bg px-4 py-3.5">
          <div className="mb-1 text-label text-text">Are you sure?</div>
          <div className="text-micro text-text-subtle">
            This stops all recovery processing and disconnects every Stripe account here. Fees on
            recoveries Foxhound has already attributed remain owed and are still invoiced.
          </div>
        </div>
        <div className="flex gap-2.5">
          <button
            type="submit"
            disabled={busy}
            className="rounded-md border border-border bg-transparent px-4 py-2 text-label text-red transition-colors duration-150 hover:border-red disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? "Cancelling..." : "Cancel account"}
          </button>
        </div>
      </DemoGuardedForm>
    </section>
  );
}

export default function AccountSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { account, cancelledAt, userEmail } = loaderData;
  const result = actionData as ActionResult | undefined;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h2 text-text">My account</h1>
        <p className="mt-1 text-label text-text-tertiary">
          Profile, appearance, and account lifecycle.
        </p>
      </header>

      {/* Legacy's AccountSection opens with the signed-in address and a sign-out
          control beside it (blob a154ac8f). Both were absent from Foxhound's
          account surface until session 60; the address is a display, and the
          sign-out is a POST to the existing /logout resource route rather than
          legacy's GET link, because signing out is a state change. */}
      <section className="flex flex-col items-start gap-3 rounded-lg border border-border bg-surface p-5 md:flex-row md:items-center md:justify-between">
        <div className="text-label text-text">{userEmail}</div>
        <Form method="post" action="/logout">
          <button
            type="submit"
            className="whitespace-nowrap rounded-md border border-border bg-transparent px-4 py-2 text-label text-text-tertiary transition-colors duration-150 hover:border-text-tertiary"
          >
            Sign out
          </button>
        </Form>
      </section>

      <SettingsCard title="Account" action="profile" result={result}>
        <Field label="Account name" name="name" required defaultValue={account.name ?? ""} />
      </SettingsCard>

      <SettingsCard
        title="Intelligence context"
        description="Optional. Foxhound gives these to the AI that writes your recovery emails, so the copy knows what kind of business it is writing for. They will also feed risk scoring once Intelligence scoring is available."
        action="intelligence-context"
        result={result}
      >
        <Field
          label="Industry"
          name="merchantIndustry"
          required={false}
          defaultValue={account.merchantIndustry ?? ""}
        />
        <Field
          label="Primary customer type"
          name="primaryCustomerType"
          required={false}
          defaultValue={account.primaryCustomerType ?? ""}
        />
        <Field
          label="Self-reported monthly recurring revenue (USD)"
          name="merchantMrrSelfReported"
          required={false}
          defaultValue={formatCentsAsDollars(account.merchantMrrSelfReported)}
        />
      </SettingsCard>

      <DangerZone cancelledAt={cancelledAt} result={result} />
    </div>
  );
}
