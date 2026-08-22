import { data, useNavigation, useSearchParams } from "react-router";

import { Alert, Field, Submit } from "~/components/auth-ui";
import { DemoGuardedForm } from "~/components/demo-guarded-form";
import { getDb } from "~/db";
import { authContext } from "~/lib/auth/context";
import { cloudflareContext } from "~/lib/cloudflare-context";
import {
  buildAccountProfileUpdate,
  buildBrandVoiceUpdate,
  buildEmailSettingsUpdate,
  buildIntelligenceContextUpdate,
} from "~/lib/settings/persist.server";
import { formatCentsAsDollars, parseDollarsToCents } from "~/lib/settings/dollars";
import { getAccount, getActiveConnectionBrandVoice, listAccountConnections } from "~/lib/settings/queries.server";
import { cancelMerchant, disconnectConnection, findLiveConnection } from "~/lib/admin/merchants.server";
import { getSession, listMemberships, setSessionActiveAccount } from "~/lib/auth";

import type { Route } from "./+types/index";

export function meta() {
  return [{ title: "Settings - Foxhound" }];
}

export async function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const auth = context.get(authContext);
  const accountId = auth.membership.accountId;
  const db = getDb(env);

  const [account, connection, connections] = await Promise.all([
    getAccount(db, accountId),
    getActiveConnectionBrandVoice(db, accountId),
    listAccountConnections(db, accountId),
  ]);
  if (!account) throw new Response("Not Found", { status: 404 });

  return {
    account,
    connection,
    // S37. Live connections drive the list; the count of disconnected ones tells
    // the two empty states apart (never connected, versus disconnected).
    connections: connections.filter((c) => !c.disconnectedAt),
    everConnected: connections.length > 0,
    cancelledAt: account.cancelledAt,
  };
}

type ActionResult = { action: string; ok: boolean; error?: string; warning?: string };

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
        return data({ action: intent, ok: false, error: "Account name is required." }, { status: 400 });
      }
      await buildAccountProfileUpdate(db, accountId, { name });
      return data({ action: intent, ok: true });
    }
    case "email": {
      // S36 / ruling 336 binding 3: `digest_email` is REMOVED from this form.
      // It is a Foxhound invention with no legacy column, no legacy field and
      // no reader: the audit digest sends to `notification_email`. A field that
      // writes a column nothing reads is a false promise, and one legacy never
      // had is an unratified addition on top of it. The COLUMN stays, because
      // dropping it is a migration and none is owed here.
      await buildEmailSettingsUpdate(db, accountId, {
        notificationEmail: str("notificationEmail"),
      });
      return data({ action: intent, ok: true });
    }
    case "intelligence-context": {
      await buildIntelligenceContextUpdate(db, accountId, {
        merchantIndustry: str("merchantIndustry"),
        primaryCustomerType: str("primaryCustomerType"),
        merchantMrrSelfReportedCents: parseDollarsToCents(String(form.get("merchantMrrSelfReported") ?? "")),
      });
      return data({ action: intent, ok: true });
    }
    case "brand-voice": {
      const connectionId = String(form.get("connectionId") ?? "");
      if (!connectionId) {
        return data(
          { action: intent, ok: false, error: "Connect Stripe before setting a brand voice." },
          { status: 400 },
        );
      }
      await buildBrandVoiceUpdate(db, accountId, connectionId, str("brandVoice"));
      return data({ action: intent, ok: true });
    }
    // ---- S37: Stripe connection and account lifecycle (rulings 40, 333) ----
    //
    // METHOD AGREEMENT IS STRUCTURAL HERE, and it is the defect legacy shipped:
    // its client sent `fetch(..., { method: 'POST' })` at a route exporting only
    // DELETE, so the button could never succeed (325). These are React Router
    // form posts to this route's own action, so the client method and the route
    // method are the same POST by construction, and a plant asserts it.
    case "disconnect-stripe": {
      // Legacy sends NO connection id and its route resolves `is_primary`
      // itself, so its per-connection UI is decorative: clicking the second row
      // disconnects the first. The id is required and real here.
      const connectionId = String(form.get("connectionId") ?? "").trim();
      if (!connectionId) {
        return data({ action: intent, ok: false, error: "Connection is required." }, { status: 400 });
      }
      // Scoped to the ACTIVE account from the session marker (auth.membership),
      // never the earliest membership. A connection under another account the
      // caller holds is refused exactly like one they do not hold at all.
      const live = await findLiveConnection(db, accountId, connectionId);
      if (!live) {
        return data({ action: intent, ok: false, error: "That connection is not on this account." }, { status: 403 });
      }
      const result = await disconnectConnection(env, live);
      if (result.deauthorizeError) {
        return data({
          action: intent,
          ok: true,
          warning: "Disconnected. Revoking access at Stripe did not complete, so check your Stripe dashboard.",
        });
      }
      return data({ action: intent, ok: true });
    }
    case "cancel-account": {
      const outcome = await cancelMerchant(env, accountId);
      // Move this session to another account the caller holds, if any. With none
      // left, the marker is cleared and the app shell lands them on the
      // signed-in empty state at /connect the way an accountless session does.
      const session = await getSession(env, request);
      if (session) {
        const remaining = (await listMemberships(db, auth.userId)).filter((m) => m.accountId !== accountId);
        if (remaining.length > 0) {
          await setSessionActiveAccount(db, session.session.id, remaining[0].accountId);
        }
      }
      return data({
        action: intent,
        ok: true,
        warning: outcome.deauthorizeErrors.length > 0
          ? "Account cancelled. Revoking access at Stripe did not complete for every connection, so check your Stripe dashboard."
          : undefined,
      });
    }
    default:
      return data({ action: intent, ok: false, error: "Unknown settings action." }, { status: 400 });
  }
}

