import { Alert, Banner } from "capsomer/react/banner";
import { Button } from "capsomer/react/button";
import { and, eq, isNull } from "drizzle-orm";
import type { ReactNode } from "react";
import { data, Form, redirect, useNavigation } from "react-router";

import "capsomer/banner.css";
import "capsomer/button.css";
import "capsomer/panel.css";
// Capsomer's tokens and the teal family (capbase layer), which the Panel, the
// Button, the Banner and Alert, and the focus ring read. The site header loads the same
// file; importing it here keeps the page whole under any layout.
import "~/site-header.css";

import { Header } from "~/components/header";
import { Wordmark } from "~/components/wordmark";
import { expiringCardAlerts, failedPayments, getDb, stripeConnections, winBackSequences } from "~/db";
import { buildCardUpdateSignal, hasCardUpdateSignal } from "~/lib/card-update/signal";
import {
  createCardUpdateSession,
  createResubscribeSession,
  finalizeCardUpdateSession,
} from "~/lib/card-update/service";
import { verifyCardUpdateToken } from "~/lib/card-update/token";
import { cloudflareContext } from "~/lib/cloudflare-context";
import { DEMO_ACCOUNT_ID_PREFIX } from "~/lib/constants";
import { TOKEN_LINK_DIRECTIVE } from "~/lib/http/cache-policy";
import { formatMoney } from "~/lib/money-format";
import { isWinbackResubscribable } from "~/lib/recovery/winback";
import { decryptToken } from "~/lib/stripe/encryption";

import type { Route } from "./+types/card-update";

