import { eq } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices, getDb, webhookEvents } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { buildWebhookClaim, type WebhookClaimInput } from "~/lib/webhooks/batches";
import type { WebhookOutcome } from "~/lib/webhooks/process";

// Reconciliation for Foxhound's OWN Stripe invoices (the ones we raise against
// merchants for fees). The platform webhook (/webhooks/stripe-platform) resolves
// the billing_invoices row an event applies to, then commits the exactly-once
// CLAIM and the status update as ONE atomic per-account money-write batch, the
// same folded-claim pattern the connected endpoint uses (app/lib/webhooks/batches.ts).
//
// It did NOT used to. The claim was a separate plain insert that committed
// BEFORE dispatch, and a dispatch failure was swallowed into a 200. So a lost
// invoice.paid was permanently lost: the event was marked processed, Stripe was
// told everything was fine and never redelivered, and our billing_invoices row
// stayed stuck on its previous status with no reconciler. Folding the claim in
// means a failure rolls back the claim too, and the route can 5xx for a real
// Stripe redelivery.

const PLATFORM_STATUS: Record<string, string> = {
  "invoice.finalized": "finalized",
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.marked_uncollectible": "uncollectible",
  "invoice.voided": "void",
};

/** Maps a platform Stripe event type to our billing_invoices status (null = ignore). Pure. */
export function platformBillingStatus(eventType: string): string | null {
  return PLATFORM_STATUS[eventType] ?? null;
}

/** The billing_invoices row a platform event applies to, plus what to write. */
export interface PlatformBillingTarget {
  accountId: string;
  billingInvoiceId: string;
  status: string;
  stripeInvoiceId: string | null;
  hostedInvoiceUrl: string | null;
}

/**
 * Resolve which billing_invoices row an event applies to. Reads only, so it is
 * safe to run before the claim. Returns null when the event is not one we act on
 * (unmapped type, no billing_invoice_id metadata, or an id we have no row for);
 * a D1 failure THROWS, which is the point: an unresolvable event must not be
 * claimed.
 */
async function resolvePlatformBillingTarget(
  env: Env,
  event: Stripe.Event,
): Promise<PlatformBillingTarget | null> {
  const status = platformBillingStatus(event.type);
  if (!status) return null;

  const invoice = event.data.object as Stripe.Invoice;
  const billingInvoiceId = invoice.metadata?.billing_invoice_id ?? null;
  if (!billingInvoiceId) return null;

  const db = getDb(env);
  const rows = await db
    .select({ accountId: billingInvoices.accountId })
    .from(billingInvoices)
    .where(eq(billingInvoices.id, billingInvoiceId))
    .limit(1);
  const accountId = rows[0]?.accountId;
  if (!accountId) return null;

  return {
    accountId,
    billingInvoiceId,
    status,
    stripeInvoiceId: invoice.id ?? null,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

/**
 * claim + billing_invoices status update, as ONE atomic batch through the
 * per-account money-write DO. The webhook_events unique index on stripe_event_id
 * is the exactly-once key: a replay fails the claim insert and rolls the whole
 * batch back, so the status is never applied twice.
 */
function buildPlatformBillingBatch(
  db: Db,
  input: { claim: WebhookClaimInput; target: PlatformBillingTarget; now: Date },
): MoneyWriteBatch {
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(billingInvoices)
      .set({
        status: input.target.status,
        stripeInvoiceId: input.target.stripeInvoiceId,
        stripeInvoiceUrl: input.target.hostedInvoiceUrl,
        finalizedAt: input.now,
      })
      .where(eq(billingInvoices.id, input.target.billingInvoiceId)),
  ];
}

/**
 * Process one verified platform event. Mirrors processConnectedWebhook: a thrown
 * error becomes an "error" outcome so the route 5xxs and Stripe redelivers with
 * NOTHING claimed, rather than the old behavior of claiming first and then
 * swallowing the failure into a 200.
 */
export async function processPlatformWebhook(
  env: Env,
  event: Stripe.Event,
  receivedAt: Date,
): Promise<WebhookOutcome> {
  try {
    const target = await resolvePlatformBillingTarget(env, event);

    if (!target) {
      // Nothing to apply, and no account to key a per-account DO on, so the
      // claim is a plain insert. There are no side effects to be atomic with,
      // which is exactly why this case does not need the folded batch.
      const claimed = await claimUnroutableEvent(env, event, receivedAt);
      return claimed ? { status: "ignored", reason: "no_billing_invoice" } : { status: "duplicate" };
    }

    const { applied } = await executeMoneyWrite(env, {
      accountId: target.accountId,
      idempotencyKey: `platform-webhook:${event.id}`,
      build: (db) =>
        buildPlatformBillingBatch(db, {
          claim: {
            stripeEventId: event.id,
            eventType: event.type,
            // The merchant this fee invoice belongs to. The old separate claim
            // wrote null here because it ran before the row was resolved.
            accountId: target.accountId,
            receivedAt,
            payload: event,
          },
          target,
          now: receivedAt,
        }),
    });
    return applied ? { status: "applied" } : { status: "duplicate" };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : "platform webhook error" };
  }
}

/** Claim an event we resolved to no billing_invoices row. Idempotent on the
 *  unique index; returns false when it was already claimed. */
async function claimUnroutableEvent(
  env: Env,
  event: Stripe.Event,
  receivedAt: Date,
): Promise<boolean> {
  const db = getDb(env);
  try {
    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      receivedAt,
      accountId: null,
      processed: true,
      processingStartedAt: receivedAt,
      payload: event,
    });
    return true;
  } catch {
    return false;
  }
}
