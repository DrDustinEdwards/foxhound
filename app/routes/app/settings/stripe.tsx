import { useEffect, useId, useState } from "react";
import { data, redirect, useNavigation } from "react-router";
import { Alert } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { PageHead } from "capsomer/react/page-head";
import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/page-head.css";
import "capsomer/panel.css";
// Capsomer's tokens and the amber family, which the components above read. The
// shell loads the same file through its header; importing it here keeps the
// page whole under any layout, as /settings/account does.
import "~/site-header.css";

import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { SettingsBackLink } from "~/components/settings-back-link";
import { getDb } from "~/db";
import { MEMBER_ROLE } from "~/lib/auth";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { listAccountConnections, listConnectionHealth } from "~/lib/settings/queries.server";
import { currentHealthProblems, healthProblemLines, STRIPE_DASHBOARD_URL } from "~/lib/stripe/account-health";
import { disconnectConnection, findLiveConnection } from "~/lib/admin/merchant-cancel.server";
import { deauthorizeConnectedAccount } from "~/lib/stripe/connect";
import { disconnectFeedback, type DisconnectResult } from "~/lib/settings/stripe-disconnect-feedback";

import type { Route } from "./+types/stripe";

// S37, /settings/stripe, legacy's hub entry 1, "Stripe connections".
//
// LEGACY IS THE SPEC, read whole at HEAD:
//   app/(app)/settings/stripe/page.tsx              blob 338541e6   738 bytes
//   app/(app)/settings/components/StripeSection.tsx blob 4068961e 4,410 bytes
//   app/api/stripe/disconnect/route.ts              blob 01252285 2,656 bytes
//
// RECOVA'S ORDER, top to bottom: the phone-only back link; "Stripe connections"
// and its line; ONE card holding either the empty state (the line and Connect
// Stripe) or a bordered row per connection (its name or Stripe id, the date
// line, Disconnect Stripe with its two-step confirm and Keep connected) and
// Add Stripe account under them.
//
// J41 rebuilt it from Capsomer 0.9.0's parts under Dustin's Q10 and Q11 answers
// of 2026-10-14: PageHead, panels, Button and Alert, amber throughout.
//
// THE ENGINE IS FOXHOUND'S. Recova's client POSTs /api/stripe/disconnect with
// no id at a route exporting only DELETE, which picks the account's primary
// itself, so its per-connection buttons are decorative. That request is
// not ported: each row's form names its connection, the action refuses one the
// ACTIVE account does not hold, and the write is cancelMerchant's plain batch
// path (disconnectConnection), never an agent tool (3.6).

export function meta() {
  return [{ title: "Stripe connections - Foxhound" }];
}

