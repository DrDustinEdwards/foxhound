import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import type Stripe from "stripe";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, getDb, webhookEvents } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";
import { isUniqueConstraintError } from "~/lib/money/serializer";
import { buildWebhookClaim, type WebhookClaimInput } from "~/lib/webhooks/batches";
import type { WebhookOutcome } from "~/lib/webhooks/process";

// Reconciliation for Foxhound's OWN Stripe invoices (the ones we raise against
// merchants for fees). The platform webhook (/webhooks/stripe-platform)
// resolves the billing_invoices row an event applies to, then commits the
// exactly-once CLAIM and the status update as ONE atomic per-account
// money-write batch, the same folded-claim pattern the connected endpoint uses
// (app/lib/webhooks/batches.ts).

const PLATFORM_STATUS: Record<string, string> = {
  "invoice.finalized": "finalized",
  "invoice.paid": "paid",
  "invoice.payment_failed": "payment_failed",
  "invoice.marked_uncollectible": "uncollectible",
  "invoice.voided": "void",
};

/**
 * Maps a platform Stripe event type to our billing_invoices status (null =
 * ignore). Pure.
 */
function platformBillingStatus(eventType: string): string | null {
  return PLATFORM_STATUS[eventType] ?? null;
}

// Stripe does not deliver events in order, and the missed-event sweep replays
// old ones, so a status only moves FORWARD. paid and void are final: a late
// invoice.finalized or invoice.payment_failed must never move a paid fee
// invoice back to owing. uncollectible (and the charge retry's local gave_up)
// can still be paid or voided. A status missing from this table is not blocked.
const STATUS_RANK: Record<string, number> = {
  draft: 0,
  finalized: 1,
  payment_failed: 2,
  uncollectible: 3,
  gave_up: 3,
  paid: 4,
  void: 4,
};

/**
 * The known statuses an event moving to `status` must not overwrite: its own
 * rank and above. Pure.
 */
function statusesAtOrAbove(status: string): string[] {
  const rank = STATUS_RANK[status] ?? 0;
  return Object.keys(STATUS_RANK).filter((s) => (STATUS_RANK[s] ?? 0) >= rank);
}

/** The billing_invoices row a platform event applies to, plus what to write. */
interface PlatformBillingTarget {
  accountId: string;
  billingInvoiceId: string;
  /**
   * The row's status when resolved, so a stale event is claimed without
   * applying.
   */
  currentStatus: string;
  status: string;
  stripeInvoiceId: string;
  hostedInvoiceUrl: string | null;
}

/**
 * Resolve which billing_invoices row an event applies to. Reads only, so it is
 * safe to run before the claim.
 *
 * Anyone can write billing_invoice_id on an invoice in their own Stripe
 * account, and a merchant can read their own row id at /billing/invoices/:id,
 * so the invoice must also be OURS for that row: billed to the account's
 * platform customer, and the same Stripe invoice the row already names.
 */
