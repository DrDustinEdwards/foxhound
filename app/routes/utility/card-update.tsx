import { and, eq, isNull } from "drizzle-orm";
import { data, Form, redirect, useNavigation } from "react-router";

import { Alert, AuthShell, Submit } from "~/components/auth-ui";
import { Header } from "~/components/header";
import { expiringCardAlerts, failedPayments, getDb, stripeConnections } from "~/db";
import { buildCardUpdateSignal, hasCardUpdateSignal } from "~/lib/card-update/signal";
import { createCardUpdateSession, finalizeCardUpdateSession } from "~/lib/card-update/service";
import { verifyCardUpdateToken } from "~/lib/card-update/token";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { formatMoney } from "~/lib/money-format";
import { decryptToken } from "~/lib/stripe/encryption";
import { DEFAULT_THEME } from "~/lib/theme";

import type { Route } from "./+types/card-update";

// Per-recipient, token-bearing, and it resolves to a specific failed payment
// and a Stripe Checkout session, so it is never cacheable by a shared
// intermediary (Dustin, 2026-08-04). See the same note on unsubscribe.tsx:
// neither side sent a directive, and the e/o pixel was the only one of the four
// tokenised routes that did.
export function headers() {
  return { "Cache-Control": "no-store, no-cache, must-revalidate, private" };
}

export function meta() {
  return [{ title: "Update payment method - Foxhound" }];
}

// Hosted no-login card-update page (ROUTES.md public-utility, PRICING.md
// table stakes). Token is HMAC-signed and stateless (app/lib/card-update/token.ts,
// mirrors the /e/* engagement token pattern, gotcha #37); verified before
// anything else runs, so a tampered/expired link renders a clean state, never
// a stack trace. Payment-method collection is a Stripe-hosted Checkout Session
// in `setup` mode on the CONNECTED account (the merchant's own Stripe, via
// their decrypted OAuth token, never the platform key, never logged). On a
// successful return, records the card_update attribution signal that
// webhooks/process.ts's resolveRecoveryAttribution reads (M1, Phase 4 review).
// Live Stripe verification is Phase 8; this seam typechecks and is built inert
// against a real redirect now.

type LoaderState =
  | { state: "invalid" }
  | { state: "resolved" }
  | { state: "setup_failed" }
  // `amountCents`/`currency` are ABSENT in alert mode: nothing has failed, so
  // there is no amount to name and the subtitle is simply omitted. Every other
  // string on the page is unchanged between the two modes.
  | { state: "ready"; amountCents?: number; currency?: string }
  | { state: "done" };

export interface ConnectionCandidate {
  id: string;
  stripeAccessToken: string | null;
}

/**
 * Resolve which stripe_connections row a failed payment's card-update flow
 * should use (Phase 5 review MEDIUM fix, 2026-07-19). An account can have
 * more than one active connection: connect-callback.ts inserts a new row
 * with isPrimary:true unconditionally whenever a DIFFERENT stripeUserId
 * connects, with no exclusivity enforced. Picking an arbitrary active
 * connection risked calling Stripe with a customerId that belongs to a
 * DIFFERENT connected account. Prefers the specific connection the failed
 * payment was recorded against (failed_payments.stripe_connection_id, set at
 * intake, webhooks/batches.ts buildIntakeBatch); falls back to the single
 * active connection only for older rows recorded before that column was
 * populated, and never guesses among multiple.
 */
