import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { accountBillingEligibleCondition } from "~/db/billable";
import {
  lineItemIdempotencyKey,
  STRIPE_CHARGEABLE_TYPES,
  type PlatformInvoiceLineInput,
} from "./stripe-invoice";
import { monthKey } from "@dustinedwards/site-runtime/time";

/** A billing_invoices row that has not settled: what the sweep operates on. */
export interface StrandedInvoice {
  id: string;
  accountId: string;
  currency: string;
  status: string;
  stripeInvoiceId: string | null;
  totalCents: number;
  createdAt: Date;
  chargeAttemptCount: number;
  platformCustomerId: string | null;
}

/**
 * Statuses that are already settled: nothing left to collect, ever. Also read
 * by the disputes list's "Fees owed" (app/lib/disputes/fees-owed.server.ts).
 */
export const SETTLED_STATUSES = ["paid", "void", "uncollectible", "gave_up"];

/**
 * Unsettled fee invoices on billing-eligible accounts. Deliberately reuses
 * accountBillingEligibleCondition, so a merchant who became exempt or paused
 * since the invoice was raised stops being chased, matching what the billable
 * queries would do for a new fee.
 *
 * Why that is right:
 *   - The fees were EARNED on recoveries Foxhound delivered before the merchant
 *     canceled. Cancellation is a processing gate by canon, not a debt eraser:
 *     "cancel never silently forgives owed fees" (merchants.server.ts), and
 *     recovery-tick.ts records the same rule from the other side.
 *   - Nothing NEW can accrue after cancellation. accountProcessingEligibleCondition
 *     excludes canceled accounts, so no further recovery is ever created for one,
 *     so no later period can produce a new billable line.
 *   - Collection is bounded, not indefinite: decideFeeRetryAction's attempt and
 *     age caps terminate a canceled account's invoice like any other.
 */
export async function queryStrandedInvoices(env: Env, limit: number): Promise<StrandedInvoice[]> {
  const db = getDb(env);
  return db
    .select({
      id: billingInvoices.id,
      accountId: billingInvoices.accountId,
      currency: billingInvoices.currency,
      status: billingInvoices.status,
      stripeInvoiceId: billingInvoices.stripeInvoiceId,
      totalCents: billingInvoices.totalCents,
      createdAt: billingInvoices.createdAt,
      chargeAttemptCount: billingInvoices.chargeAttemptCount,
      platformCustomerId: accounts.platformStripeCustomerId,
    })
    .from(billingInvoices)
    .innerJoin(accounts, eq(accounts.id, billingInvoices.accountId))
    .where(
      and(
        notInArray(billingInvoices.status, SETTLED_STATUSES),
        accountBillingEligibleCondition(),
        // A zero-total invoice has nothing chargeable and would only ever make
        // createPlatformInvoice throw its no-chargeable-lines guard.
        sql`${billingInvoices.totalCents} > 0`,
        // An invoice holding only adjustments (an admin's manual entry) has no
        // line Stripe is ever sent; sweeping it would only fail it monthly.
        sql`exists (select 1 from ${billingLineItems} where ${billingLineItems.invoiceId} = ${billingInvoices.id} and ${billingLineItems.amountCents} > 0 and ${inArray(billingLineItems.type, [...STRIPE_CHARGEABLE_TYPES])})`,
      ),
    )
    .limit(limit);
}

/**
 * Rebuild the Stripe line inputs for an existing invoice from its committed
 * line items, so a retry reproduces the SAME per-line idempotency keys the
 * original attempt would have used. Deriving them from the ledger rather than
 * recomputing from the billable queries is the point: the billable queries
 * exclude already-billed rows, so they return nothing on a retry.
 */
function linesFromLineItems(
  rows: {
    id: string;
    type: string;
    amountCents: number;
    description: string | null;
    recoveredPaymentId: string | null;
    disputeId: string | null;
  }[],
  ctx: { accountId: string; periodKey: string; currency: string },
): PlatformInvoiceLineInput[] {
  return rows.map((row) => ({
    type: row.type,
    amountCents: row.amountCents,
    description: row.description ?? row.type,
    idempotencyKey: lineItemIdempotencyKey(row, ctx),
  }));
}

export async function loadLines(
  env: Env,
  invoiceId: string,
): Promise<{ lines: PlatformInvoiceLineInput[]; periodStart: Date | null }> {
  const db = getDb(env);
  const [invoice] = await db
    .select({
      accountId: billingInvoices.accountId,
      currency: billingInvoices.currency,
      periodStart: billingInvoices.periodStart,
    })
    .from(billingInvoices)
    .where(eq(billingInvoices.id, invoiceId))
    .limit(1);
  if (!invoice) return { lines: [], periodStart: null };
  const rows = await db
    .select({
      id: billingLineItems.id,
      type: billingLineItems.type,
      amountCents: billingLineItems.amountCents,
      description: billingLineItems.description,
      recoveredPaymentId: billingLineItems.recoveredPaymentId,
      disputeId: billingLineItems.disputeId,
    })
    .from(billingLineItems)
    .where(eq(billingLineItems.invoiceId, invoiceId));
  const lines = linesFromLineItems(rows, {
    accountId: invoice.accountId,
    // The same key buildBillingInvoiceBatch used when it first derived the line
    // keys.
    periodKey: monthKey(invoice.periodStart),
    currency: invoice.currency,
  });
  return { lines, periodStart: invoice.periodStart };
}