async function resolvePlatformBillingTarget(
  env: Env,
  event: Stripe.Event,
): Promise<PlatformBillingTarget | null> {
  const status = platformBillingStatus(event.type);
  if (!status) return null;

  const invoice = event.data.object as Stripe.Invoice;
  const billingInvoiceId = invoice.metadata?.billing_invoice_id ?? null;
  if (!billingInvoiceId || !invoice.id) return null;

  const db = getDb(env);
  const rows = await db
    .select({
      accountId: billingInvoices.accountId,
      status: billingInvoices.status,
      stripeInvoiceId: billingInvoices.stripeInvoiceId,
      platformCustomerId: accounts.platformStripeCustomerId,
    })
    .from(billingInvoices)
    .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
    .where(eq(billingInvoices.id, billingInvoiceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
  if (!row.platformCustomerId || customerId !== row.platformCustomerId) return null;
  if (row.stripeInvoiceId && row.stripeInvoiceId !== invoice.id) return null;

  return {
    accountId: row.accountId,
    billingInvoiceId,
    currentStatus: row.status,
    status,
    stripeInvoiceId: invoice.id,
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
  };
}

/**
 * claim + billing_invoices status update, as ONE atomic batch through the
 * per-account money-write DO. The webhook_events unique index on
 * stripe_event_id is the exactly-once key: a replay fails the claim insert and
 * rolls the whole batch back, so the status is never applied twice.
 *
 * The rank guard is in the UPDATE's own WHERE, so a status that moved on
 * between the resolve read and this commit is left alone, not moved back.
 * finalizedAt is stamped by invoice.finalized only, never by a later event.
 */
function buildPlatformBillingBatch(
  db: Db,
  input: { claim: WebhookClaimInput; target: PlatformBillingTarget; now: Date },
): MoneyWriteBatch {
  const { target } = input;
  return [
    buildWebhookClaim(db, input.claim),
    db
      .update(billingInvoices)
      .set({
        status: target.status,
        stripeInvoiceId: target.stripeInvoiceId,
        stripeInvoiceUrl: target.hostedInvoiceUrl,
        ...(target.status === "finalized" ? { finalizedAt: input.now } : {}),
      })
      .where(
        and(
          eq(billingInvoices.id, target.billingInvoiceId),
          // Never repoint a row at a different Stripe invoice.
          or(
            isNull(billingInvoices.stripeInvoiceId),
            eq(billingInvoices.stripeInvoiceId, target.stripeInvoiceId),
          ),
          notInArray(billingInvoices.status, statusesAtOrAbove(target.status)),
        ),
      ),
  ];
}

/** Process one verified platform event. */
export async function processPlatformWebhook(
  env: Env,
  event: Stripe.Event,
  receivedAt: Date,
): Promise<WebhookOutcome> {
  // A connected account's event has no business here. Ignore it WITHOUT a
  // claim: the claim key is the Stripe event id, shared with the connected
  // endpoint, so claiming here would make that endpoint skip it as a duplicate.
  if (event.account) return { status: "ignored", reason: "connected_account_event" };

  try {
    const target = await resolvePlatformBillingTarget(env, event);

    if (!target) {
      // Nothing to apply, and no account to key a per-account DO on, so the
      // claim is a plain insert. There are no side effects to be atomic with,
      // which is exactly why this case does not need the folded batch.
      const claimed = await claimUnroutableEvent(env, event, receivedAt);
      return claimed
        ? { status: "ignored", reason: "no_billing_invoice" }
        : { status: "duplicate" };
    }

    const claim: WebhookClaimInput = {
      stripeEventId: event.id,
      eventType: event.type,
      // The merchant this fee invoice belongs to. The old separate claim wrote
      // null here because it ran before the row was resolved.
      accountId: target.accountId,
      receivedAt,
      payload: event,
    };
    const idempotencyKey = `platform-webhook:${event.id}`;
    if (statusesAtOrAbove(target.status).includes(target.currentStatus)) {
      // Late or out of order: claim it so a replay short-circuits, apply
      // nothing.
      const { applied } = await executeMoneyWrite(env, {
        accountId: target.accountId,
        idempotencyKey,
        build: (db) => [buildWebhookClaim(db, { ...claim, payload: {} })],
      });
      return applied
        ? { status: "ignored", reason: "status_not_forward" }
        : { status: "duplicate" };
    }

    const { applied } = await executeMoneyWrite(env, {
      accountId: target.accountId,
      idempotencyKey,
      build: (db) => buildPlatformBillingBatch(db, { claim, target, now: receivedAt }),
    });
    return applied ? { status: "applied" } : { status: "duplicate" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : "platform webhook error",
    };
  }
}

/**
 * Claim an event we resolved to no billing_invoices row. Idempotent on the
 * unique index; returns false when it was already claimed.
 */
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
      // Nothing was applied, so the payload (customer name, email, address) is
      // not kept; the id and type are the claim.
      payload: {},
    });
    return true;
  } catch (err) {
    // Only the unique index means "already claimed"; anything else throws so
    // the route 500s and Stripe retries, instead of a 200 that drops the event.
    if (!isUniqueConstraintError(err)) throw err;
    return false;
  }
}