export function resolveConnectionForFailedPayment(
  candidates: ConnectionCandidate[],
  stripeConnectionId: string | null,
): ConnectionCandidate | null {
  if (stripeConnectionId) {
    return candidates.find((c) => c.id === stripeConnectionId) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** What both modes resolve to: enough to open a Checkout session and finalize it. */
interface CardUpdateTarget {
  /** Present in recovery mode only; alert mode records no attribution signal. */
  failedPaymentId: string | null;
  stripeCustomerId: string;
  /** Recovery mode may pin the subscription; an alert has none, and
   *  finalizeCardUpdateSession already updates the CUSTOMER default either way. */
  subscriptionId: string | null;
  connection: ConnectionCandidate | null;
  /** True when there is nothing left to do (a payment already resolved). */
  resolved: boolean;
  amountCents?: number;
  currency?: string;
}

/**
 * ALERT MODE's target. The alert row carries the customer and the connection
 * the scan found it on, so nothing here depends on a failed payment existing.
 *
 * A soft-deleted alert resolves to nothing and the page renders "invalid",
 * rather than inviting a customer to update a card against a withdrawn warning.
 */
async function loadAlertTarget(
  env: Env,
  alertId: string,
  accountId: string,
): Promise<CardUpdateTarget | null> {
  const db = getDb(env);
  const [alertRows, connectionRows] = await Promise.all([
    db
      .select({
        id: expiringCardAlerts.id,
        stripeCustomerId: expiringCardAlerts.stripeCustomerId,
        stripeConnectionId: expiringCardAlerts.stripeConnectionId,
        deletedAt: expiringCardAlerts.deletedAt,
      })
      .from(expiringCardAlerts)
      .where(and(eq(expiringCardAlerts.id, alertId), eq(expiringCardAlerts.accountId, accountId)))
      .limit(1),
    db
      .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt))),
  ]);
  const alert = alertRows[0];
  if (!alert || alert.deletedAt) return null;
  return {
    failedPaymentId: null,
    stripeCustomerId: alert.stripeCustomerId,
    subscriptionId: null,
    connection: resolveConnectionForFailedPayment(connectionRows, alert.stripeConnectionId),
    resolved: false,
  };
}

async function loadTarget(env: Env, failedPaymentId: string, accountId: string) {
  const db = getDb(env);
  const [failedPaymentRows, connectionRows] = await Promise.all([
    db
      .select({
        id: failedPayments.id,
        status: failedPayments.status,
        stripeCustomerId: failedPayments.stripeCustomerId,
        subscriptionId: failedPayments.subscriptionId,
        amountCents: failedPayments.amountCents,
        currency: failedPayments.currency,
        stripeConnectionId: failedPayments.stripeConnectionId,
      })
      .from(failedPayments)
      .where(and(eq(failedPayments.id, failedPaymentId), eq(failedPayments.accountId, accountId)))
      .limit(1),
    db
      .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt))),
  ]);
  const failedPayment = failedPaymentRows[0] ?? null;
  const connection = failedPayment
    ? resolveConnectionForFailedPayment(connectionRows, failedPayment.stripeConnectionId)
    : null;
  return { failedPayment, connection };
}

/**
 * Dispatch on which id the token carries. A token with NEITHER resolves to
 * null and the page renders "invalid", so the optional `failedPaymentId` can
 * never become a way to reach a live Checkout session with no target.
 */
