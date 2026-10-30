import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import { getDb, stripeConnections } from "~/db";
import { getConnectedStripe } from "~/lib/stripe/client";
import { decryptToken } from "~/lib/stripe/encryption";

import { readDisputeSettings } from "./queries.server";
import {
  calculateTriage,
  contextEvidenceFields,
  type DisputeContext,
  type DisputeContextColumns,
  disputeContextColumns,
  emptyDisputeContext,
} from "./triage";

// Recova's fetchDisputeContext (lib/disputes-evidence.ts, blob 2d5e7af6) on the
// connected account's own token: the disputed charge's billing details, card
// checks, Radar outcome and 3D Secure result, up to 20 of the customer's other
// charges, their first subscription, and the dispute's Smart Disputes status
// (Recova's fresh disputes.retrieve in handleDisputeCreated). Read-only.
//
// NEVER THROWS, as Recova's did not: each read that fails leaves its fields
// empty and the intake goes on, because a dispute that is not recorded is
// worse than one recorded without its context.

function formatBillingAddress(billing: Stripe.Address | null | undefined): string | null {
  if (!billing) return null;
  const parts = [
    billing.line1,
    billing.line2,
    billing.city,
    [billing.state, billing.postal_code].filter(Boolean).join(" "),
    billing.country,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

function combineAvs(card: Stripe.Charge.PaymentMethodDetails.Card | null | undefined): string | null {
  const line1 = card?.checks?.address_line1_check ?? null;
  const zip = card?.checks?.address_postal_code_check ?? null;
  if (!line1 && !zip) return null;
  return `line1:${line1 ?? "n/a"} zip:${zip ?? "n/a"}`;
}

function iso(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null;
}

/** Prior charges read for evidence, and how many are listed in it. */
const PRIOR_CHARGES_CAP = 500;
const PRIOR_CHARGES_LISTED = 20;

/** Read the context with a connected-account client. Exported for tests. */
export async function fetchDisputeContextWith(
  stripe: Stripe,
  input: { stripeDisputeId: string; chargeId: string; customerId: string | null },
): Promise<DisputeContext> {
  const context = emptyDisputeContext(input.customerId);

  try {
    const dispute = (await stripe.disputes.retrieve(input.stripeDisputeId)) as Stripe.Dispute & {
      smart_disputes?: { status?: string | null } | null;
    };
    context.smartDisputesStatus = dispute.smart_disputes?.status ?? null;
  } catch (err) {
    console.error("dispute context: disputes.retrieve failed", err instanceof Error ? err.message : err);
  }

  let disputedCurrency: string | null = null;
  try {
    const charge = await stripe.charges.retrieve(input.chargeId);
    disputedCurrency = charge.currency;
    const card = charge.payment_method_details?.card;
    context.customerName = charge.billing_details?.name ?? null;
    context.customerEmail = charge.billing_details?.email ?? charge.receipt_email ?? null;
    context.billingAddress = formatBillingAddress(charge.billing_details?.address);
    context.customerIp = (charge.metadata?.ip as string | undefined) ?? null;
    context.avsResult = combineAvs(card);
    context.cvvResult = card?.checks?.cvc_check ?? null;
    context.radarRiskScore = charge.outcome?.risk_score ?? null;
    context.radarRiskLevel = charge.outcome?.risk_level ?? null;
    context.threeDSecure = card?.three_d_secure?.result ?? null;
    context.serviceDate = new Date(charge.created * 1000);
    context.customerId =
      input.customerId ?? (typeof charge.customer === "string" ? charge.customer : (charge.customer?.id ?? null));
  } catch (err) {
    console.error("dispute context: charges.retrieve failed", err instanceof Error ? err.message : err);
    return context;
  }

  const customerId = context.customerId;
  if (!customerId) return context;

  try {
    // The customer's whole history up to a cap, not just the latest page: a
    // long-standing customer is the strongest evidence and the first 20
    // charges understated it. The total stays in the disputed charge's
    // currency (hard rule 2); the list keeps the newest entries.
    const historic: Stripe.Charge[] = [];
    for await (const c of stripe.charges.list({ customer: customerId, limit: 100 })) {
      if (c.id !== input.chargeId && c.status === "succeeded") historic.push(c);
      if (historic.length >= PRIOR_CHARGES_CAP) break;
    }
    context.priorChargesCount = historic.length;
    context.priorChargesTotal = historic
      .filter((c) => !disputedCurrency || c.currency === disputedCurrency)
      .reduce((sum, c) => sum + c.amount, 0);
    context.priorChargesJson = historic.slice(0, PRIOR_CHARGES_LISTED).map((c) => ({
      date: new Date(c.created * 1000).toISOString(),
      amount: c.amount,
      currency: c.currency,
      status: c.status,
    }));
  } catch (err) {
    console.error("dispute context: charges.list failed", err instanceof Error ? err.message : err);
  }

  try {
    // Every status: a churned customer's disputed subscription is canceled.
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 5 });
    const sub = subs.data[0];
    if (sub) {
      context.subscriptionJson = {
        id: sub.id,
        status: sub.status,
        start_date: iso(sub.start_date),
        canceled_at: iso(sub.canceled_at),
        plan_amount: sub.items.data[0]?.price?.unit_amount ?? null,
      };
    }
  } catch (err) {
    console.error("dispute context: subscriptions.list failed", err instanceof Error ? err.message : err);
  }

  return context;
}

