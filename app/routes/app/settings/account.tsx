import { useEffect, useRef, useState } from "react";
import { data, Form, redirect, useNavigation } from "react-router";
import { Alert as CapAlert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import "capsomer/banner.css";
import "capsomer/button.css";

import { Alert, Field } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsCard, type ActionResult } from "~/components/settings-card";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { applyIntelligenceContext } from "~/lib/settings/apply.server";
import { buildAccountProfileUpdate } from "~/lib/settings/persist.server";
import { formatCentsAsDollars } from "~/lib/settings/dollars";
import { getAccount } from "~/lib/settings/queries.server";
import { cancelMerchant } from "~/lib/admin/merchants.server";
import { getAuth, getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";
import { deleteUserAccount } from "~/lib/auth/delete-account.server";

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
// destructive control on its account page. It carries two controls: Cancel
// account (333 binding 2, built under S37) and, since S40, legacy's own Delete
// account, which deletes the person and their personal data and keeps the fee
// evidence (Q14, Q16; app/lib/auth/delete-account.server.ts).
//
// J32 rebuilds this page on Capsomer (job_54cb0e7420dc) and has not merged, so
// S40 adds its control to the page as it stands, built from Capsomer's Button
// and Alert, and leaves the rest of the page to J32.

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
      // THE ONLY BRANCH OF THIS ACTION THAT MOVED. The profile above and the
      // danger zone below are untouched and reach no tool: cancelling an
      // account is on the HUMAN-FOREVER denylist, and the registry refuses the
      // name outright.
      //
      // Every key is posted on every submit, so the form still writes all three
      // columns. It passes the raw strings, because trimming and parsing are
      // the apply layer's job now and doing either here would be the second
      // implementation the layer exists to prevent.
      const result = await applyIntelligenceContext(db, accountId, {
        merchantIndustry: String(form.get("merchantIndustry") ?? ""),
        primaryCustomerType: String(form.get("primaryCustomerType") ?? ""),
        merchantMrrSelfReported: String(form.get("merchantMrrSelfReported") ?? ""),
      });
      if (!result.ok) {
        return data<ActionResult>(
          { action: intent, ok: false, error: result.error },
          { status: 400 },
        );
      }
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
    case "delete-account": {
      // The SIGNED-IN user, never an id from the form: a person deletes
      // themselves and nobody else (RULES.md 4.6). Recova's route does the same
      // with supabase.auth.getUser().
      try {
        await deleteUserAccount(env, auth.userId);
      } catch (err) {
        console.error("account deletion failed:", err);
        // Recova's own words for this failure (AccountSection.tsx, blob a154ac8f).
        return data<ActionResult>(
          { action: intent, ok: false, error: "Failed to delete account. Please contact support." },
          { status: 500 },
        );
      }
      // The user and their sessions are gone; this clears the cookie the
      // browser still holds, and Recova then sends the person to "/".
      const signedOut = await getAuth(env).api.signOut({ headers: request.headers, asResponse: true });
      const headers = new Headers();
      for (const cookie of signedOut.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return redirect("/", { headers });
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
 * TWO CONTROLS. "Cancel account" (333) stops processing and keeps the account;
 * its label says what it does. "Delete account" is legacy's control (S40),
 * below it, and deletes the person.
 */
function DangerZone({ cancelledAt, result }: { cancelledAt: Date | null; result?: ActionResult }) {
  const busy = useNavigation().state !== "idle";
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">Danger zone</h2>
      {cancelledAt ? (
        <p className="mt-1 text-label text-text-tertiary">
          This account is cancelled. Recovery processing is stopped. Fees already earned on
          recoveries Foxhound attributed remain owed.
        </p>
      ) : (
        <>
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
        </>
      )}
      <DeleteAccount result={result} />
    </section>
  );
}

const DELETE_BUTTON_ID = "delete-account-open";
const KEEP_BUTTON_ID = "delete-account-keep";

/**
 * Legacy's Delete account control (AccountSection.tsx, blob a154ac8f), the same
 * three states in the same order: the button at the right; on press, the
 * "Are you sure?" callout with "Yes, delete my account" and "Keep my account";
 * while it runs, "Deleting..." with Keep withdrawn. Built from Capsomer's
 * Button (danger for the destructive pair) and Alert (the critical callout),
 * per Q10, with no Foxhound CSS over either.
 *
 * Two departures, both recorded in the PR. The confirm text is rewritten
 * because Recova's, which says the payment data is deleted too, would be
 * false here: Foxhound keeps the record of recovered payments (Q14),
 * a truthfulness fix (RULES.md 1.2). And focus moves to "Keep my account" when
 * the confirmation opens, and back to "Delete account" when it closes, where
 * Recova drops focus on a removed button; that is accessibility, not a change
 * of behaviour (RULES.md 1.5), and starting on the safe choice is Capsomer's
 * confirm rule.
 */
function DeleteAccount({ result }: { result?: ActionResult }) {
  const navigation = useNavigation();
  const deleting = navigation.state !== "idle" && navigation.formData?.get("_action") === "delete-account";
  const [confirming, setConfirming] = useState(false);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) return;
    document.getElementById(confirming ? KEEP_BUTTON_ID : DELETE_BUTTON_ID)?.focus();
  }, [confirming]);

  const open = (next: boolean) => {
    moved.current = true;
    setConfirming(next);
  };
  const failed = result?.action === "delete-account" && !result.ok ? result.error : undefined;

  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-border pt-5">
      {failed ? <CapAlert tone="crit">{failed}</CapAlert> : null}
      {confirming ? (
        <DemoGuardedForm method="post" className="flex flex-col gap-3">
          <input type="hidden" name="_action" value="delete-account" />
          <CapAlert tone="crit" title="Are you sure?">
            This will permanently delete your account and your personal data, remove your
            customers&apos; names and emails, and cancel all active recovery sequences. Foxhound
            keeps the amounts, dates and Stripe ids of the payments it recovered, because its fees
            are billed on them. This cannot be undone.
          </CapAlert>
          <div className="flex gap-2.5">
            <Button type="submit" variant="danger" pending={deleting}>
              {deleting ? "Deleting..." : "Yes, delete my account"}
            </Button>
            {deleting ? null : (
              <Button id={KEEP_BUTTON_ID} onClick={() => open(false)}>
                Keep my account
              </Button>
            )}
          </div>
        </DemoGuardedForm>
      ) : (
        <div className="flex items-center justify-end">
          <Button id={DELETE_BUTTON_ID} variant="danger" onClick={() => open(true)}>
            Delete account
          </Button>
        </div>
      )}
    </div>
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