async function resolveTarget(
  env: Env,
  payload: { failedPaymentId?: string; expiringCardAlertId?: string; accountId: string },
): Promise<CardUpdateTarget | null> {
  if (payload.failedPaymentId) {
    const { failedPayment, connection } = await loadTarget(
      env,
      payload.failedPaymentId,
      payload.accountId,
    );
    if (!failedPayment) return null;
    return {
      failedPaymentId: failedPayment.id,
      stripeCustomerId: failedPayment.stripeCustomerId,
      subscriptionId: failedPayment.subscriptionId,
      connection,
      resolved: failedPayment.status !== "active",
      amountCents: failedPayment.amountCents,
      currency: failedPayment.currency,
    };
  }
  if (payload.expiringCardAlertId) {
    return loadAlertTarget(env, payload.expiringCardAlertId, payload.accountId);
  }
  return null;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const payload = token ? await verifyCardUpdateToken(env, token) : null;
  if (!payload) {
    return data<LoaderState>({ state: "invalid" });
  }

  const target = await resolveTarget(env, payload);
  // Bound here rather than read through the object later: narrowing a property
  // does not survive being copied to another const, and the encrypted token is
  // the only thing this branch needs from the connection.
  const encryptedAccessToken = target?.connection?.stripeAccessToken;
  if (!target || !encryptedAccessToken) {
    return data<LoaderState>({ state: "invalid" });
  }
  if (target.resolved) {
    return data<LoaderState>({ state: "resolved" });
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (sessionId) {
    try {
      const accessToken = await decryptToken(env, encryptedAccessToken);
      const result = await finalizeCardUpdateSession({
        accessToken,
        sessionId,
        subscriptionId: target.subscriptionId,
      });
      if (!result.ok) {
        return data<LoaderState>({ state: "setup_failed" });
      }
      // THE ATTRIBUTION SIGNAL IS RECOVERY MODE ONLY (341 binding 2). It writes
      // a recovery_steps row that findAttributionSignals reads as billable
      // `card_update`, and an alert has no failed payment to attribute to. An
      // alert-mode update therefore triggers no retry and records nothing here;
      // the alert's own outcome row is its record.
      if (target.failedPaymentId) {
        const db = getDb(env);
        if (!(await hasCardUpdateSignal(db, target.failedPaymentId))) {
          await buildCardUpdateSignal(db, {
            failedPaymentId: target.failedPaymentId,
            accountId: payload.accountId,
            occurredAt: new Date(),
          });
        }
      }
    } catch {
      // Never log the error object: it can carry request/token context.
      return data<LoaderState>({ state: "setup_failed" });
    }
    // Redirect to the clean URL so a refresh never re-finalizes the same session_id.
    throw redirect(`/p/${token}?done=1`);
  }

  const done = url.searchParams.get("done") === "1";
  if (done) return data<LoaderState>({ state: "done" });
  return data<LoaderState>({
    state: "ready",
    amountCents: target.amountCents,
    currency: target.currency,
  });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const payload = token ? await verifyCardUpdateToken(env, token) : null;
  if (!payload) {
    return data({ error: "This link is invalid or has expired." }, { status: 400 });
  }

  const target = await resolveTarget(env, payload);
  const encryptedAccessToken = target?.connection?.stripeAccessToken;
  if (!target || target.resolved || !encryptedAccessToken) {
    return data({ error: "This payment method link is no longer active." }, { status: 400 });
  }

  try {
    const accessToken = await decryptToken(env, encryptedAccessToken);
    const url = new URL(request.url);
    const session = await createCardUpdateSession({
      accessToken,
      customerId: target.stripeCustomerId,
      successUrl: `${url.origin}/p/${token}?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${url.origin}/p/${token}`,
    });
    return redirect(session.url);
  } catch {
    // Never log the error object: it can carry request/token context.
    return data({ error: "Could not start the payment method update. Please try again." }, { status: 502 });
  }
}

export default function CardUpdate({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const state = loaderData.state;
  const amountLine =
    loaderData.state === "ready"
      && loaderData.amountCents !== undefined
      && loaderData.currency !== undefined
      ? `A recent payment of ${formatMoney(loaderData.amountCents, loaderData.currency)} did not go through.`
      : undefined;

  return (
    <>
      {/* No Foxhound session concept applies to this public, no-login page
          (the visitor is a merchant's customer, not a Foxhound account
          holder); DEFAULT_THEME is a safe SSR default since a stateless,
          usually-single-visit link isn't worth threading a cookie read
          through this route's LoaderState union for. */}
      <Header isAuthenticated={false} theme={DEFAULT_THEME} />
      {state === "invalid" ? (
        <AuthShell title="Link not found">
          <Alert tone="error">This link is invalid or has expired.</Alert>
        </AuthShell>
      ) : state === "resolved" ? (
        <AuthShell title="Nothing to do here">
          <Alert tone="success">
            This payment has already been resolved. No action is needed.
          </Alert>
        </AuthShell>
      ) : state === "done" ? (
        <AuthShell title="Payment method updated">
          <Alert tone="success">
            Your payment method has been updated. Thank you.
          </Alert>
        </AuthShell>
      ) : (
        <AuthShell title="Update your payment method" subtitle={amountLine}>
          {state === "setup_failed" ? (
            <Alert tone="error">
              We could not confirm your payment method update. Please try again.
            </Alert>
          ) : null}
          {actionData?.error ? <Alert tone="error">{actionData.error}</Alert> : null}
          <Form method="post">
            <Submit disabled={busy}>{busy ? "Redirecting..." : "Update payment method"}</Submit>
          </Form>
        </AuthShell>
      )}
    </>
  );
}