/** The context for a dispute that arrived on `connectionId`, read with that
 *  connection's token. An absent or undecryptable token yields the empty
 *  context. */
async function fetchDisputeContext(
  env: Env,
  connectionId: string,
  input: { stripeDisputeId: string; chargeId: string; customerId: string | null },
): Promise<DisputeContext> {
  try {
    const [row] = await getDb(env)
      .select({ token: stripeConnections.stripeAccessToken })
      .from(stripeConnections)
      .where(eq(stripeConnections.id, connectionId))
      .limit(1);
    if (!row?.token) return emptyDisputeContext(input.customerId);
    const stripe = getConnectedStripe(await decryptToken(env, row.token));
    return await fetchDisputeContextWith(stripe, input);
  } catch (err) {
    console.error("dispute context: connection read failed", err instanceof Error ? err.message : err);
    return emptyDisputeContext(input.customerId);
  }
}

export interface DisputeIntakeContext {
  context: DisputeContext;
  columns: DisputeContextColumns;
  /** Stripe-read evidence fields, ahead of the grounded draft's. */
  evidence: { fieldName: string; fieldValue: string }[];
}

/**
 * Everything intake adds from Stripe, shared by the webhook and the manual
 * import so the two rows look alike: the context, Recova's triage over it (with
 * the account's ships-physical setting, as Recova read it), and the evidence
 * fields read off it.
 */
export async function readDisputeIntakeContext(
  env: Env,
  input: {
    accountId: string;
    connectionId: string;
    stripeDisputeId: string;
    chargeId: string;
    customerId: string | null;
    amountCents: number;
    reason: string;
  },
): Promise<DisputeIntakeContext> {
  const context = await fetchDisputeContext(env, input.connectionId, input);
  const shipsPhysical = await readDisputeSettings(getDb(env), input.accountId).then(
    (s) => s.shipsPhysical,
    () => false,
  );
  const triage = calculateTriage(context, input.amountCents, input.reason, shipsPhysical);
  return { context, columns: disputeContextColumns(context, triage), evidence: contextEvidenceFields(context) };
}

/** The Stripe-read fields first, then the draft's, one per field name. */
export function mergeEvidence(
  fromStripe: { fieldName: string; fieldValue: string }[],
  drafted: { fieldName: string; fieldValue: string }[],
): { fieldName: string; fieldValue: string }[] {
  const seen = new Set(fromStripe.map((f) => f.fieldName));
  return [...fromStripe, ...drafted.filter((f) => !seen.has(f.fieldName))];
}