// Per-recipient, token-bearing, and it resolves to a specific failed payment
// and a Stripe Checkout session, so it is never cacheable by a shared
// intermediary (Dustin, 2026-08-04). See the same note on unsubscribe.tsx:
// neither side sent a directive, and the e/o pixel was the only one of the four
// tokenised routes that did.
export function headers() {
  return { "Cache-Control": TOKEN_LINK_DIRECTIVE };
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
  | { state: "done" }
  // RESUBSCRIBE MODE (343 binding 4). A separate set of states, because
  // nothing has failed and no card is being collected: the customer
  // cancelled, and the one button restarts the subscription on Stripe.
  | { state: "resubscribe"; planName: string | null }
  | { state: "handled" }
  | { state: "resubscribed" };

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

/** What resubscribe mode resolves to. Deliberately NOT a CardUpdateTarget:
 *  there is no failed payment, no amount and no card to collect. */
export interface ResubscribeTarget {
  sequenceId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  planName: string | null;
  status: string;
  connection: ConnectionCandidate | null;
}

/**
 * RESUBSCRIBE MODE's target, read off `win_back_sequences`.
 *
 * The sequence carries the cancelled subscription id, which is what the price
 * is re-read from at click time: neither side stores a price id, because
 * legacy's billing portal never needed one.
 */
async function loadResubscribeTarget(
  env: Env,
  sequenceId: string,
  accountId: string,
): Promise<ResubscribeTarget | null> {
  const db = getDb(env);
  const [sequenceRows, connectionRows] = await Promise.all([
    db
      .select({
        id: winBackSequences.id,
        stripeCustomerId: winBackSequences.stripeCustomerId,
        stripeSubscriptionId: winBackSequences.stripeSubscriptionId,
        planName: winBackSequences.planName,
        status: winBackSequences.status,
        stripeConnectionId: winBackSequences.stripeConnectionId,
      })
      .from(winBackSequences)
      .where(and(eq(winBackSequences.id, sequenceId), eq(winBackSequences.accountId, accountId)))
      .limit(1),
    db
      .select({ id: stripeConnections.id, stripeAccessToken: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(and(eq(stripeConnections.accountId, accountId), isNull(stripeConnections.disconnectedAt))),
  ]);
  const sequence = sequenceRows[0];
  if (!sequence) return null;
  return {
    sequenceId: sequence.id,
    stripeCustomerId: sequence.stripeCustomerId,
    stripeSubscriptionId: sequence.stripeSubscriptionId,
    planName: sequence.planName,
    status: sequence.status,
    connection: resolveConnectionForFailedPayment(connectionRows, sequence.stripeConnectionId),
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

/**
 * RESUBSCRIBE MODE's loader. Renders one of three states and reads nothing it
 * does not render: no Stripe call happens here, because 343 binding 4 puts the
 * Checkout Session on the CLICK and not on the render.
 */
async function resubscribeLoader(
  env: Env,
  request: Request,
  sequenceId: string,
  accountId: string,
) {
  const target = await loadResubscribeTarget(env, sequenceId, accountId);
  if (!target || !target.connection?.stripeAccessToken) {
    return data<LoaderState>({ state: "invalid" });
  }
  if (!isWinbackResubscribable(target.status)) {
    return data<LoaderState>({ state: "handled" });
  }
  // Stripe returns the customer here after a completed session. Foxhound writes
  // NOTHING on this return: session 52 owns the reactivation, keyed off the
  // metadata on the session Stripe reports back through the webhook, which is
  // authoritative where a browser redirect is not.
  if (new URL(request.url).searchParams.get("done") === "1") {
    return data<LoaderState>({ state: "resubscribed" });
  }
  return data<LoaderState>({ state: "resubscribe", planName: target.planName });
}

/**
 * RESUBSCRIBE MODE's POST. Creates the Checkout Session on the CONNECTED
 * account and redirects to Stripe.
 *
 * It records no outcome: `winback_reactivated` belongs to the completion, which
 * session 52 owns, and a click is not a reactivation. It writes no row either,
 * because neither `win_back_sequences` nor `win_back_steps` carries a session
 * id column and 343 binding 5 adds no migration, so THE METADATA IS THE LINK.
 */
async function resubscribeAction(
  env: Env,
  request: Request,
  input: { token: string; sequenceId: string; accountId: string; stepNumber: number },
) {
  // Demo accounts refuse AT THE STRIPE-CALL GATE. The demo seed's connection
  // carries no usable token, so this would fail anyway; refusing on the id
  // makes the firewall the reason rather than an accident of seed data.
  if (input.accountId.startsWith(DEMO_ACCOUNT_ID_PREFIX)) {
    return data({ error: "This link is not available on a demo account." }, { status: 400 });
  }

  const target = await loadResubscribeTarget(env, input.sequenceId, input.accountId);
  const encryptedAccessToken = target?.connection?.stripeAccessToken;
  if (!target || !encryptedAccessToken || !isWinbackResubscribable(target.status)) {
    return data({ error: "This reactivation link is no longer active." }, { status: 400 });
  }

  try {
    const accessToken = await decryptToken(env, encryptedAccessToken);
    const url = new URL(request.url);
    const session = await createResubscribeSession({
      accessToken,
      customerId: target.stripeCustomerId,
      subscriptionId: target.stripeSubscriptionId,
      winBackSequenceId: target.sequenceId,
      winBackStepNumber: input.stepNumber,
      successUrl: `${url.origin}/p/${input.token}?done=1`,
      cancelUrl: `${url.origin}/p/${input.token}`,
    });
    if (!session) {
      return data({ error: "This plan is no longer available." }, { status: 400 });
    }
    return redirect(session.url);
  } catch {
    // Never log the error object: it can carry request/token context.
    return data({ error: "Could not start the reactivation. Please try again." }, { status: 502 });
  }
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(cloudflareContext);
  const token = params.token;
  const payload = token ? await verifyCardUpdateToken(env, token) : null;
  if (!payload) {
    return data<LoaderState>({ state: "invalid" });
  }

  if (payload.winBackSequenceId) {
    return resubscribeLoader(env, request, payload.winBackSequenceId, payload.accountId);
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

  if (payload.winBackSequenceId) {
    return resubscribeAction(env, request, {
      token: token as string,
      sequenceId: payload.winBackSequenceId,
      accountId: payload.accountId,
      stepNumber: payload.winBackStepNumber ?? 0,
    });
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

/**
 * The page's frame (J62, row F8): one Capsomer card on its own, in a narrow
 * column with a 16px side margin on a phone. The reader is a merchant's
 * customer, not a Foxhound merchant, so the page leaves AuthShell, whose brand
 * panel pitches Foxhound to merchants; the sign-in pages keep it. The
 * coordinator chose this as the recommended default while the question is
 * with Dustin (PR #56).
 *
 * Its parts are Capsomer's (Q12): the card is Capsomer's panel, used through
 * its HTML contract as a body-only panel, because the React Panel always draws
 * an h2 header band and this page's one heading must be its h1 (a Capsomer gap,
 * named in the PR). Inside: a Banner for a state the page lands in, an Alert
 * above the button for a failure of that button's action, and the primary
 * Button. The wrapper puts them in Capsomer's teal family with Foxhound's own
 * neutrals (.fh-cap, the pairing the site header and the legal pages use), so
 * the button is teal (Q11) and the focus ring inside it is the family's teal
 * ring. Capsomer's banner and button text is 13px, the label size, and the
 * heading and line under it keep the title and label sizes, so the page stays
 * on the five sizes (RULES.md 5.2).
 *
 * Recova has no page here (its emails link straight to a Stripe billing
 * portal session), so there is no Recova arrangement to follow: the words and
 * their order are Foxhound's own, unchanged by this job.
 */
function CardUpdateFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-md px-4 py-8 md:py-16">
      <div className="fh-cap [--border-focus:var(--ring)]" data-family="teal" data-card-update="">
        <section className="cap-panel">
          <div className="cap-panel-body">
            <Wordmark />
            <div className="flex flex-col gap-1">
              <h1 className="text-title font-medium text-text">{title}</h1>
              {subtitle ? <p className="text-label text-text-tertiary">{subtitle}</p> : null}
            </div>
            {children}
          </div>
        </section>
      </div>
    </main>
  );
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
  // Legacy has no page here at all, its button going straight to a Stripe
  // portal, so there is no portal-return copy to port and this is the fewest
  // words that still tell the customer what they are restarting.
  const resubscribeLine =
    loaderData.state === "resubscribe" && loaderData.planName
      ? `Your ${loaderData.planName} plan.`
      : undefined;

  return (
    <>
      {/* No Foxhound session concept applies to this public, no-login page
          (the visitor is a merchant's customer, not a Foxhound account
          holder). The header takes the root loader's theme, the one <html>
          was drawn in, so its theme button never flips the page. */}
      <Header isAuthenticated={false} />
      {state === "invalid" ? (
        <CardUpdateFrame title="Link not found">
          <Banner tone="crit">This link is invalid or has expired.</Banner>
        </CardUpdateFrame>
      ) : state === "resolved" ? (
        <CardUpdateFrame title="Nothing to do here">
          <Banner tone="ok">This payment has already been resolved. No action is needed.</Banner>
        </CardUpdateFrame>
      ) : state === "done" ? (
        <CardUpdateFrame title="Payment method updated">
          <Banner tone="ok">Your payment method has been updated. Thank you.</Banner>
        </CardUpdateFrame>
      ) : state === "handled" ? (
        <CardUpdateFrame title="Nothing to do here">
          <Banner tone="ok">This subscription has already been reactivated. No action is needed.</Banner>
        </CardUpdateFrame>
      ) : state === "resubscribed" ? (
        <CardUpdateFrame title="Welcome back">
          <Banner tone="ok">Your subscription has been restarted. Thank you.</Banner>
        </CardUpdateFrame>
      ) : state === "resubscribe" ? (
        <CardUpdateFrame title="Reactivate your subscription" subtitle={resubscribeLine}>
          {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
          <Form method="post">
            <Button type="submit" variant="primary" pending={busy}>
              {busy ? "Redirecting..." : "Reactivate my account"}
            </Button>
          </Form>
        </CardUpdateFrame>
      ) : (
        <CardUpdateFrame title="Update your payment method" subtitle={amountLine}>
          {state === "setup_failed" ? (
            <Alert tone="crit">We could not confirm your payment method update. Please try again.</Alert>
          ) : null}
          {actionData?.error ? <Alert tone="crit">{actionData.error}</Alert> : null}
          <Form method="post">
            <Button type="submit" variant="primary" pending={busy}>
              {busy ? "Redirecting..." : "Update payment method"}
            </Button>
          </Form>
        </CardUpdateFrame>
      )}
    </>
  );
}
