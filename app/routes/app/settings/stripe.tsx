import { data, useNavigation, useSearchParams } from "react-router";

import { Alert } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import type { ActionResult } from "~/components/settings-card";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { listAccountConnections } from "~/lib/settings/queries.server";
import { disconnectConnection, findLiveConnection } from "~/lib/admin/merchants.server";

import type { Route } from "./+types/stripe";

// S37's Stripe connections, relocated from the /settings index to legacy's own
// path (hub entry 1, "Stripe connections", "Connected accounts") when session 59
// built the hub. THE BEHAVIOUR IS UNCHANGED: the same loader query, the same
// action intent, the same two-step confirm, the same 403 off the active account.

export function meta() {
  return [{ title: "Stripe connections - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const db = getDb(env);
  const connections = await listAccountConnections(db, auth.membership.accountId);
  return {
    // S37. Live connections drive the list; the count of disconnected ones tells
    // the two empty states apart (never connected, versus disconnected).
    connections: connections.filter((c) => !c.disconnectedAt),
    everConnected: connections.length > 0,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);
  const form = await request.formData();
  const intent = String(form.get("_action") ?? "");

  // METHOD AGREEMENT IS STRUCTURAL HERE, and it is the defect legacy shipped:
  // its client sent `fetch(..., { method: 'POST' })` at a route exporting only
  // DELETE, so the button could never succeed (325). This is a React Router
  // form post to this route's own action, so the client method and the route
  // method are the same POST by construction.
  if (intent === "disconnect-stripe") {
    // Legacy sends NO connection id and its route resolves `is_primary`
    // itself, so its per-connection UI is decorative: clicking the second row
    // disconnects the first. The id is required and real here.
    const connectionId = String(form.get("connectionId") ?? "").trim();
    if (!connectionId) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "Connection is required." },
        { status: 400 },
      );
    }
    // Scoped to the ACTIVE account from the session marker (auth.membership),
    // never the earliest membership. A connection under another account the
    // caller holds is refused exactly like one they do not hold at all.
    const live = await findLiveConnection(db, accountId, connectionId);
    if (!live) {
      return data<ActionResult>(
        { action: intent, ok: false, error: "That connection is not on this account." },
        { status: 403 },
      );
    }
    const result = await disconnectConnection(env, live);
    if (result.deauthorizeError) {
      return data<ActionResult>({
        action: intent,
        ok: true,
        warning:
          "Disconnected. Revoking access at Stripe did not complete, so check your Stripe dashboard.",
      });
    }
    return data<ActionResult>({ action: intent, ok: true });
  }

  return data<ActionResult>(
    { action: intent, ok: false, error: "Unknown settings action." },
    { status: 400 },
  );
}

/** Legacy's date line on a connection row: "Connected Aug 21, 2026", from
 *  toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
 *  (StripeSection.tsx, blob 4068961e). Omitted entirely when the timestamp is
 *  null, as legacy omits it. */
function connectedLabel(at: Date | null): string | null {
  if (!at) return null;
  return "Connected " + new Date(at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * S37's Stripe section, at legacy's geometry (StripeSection.tsx, blob 4068961e),
 * with legacy's inline two-step confirm rather than a modal: legacy has no modal
 * and no modal import, and AccountSection.tsx uses the same two-step pattern, so
 * it is the settings section's house confirm.
 *
 * The confirm state lives in the URL as confirm=<id> rather than in useState.
 * Same two steps and same labels as legacy; the difference is that a form post
 * carries the id, so the button reading "Yes, disconnect Stripe" submits the
 * connection it is sitting beside. Legacy held its id in state and then sent no
 * id at all, which is why its per-connection UI is decorative (333).
 */
function StripeSection({
  connections,
  confirmingId,
  result,
}: {
  connections: { id: string; name: string | null; stripeUserId: string; connectedAt: Date | null }[];
  confirmingId: string | null;
  result?: ActionResult;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">Stripe</h2>
      {result?.action === "disconnect-stripe" && result.ok && !result.warning ? (
        <Alert tone="success">Disconnected.</Alert>
      ) : null}
      {result?.action === "disconnect-stripe" && result.warning ? (
        <Alert tone="error">{result.warning}</Alert>
      ) : null}
      {result?.action === "disconnect-stripe" && !result.ok && result.error ? (
        <Alert tone="error">{result.error}</Alert>
      ) : null}

      {connections.length === 0 ? (
        <div className="mt-4 flex flex-col items-start gap-3 md:flex-row md:items-center md:justify-between">
          <p className="text-label text-text">No Stripe account connected</p>
          <a
            href="/connect"
            className="whitespace-nowrap rounded-md bg-brand px-4 py-2 text-label font-semibold text-on-brand no-underline transition-opacity duration-500 hover:opacity-80"
          >
            Connect Stripe
          </a>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {connections.map((conn) => {
            const isConfirming = confirmingId === conn.id;
            const label = conn.name || conn.stripeUserId;
            const connected = connectedLabel(conn.connectedAt);
            return (
              <div
                key={conn.id}
                className="flex flex-col items-start gap-3 rounded-lg border border-border px-4 py-3 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <div className="mb-0.5 text-label text-text">{label}</div>
                  {connected ? <div className="text-micro text-text-subtle">{connected}</div> : null}
                </div>
                <div className="flex items-center gap-2">
                  {isConfirming ? (
                    <DemoGuardedForm method="post">
                      <input type="hidden" name="_action" value="disconnect-stripe" />
                      <input type="hidden" name="connectionId" value={conn.id} />
                      <button
                        type="submit"
                        disabled={busy}
                        className="rounded-md border border-border bg-transparent px-4 py-2 text-label text-red transition-colors duration-150 hover:border-text-tertiary disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? "Disconnecting..." : "Yes, disconnect Stripe"}
                      </button>
                    </DemoGuardedForm>
                  ) : (
                    <a
                      href={"?confirm=" + conn.id}
                      className="rounded-md border border-border bg-transparent px-4 py-2 text-label text-text-subtle no-underline transition-colors duration-150 hover:border-text-tertiary"
                    >
                      Disconnect Stripe
                    </a>
                  )}
                  {isConfirming && !busy ? (
                    <a
                      href="?"
                      className="rounded-md border border-border bg-transparent px-4 py-2 text-label text-text-subtle no-underline transition-colors duration-150 hover:border-text-tertiary"
                    >
                      Keep connected
                    </a>
                  ) : null}
                </div>
              </div>
            );
          })}
          <div className="pt-2">
            <a
              href="/connect/additional"
              className="inline-block whitespace-nowrap rounded-md border border-border bg-transparent px-4 py-2 text-label text-text no-underline transition-colors duration-150 hover:border-text-tertiary"
            >
              Add Stripe account
            </a>
          </div>
        </div>
      )}
    </section>
  );
}

export default function StripeSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { connections } = loaderData;
  const result = actionData as ActionResult | undefined;
  const confirmingId = useSearchParams()[0].get("confirm");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-h2 text-text">Stripe connections</h1>
        <p className="mt-1 text-label text-text-tertiary">Connected accounts.</p>
      </header>
      <StripeSection connections={connections} confirmingId={confirmingId} result={result} />
    </div>
  );
}
