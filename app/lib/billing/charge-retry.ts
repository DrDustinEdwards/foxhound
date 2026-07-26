import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { accountBillingEligibleCondition } from "~/db/billable";
import { decideFeeRetryAction, billingStatusForSettledStripeStatus } from "./fee-retry";
import {
  createPlatformInvoice,
  disputeFeeItemIdempotencyKey,
  findPlatformInvoiceByBillingId,
  payPlatformInvoice,
  recoveryFeeItemIdempotencyKey,
  type PlatformInvoiceLineInput,
} from "./stripe-invoice";

// The charge-dispatch retry sweep: the thing that makes a committed
// billing_invoices row whose charge never landed recoverable instead of
// permanently stranded. It runs at the START of runMonthlyBilling, before the
// new period is billed, so a merchant's outstanding fee is settled before
// another one is raised on top of it.
//
// The stranding it fixes has two modes, both recorded in review-findings.md:
//   1. createPlatformInvoice threw. Our ledger row committed, Stripe has
//      nothing, and the invoice-level idempotency key means the next monthly
//      run cannot re-bill the period: the key collides and the whole batch
//      rolls back. Nothing ever retried, so the fee was simply never collected.
//   2. createPlatformInvoice SUCCEEDED and the follow-up ref-update write
//      failed. Stripe charged the merchant; our row still says draft with no
//      stripe_invoice_id. Money moved with no local evidence linking it.
//
// Mode 2 is why this sweep looks Stripe up by metadata before creating anything.
// A key-only retry would be correct within 24 hours and a DOUBLE CHARGE at the
// monthly cadence this actually runs at, because Stripe expires idempotency keys
// after a day. See findPlatformInvoiceByBillingId.
//
// Money-path shape: the Stripe calls are external and therefore cannot live
// inside a DO batch. Every WRITE the sweep makes is a separate money-write after
// the corresponding Stripe call has returned, exactly like runAccountBilling's
// own charge step, and a failure on one invoice never aborts the others.

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

/** Statuses that are already settled: nothing left to collect, ever. */
const SETTLED_STATUSES = ["paid", "void", "uncollectible", "gave_up"];

/**
 * Unsettled fee invoices on billing-eligible accounts. Deliberately reuses
 * accountBillingEligibleCondition, so a merchant who became exempt or paused
 * since the invoice was raised stops being chased, matching what the billable
 * queries would do for a new fee.
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
      ),
    )
    .limit(limit);
}

/** Rebuild the Stripe line inputs for an existing invoice from its committed
 *  line items, so a retry reproduces the SAME per-line idempotency keys the
 *  original attempt would have used. Deriving them from the ledger rather than
 *  recomputing from the billable queries is the point: the billable queries
 *  exclude already-billed rows, so they return nothing on a retry. */
export function linesFromLineItems(
  rows: {
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
    idempotencyKey: row.disputeId
      ? disputeFeeItemIdempotencyKey(row.disputeId)
      : recoveryFeeItemIdempotencyKey(
          ctx.accountId,
          ctx.periodKey,
          ctx.currency,
          row.recoveredPaymentId ?? row.type,
        ),
  }));
}

/** YYYY-MM of an invoice's billing period, the same key buildBillingInvoiceBatch
 *  used when it first derived the line keys. */
