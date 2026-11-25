import { and, eq, notInArray } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { billingInvoices } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import type { ChargeRetryDeps, SweepResult } from "./charge-retry";
import { billingStatusForSettledStripeStatus } from "./fee-retry";
import { STRIPE_SETTLED_STATUSES } from "./stripe-invoice";
import type { StrandedInvoice } from "./stranded-invoices";

/** The money-write recording one charge attempt and whatever it resolved to. */
function buildChargeAttemptUpdate(
  db: Db,
  input: {
    billingInvoiceId: string;
    status: string;
    stripeInvoiceId: string | null;
    hostedInvoiceUrl: string | null;
    attemptCount: number;
    now: Date;
  },
): MoneyWriteBatch {
  return [
    db
      .update(billingInvoices)
      .set({
        status: input.status,
        stripeInvoiceId: input.stripeInvoiceId,
        stripeInvoiceUrl: input.hostedInvoiceUrl,
        chargeAttemptCount: input.attemptCount,
        lastChargeAttemptAt: input.now,
      })
      .where(
        and(
          eq(billingInvoices.id, input.billingInvoiceId),
          notInArray(billingInvoices.status, STRIPE_SETTLED_STATUSES),
        ),
      ),
  ];
}

export async function settleEmailedInvoice(
  env: Env,
  invoice: StrandedInvoice,
  existing: { id?: string; hosted_invoice_url?: string | null },
  liveStatus: string,
  finalize: ChargeRetryDeps["finalize"],
  blockedByGuard: () => Promise<SweepResult | null>,
  now: Date,
): Promise<SweepResult> {
  const stripeInvoiceId = existing.id as string;
  const settled = billingStatusForSettledStripeStatus(liveStatus);
  if (settled) {
    await writeAttempt(env, invoice, {
      status: settled,
      stripeInvoiceId,
      hostedInvoiceUrl: existing.hosted_invoice_url ?? null,
      attemptCount: invoice.chargeAttemptCount,
      now,
    });
    return {
      invoiceId: invoice.id,
      outcome: settled === "paid" ? "adopted" : "gave_up",
      reason: `stripe_status_${liveStatus}`,
    };
  }

  if (liveStatus === "draft") {
    const blocked = await blockedByGuard();
    if (blocked) return blocked;
    try {
      const finalized = await finalize(env, stripeInvoiceId, invoice.id);
      await writeAttempt(env, invoice, {
        status: "finalized",
        stripeInvoiceId,
        hostedInvoiceUrl: finalized.hosted_invoice_url ?? existing.hosted_invoice_url ?? null,
        attemptCount: invoice.chargeAttemptCount,
        now,
      });
      return { invoiceId: invoice.id, outcome: "retried", reason: "emailed_invoice_finalized" };
    } catch (err) {
      // Counted, so a finalize that keeps failing reaches the cap; the row
      // stays draft rather than reading "Payment failed" for an invoice never
      // sent.
      await writeAttempt(env, invoice, {
        status: "draft",
        stripeInvoiceId,
        hostedInvoiceUrl: existing.hosted_invoice_url ?? null,
        attemptCount: invoice.chargeAttemptCount + 1,
        now,
      });
      return {
        invoiceId: invoice.id,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "emailed invoice finalize failed",
      };
    }
  }

  // Open at Stripe and waiting on the merchant. Record the Stripe reference if
  // our row lost it (mode 2), otherwise write nothing.
  if (invoice.stripeInvoiceId !== stripeInvoiceId || invoice.status !== "finalized") {
    await writeAttempt(env, invoice, {
      status: "finalized",
      stripeInvoiceId,
      hostedInvoiceUrl: existing.hosted_invoice_url ?? null,
      attemptCount: invoice.chargeAttemptCount,
      now,
    });
  }
  return { invoiceId: invoice.id, outcome: "skipped", reason: "emailed_invoice_awaiting_payment" };
}

export function writeAttempt(
  env: Env,
  invoice: StrandedInvoice,
  input: {
    status: string;
    stripeInvoiceId: string | null;
    hostedInvoiceUrl: string | null;
    attemptCount: number;
    now: Date;
  },
): Promise<unknown> {
  return executeMoneyWrite(env, {
    accountId: invoice.accountId,
    // Per attempt, so a genuine second attempt is not swallowed by the DO's
    // idempotency fast path while a redelivered single attempt still is.
    idempotencyKey: `charge-retry:${invoice.id}:${input.attemptCount}:${input.status}`,
    build: (db) =>
      buildChargeAttemptUpdate(db, {
        billingInvoiceId: invoice.id,
        status: input.status,
        stripeInvoiceId: input.stripeInvoiceId,
        hostedInvoiceUrl: input.hostedInvoiceUrl,
        attemptCount: input.attemptCount,
        now: input.now,
      }),
  });
}