function SettingsCard({
  title,
  description,
  action,
  result,
  submittable = true,
  children,
}: {
  title: string;
  description?: string;
  action: string;
  result?: ActionResult;
  submittable?: boolean;
  children: React.ReactNode;
}) {
  const busy = useNavigation().state !== "idle";
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="text-label font-semibold text-text">{title}</h2>
      {description ? (
        <p className="mt-1 text-label text-text-tertiary">{description}</p>
      ) : null}
      {submittable ? (
        <DemoGuardedForm method="post" className="mt-4 flex flex-col gap-3">
          <input type="hidden" name="_action" value={action} />
          {result?.action === action && result.ok ? (
            <Alert tone="success">Saved.</Alert>
          ) : null}
          {result?.action === action && !result.ok && result.error ? (
            <Alert tone="error">{result.error}</Alert>
          ) : null}
          {children}
          <div>
            <Submit disabled={busy}>{busy ? "Saving..." : "Save"}</Submit>
          </div>
        </DemoGuardedForm>
      ) : (
        <div className="mt-4 flex flex-col gap-3">{children}</div>
      )}
    </section>
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
            className="whitespace-nowrap rounded-md bg-amber px-4 py-2 text-label font-semibold text-on-amber no-underline transition-opacity duration-500 hover:opacity-80"
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

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { account, connection, connections, cancelledAt } = loaderData;
  const result = actionData as ActionResult | undefined;
  const confirmingId = useSearchParams()[0].get("confirm");

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
      <h1 className="text-title font-medium text-text">Settings</h1>

      <SettingsCard title="Account" action="profile" result={result}>
        <Field label="Account name" name="name" required defaultValue={account.name ?? ""} />
      </SettingsCard>

      <SettingsCard
        title="Brand voice"
        description="Dunning emails are written in this voice, not Foxhound's. Leave blank for a neutral default tone."
        action="brand-voice"
        result={result}
      >
        <input type="hidden" name="connectionId" value={connection?.id ?? ""} />
        {connection ? (
          <label className="flex flex-col gap-1.5">
            <span className="font-mono text-micro uppercase tracking-wide text-text-tertiary">
              Voice description
            </span>
            <textarea
              name="brandVoice"
              rows={3}
              defaultValue={connection.brandVoice ?? ""}
              placeholder="Warm, plain, and direct; a real person from the business writing a short note"
              className="rounded-md border border-border bg-surface px-3 py-2 text-body text-text placeholder:text-text-subtle focus-visible:border-amber"
            />
          </label>
        ) : (
          <p className="text-label text-text-tertiary">
            Connect Stripe before setting a brand voice.
          </p>
        )}
      </SettingsCard>

      <SettingsCard
        title="Email"
        description="Where Foxhound sends account notifications."
        action="email"
        result={result}
      >
        <Field
          label="Notification email"
          name="notificationEmail"
          type="email"
          required={false}
          defaultValue={account.notificationEmail ?? ""}
        />
      </SettingsCard>

      <SettingsCard title="Notifications" action="notifications" submittable={false}>
        <p className="text-label text-text-secondary">
          Notifications aren't sending yet. There's nothing to configure here until they do; check
          back once this ships.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Intelligence context"
        description="Optional. These help score risk more accurately once Intelligence scoring is available; they do not change anything today."
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

      <StripeSection connections={connections} confirmingId={confirmingId} result={result} />

      <DangerZone cancelledAt={cancelledAt} result={result} />
    </div>
  );
}