export function periodKeyOf(periodStart: Date): string {
  return `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function loadLines(env: Env, invoiceId: string): Promise<PlatformInvoiceLineInput[]> {
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
  if (!invoice) return [];
  const rows = await db
    .select({
      type: billingLineItems.type,
      amountCents: billingLineItems.amountCents,
      description: billingLineItems.description,
      recoveredPaymentId: billingLineItems.recoveredPaymentId,
      disputeId: billingLineItems.disputeId,
    })
    .from(billingLineItems)
    .where(eq(billingLineItems.invoiceId, invoiceId));
  return linesFromLineItems(rows, {
    accountId: invoice.accountId,
    periodKey: periodKeyOf(invoice.periodStart),
    currency: invoice.currency,
  });
}

/** The money-write recording one charge attempt and whatever it resolved to. */
export function buildChargeAttemptUpdate(
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
      .where(eq(billingInvoices.id, input.billingInvoiceId)),
  ];
}

export type SweepOutcome = "charged" | "adopted" | "retried" | "gave_up" | "skipped" | "failed";

export interface SweepResult {
  invoiceId: string;
  outcome: SweepOutcome;
  reason: string;
}

/** Injectable Stripe seams, so the sweep is testable without a network call. */
export interface ChargeRetryDeps {
  findExisting: typeof findPlatformInvoiceByBillingId;
  create: typeof createPlatformInvoice;
  pay: typeof payPlatformInvoice;
}

/**
 * Settle one stranded invoice.
 *
 * Order matters and is the safety property: LOOK UP before CREATE, always. Only
 * when Stripe genuinely has no invoice for this billing_invoices id do we make
 * one. After that the live Stripe status drives decideFeeRetryAction, so a row
 * that is locally stale because a webhook was lost is corrected rather than
 * re-charged.
 */
export async function retryInvoiceCharge(
  env: Env,
  invoice: StrandedInvoice,
  nowMs: number,
  deps: Partial<ChargeRetryDeps> = {},
): Promise<SweepResult> {
  const findExisting = deps.findExisting ?? findPlatformInvoiceByBillingId;
  const create = deps.create ?? createPlatformInvoice;
  const pay = deps.pay ?? payPlatformInvoice;
  const now = new Date(nowMs);

  if (!invoice.platformCustomerId) {
    // Same guard runAccountBilling applies: never charge without a stored
    // platform customer id. Not a failure, just not chargeable yet.
    return { invoiceId: invoice.id, outcome: "skipped", reason: "no_platform_customer" };
  }

  const existing = await findExisting(env, invoice.id);

  if (!existing) {
    const attemptCount = invoice.chargeAttemptCount + 1;
    const decision = decideFeeRetryAction({
      // No Stripe invoice exists, so there is no live status to read. "draft"
      // routes it through the caps, which is what should bound a create that
      // keeps failing.
      invoiceStatus: "draft",
      attemptCount: invoice.chargeAttemptCount,
      invoiceCreatedMs: invoice.createdAt.getTime(),
      nowMs,
    });
    if (decision.action === "give_up") {
      await writeAttempt(env, invoice, {
        status: "gave_up",
        stripeInvoiceId: null,
        hostedInvoiceUrl: null,
        attemptCount: invoice.chargeAttemptCount,
        now,
      });
      return { invoiceId: invoice.id, outcome: "gave_up", reason: decision.reason };
    }

    const lines = await loadLines(env, invoice.id);
    if (lines.length === 0) {
      return { invoiceId: invoice.id, outcome: "skipped", reason: "no_line_items" };
    }
    const created = await create(env, {
      platformCustomerId: invoice.platformCustomerId,
      currency: invoice.currency,
      lines,
      billingInvoiceId: invoice.id,
    });
    await writeAttempt(env, invoice, {
      status: "finalized",
      stripeInvoiceId: created.stripeInvoiceId,
      hostedInvoiceUrl: created.hostedInvoiceUrl,
      attemptCount,
      now,
    });
    return { invoiceId: invoice.id, outcome: "charged", reason: "created" };
  }

  const liveStatus = existing.status ?? "open";
  const decision = decideFeeRetryAction({
    invoiceStatus: liveStatus,
    attemptCount: invoice.chargeAttemptCount,
    invoiceCreatedMs: invoice.createdAt.getTime(),
    nowMs,
  });

  if (decision.action === "sync_paid" || decision.action === "give_up") {
    // Either Stripe already settled this (mode 2: the charge landed, our
    // follow-up write did not) or it is terminal. Both are a local status write,
    // never another charge.
    const settled = billingStatusForSettledStripeStatus(liveStatus);
    await writeAttempt(env, invoice, {
      status: settled ?? "gave_up",
      stripeInvoiceId: existing.id ?? invoice.stripeInvoiceId,
      hostedInvoiceUrl: existing.hosted_invoice_url ?? null,
      attemptCount: invoice.chargeAttemptCount,
      now,
    });
    return {
      invoiceId: invoice.id,
      outcome: decision.action === "sync_paid" ? "adopted" : "gave_up",
      reason: decision.reason,
    };
  }

  const attemptCount = invoice.chargeAttemptCount + 1;
  const paid = await pay(env, existing.id as string, attemptCount);
  await writeAttempt(env, invoice, {
    status: billingStatusForSettledStripeStatus(paid.status ?? "") ?? "payment_failed",
    stripeInvoiceId: paid.id ?? existing.id ?? null,
    hostedInvoiceUrl: paid.hosted_invoice_url ?? existing.hosted_invoice_url ?? null,
    attemptCount,
    now,
  });
  return { invoiceId: invoice.id, outcome: "retried", reason: decision.reason };
}

function writeAttempt(
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

/**
 * The whole sweep. Runs before the new period is billed. One invoice's failure
 * never aborts the rest, matching runMonthlyBilling's own per-account isolation.
 */
export async function runChargeRetrySweep(
  env: Env,
  nowMs: number,
  opts: { limit?: number; deps?: Partial<ChargeRetryDeps> } = {},
): Promise<SweepResult[]> {
  const stranded = await queryStrandedInvoices(env, opts.limit ?? 200);
  const results: SweepResult[] = [];
  for (const invoice of stranded) {
    try {
      results.push(await retryInvoiceCharge(env, invoice, nowMs, opts.deps));
    } catch (err) {
      results.push({
        invoiceId: invoice.id,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "charge retry failed",
      });
      console.error(
        `charge retry failed for billing invoice ${invoice.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return results;
}