// OWNERS ONLY disconnect: it revokes Foxhound's Stripe access for the whole
// account, as only an owner revokes an API key (/settings/api-keys).
const OWNER_ONLY = "Only the account owner can do this.";

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const [connections, health] = await Promise.all([
    listAccountConnections(db, auth.membership.accountId),
    listConnectionHealth(db, auth.membership.accountId),
  ]);
  // The Stripe account health warning: the sentences the notice email sends,
  // for every problem the stored account.updated state shows now. Empty when
  // Stripe reported none, or has not reported at all; a deadline with no
  // problem is not one.
  const warnings = new Map(
    health.map((h) => {
      const problems = currentHealthProblems(h);
      return [h.id, problems.length > 0 ? healthProblemLines(problems, h) : []] as const;
    }),
  );
  return {
    // Live connections drive the list; a disconnected one is history, and no
    // longer counts as the primary (APPROVED-DIFFERENCES, "yes", 2026-09-19).
    // Recova has one empty state, so nothing needs to know whether the
    // account was ever connected.
    connections: connections
      .filter((c) => !c.disconnectedAt)
      .map((c) => ({ ...c, healthWarning: warnings.get(c.id) ?? [] })),
    isOwner: auth.membership.role === MEMBER_ROLE.OWNER,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  if (auth.membership.role !== MEMBER_ROLE.OWNER) {
    return data<DisconnectResult>({ action: intent, ok: false, error: OWNER_ONLY }, { status: 403 });
  }

  if (intent !== "disconnect-stripe") {
    return data<DisconnectResult>({ action: intent, ok: false, error: "Unknown settings action." }, { status: 400 });
  }

  // The id is required and real: Recova's id-less request is the defect.
  const connectionId = String(form.get("connectionId") ?? "").trim();
  if (!connectionId) {
    return data<DisconnectResult>({ action: intent, ok: false, error: "Connection is required." }, { status: 400 });
  }

  let warning: string | undefined;
  try {
    // Scoped to the ACTIVE account from the session marker (auth.membership),
    // never the earliest membership. A connection under another account the
    // caller holds is refused exactly like one they do not hold at all.
    const db = getDb(env);
    const live = await findLiveConnection(db, accountId, connectionId);
    if (!live) {
      return data<DisconnectResult>(
        {
          action: intent,
          ok: false,
          error: "That connection is not on this account.",
        },
        { status: 403 },
      );
    }
    // The revoke runs AFTER the batch has committed. The default revoke can
    // THROW (it builds its Stripe client outside its own try), and a throw
    // there must not read as "could not disconnect": the connection IS
    // disconnected. So the revoke handed in turns a throw into the failed
    // revoke it is. Same writer, same batch, same order; only the reporting.
    const result = await disconnectConnection(env, live, {
      deauthorize: async (e, stripeUserId) => {
        try {
          return await deauthorizeConnectedAccount(e, stripeUserId);
        } catch (err) {
          console.error("stripe deauthorize threw after the disconnect committed:", err);
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
    if (result.deauthorizeError) {
      warning = "Disconnected. Revoking access at Stripe did not complete, so check your Stripe dashboard.";
    }
  } catch (err) {
    // The whole error, stack included; it carries no form values beyond the id.
    console.error("stripe disconnect failed:", err);
    return data<DisconnectResult>(
      { action: intent, ok: false, error: "Could not disconnect Stripe." },
      { status: 500 },
    );
  }

  if (warning) return data<DisconnectResult>({ action: intent, ok: true, warning });
  // Recova's success: `window.location.href = '/settings'`.
  return redirect("/settings");
}

/** Legacy's date line on a connection row: "Connected Aug 21, 2026", from
 *  toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
 *  (StripeSection.tsx, blob 4068961e). Omitted entirely when the timestamp is
 *  null, as legacy omits it. */
function connectedLabel(at: Date | null): string | null {
  if (!at) return null;
  return (
    "Connected " +
    new Date(at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  );
}

type Connection = {
  id: string;
  name: string | null;
  stripeUserId: string;
  connectedAt: Date | null;
  /** The Stripe account health sentences, empty when there is nothing to say. */
  healthWarning?: string[];
};

/**
 * Recova's StripeSection (blob 4068961e) on Capsomer's parts.
 *
 * THE CONFIRM IS RECOVA'S: one button per row. The first press only asks (it
 * turns into "Yes, disconnect Stripe" and Keep connected appears beside it);
 * the second press submits that row's form, which names its connection. The
 * button stays the same element throughout, so keyboard focus stays on it.
 * Keep connected withdraws the question and hands focus back to the button.
 * While the disconnect runs, the button says so and Keep is withdrawn.
 */
function StripeSection({
  connections,
  result,
  isOwner,
}: {
  connections: Connection[];
  result?: DisconnectResult;
  isOwner: boolean;
}) {
  const navigation = useNavigation();
  const runningId =
    navigation.state !== "idle" && navigation.formData?.get("_action") === "disconnect-stripe"
      ? String(navigation.formData.get("connectionId") ?? "")
      : null;
  // The question belongs to the result it was asked under. A new result (a
  // failed or refused disconnect) withdraws it, as Recova resets its confirm
  // after the alert, without setting state from an effect.
  const [asked, setAsked] = useState<{ id: string; under: DisconnectResult | undefined } | null>(null);
  const confirmingId = asked && asked.under === result ? asked.id : null;
  const ids = useId();
  const buttonId = (id: string) => `${ids}-disconnect-${id}`;
  const feedback = disconnectFeedback(result);

  // Recova's failure: one browser alert with its line. `result` is a new
  // object per submission, so a repeated failure alerts again.
  const alertMessage = feedback?.kind === "alert" ? feedback.message : null;
  useEffect(() => {
    if (alertMessage) window.alert(alertMessage);
  }, [result, alertMessage]);

  const keep = (id: string) => {
    setAsked(null);
    requestAnimationFrame(() => document.getElementById(buttonId(id))?.focus());
  };

  return (
    <section className="cap-panel">
      <div className="cap-panel-body">
        {feedback?.kind === "warning" ? (
          <div className="mb-3">
            <Alert tone="warn">{feedback.message}</Alert>
          </div>
        ) : null}

        {connections.length === 0 ? (
          <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
            <p className="text-label text-text">No Stripe account connected</p>
            <a href="/connect" className="cap-btn" data-variant="primary">
              Connect Stripe
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {connections.map((conn) => {
              const isConfirming = confirmingId === conn.id;
              const isDisconnecting = runningId === conn.id;
              const label = conn.name || conn.stripeUserId;
              const connected = connectedLabel(conn.connectedAt);
              return (
                <div key={conn.id} className="cap-panel" data-size="sm">
                  <div className="cap-panel-body">
                    <div className="flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <div className="mb-0.5 text-label text-text">{label}</div>
                        {connected ? <div className="text-micro text-text-subtle">{connected}</div> : null}
                      </div>
                      {isOwner ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <DemoGuardedForm method="post">
                          <input type="hidden" name="_action" value="disconnect-stripe" />
                          <input type="hidden" name="connectionId" value={conn.id} />
                          <Button
                            id={buttonId(conn.id)}
                            variant={isConfirming ? "danger" : "default"}
                            pending={isDisconnecting}
                            onClick={(e) =>
                              // ALWAYS type="button". React re-renders inside the
                              // click, before the browser's default action, so a
                              // type that flipped to "submit" would post on the
                              // very press that opens the confirm. The handler
                              // bound to this press decides, and only a press
                              // made while confirming submits this row's form.
                              isConfirming
                                ? e.currentTarget.form?.requestSubmit()
                                : setAsked({ id: conn.id, under: result })
                            }
                          >
                            {isDisconnecting
                              ? "Disconnecting..."
                              : isConfirming
                                ? "Yes, disconnect Stripe"
                                : "Disconnect Stripe"}
                          </Button>
                        </DemoGuardedForm>
                        {isConfirming && !isDisconnecting ? (
                          <Button onClick={() => keep(conn.id)}>Keep connected</Button>
                        ) : null}
                      </div>
                      ) : null}
                    </div>
                    {conn.healthWarning?.length ? (
                      <div className="mt-3">
                        <Alert
                          tone="warn"
                          title="Your Stripe account needs attention."
                          action={
                            <a href={STRIPE_DASHBOARD_URL} className="cap-btn" target="_blank" rel="noreferrer">
                              Open Stripe dashboard
                            </a>
                          }
                        >
                          {conn.healthWarning.join(" ")}
                        </Alert>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div className="pt-2">
              <a href="/connect/additional" className="cap-btn">
                Add Stripe account
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default function StripeSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connections, isOwner } = loaderData;
  const result = actionData as DisconnectResult | undefined;

  return (
    <>
      <SettingsBackLink />
      {/* Legacy's PageHeader leaves 32px under the head (mb-8); the wrapper
          keeps that space without styling Capsomer's head. */}
      <div className="mb-8">
        <PageHead
          title="Stripe connections"
          lead="Connected Stripe accounts. Add additional accounts or disconnect existing ones."
        />
      </div>
      <StripeSection connections={connections} result={result} isOwner={isOwner} />
    </>
  );
}
