import { and, eq, notInArray, sql } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { accountBillingEligibleCondition } from "~/db/billable";
import { decideFeeRetryAction, billingStatusForSettledStripeStatus } from "./fee-retry";
import { lookupPlatformBillingEmail } from "./platform-customer";
import {
  createPlatformInvoice,
  finalizePlatformInvoice,
  findPlatformInvoiceByBillingId,
  lineItemIdempotencyKey,
  payPlatformInvoice,
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

/** Statuses that are already settled: nothing left to collect, ever. Also read
 *  by the disputes list's "Fees owed" (app/lib/disputes/fees-owed.server.ts). */
export const SETTLED_STATUSES = ["paid", "void", "uncollectible", "gave_up"];

/**
 * Unsettled fee invoices on billing-eligible accounts. Deliberately reuses
 * accountBillingEligibleCondition, so a merchant who became exempt or paused
 * since the invoice was raised stops being chased, matching what the billable
 * queries would do for a new fee.
 *
 * CANCELLED ACCOUNTS ARE STILL COLLECTED FROM, AND THAT IS THE DECISION, NOT AN
 * OVERSIGHT (review MEDIUM-3, ruled 2026-07-26). accountBillingEligibleCondition
 * does not check cancelledAt, so a cancelled account with an unsettled invoice is
 * selected here and charged, and the emergency brake has no lever over it,
 * because the brake deliberately skips cancelled accounts.
 *
 * Why that is right:
 *   - The fees were EARNED on recoveries Foxhound delivered before the merchant
 *     cancelled. Cancellation is a processing gate by canon, not a debt eraser:
 *     "cancel never silently forgives owed fees" (merchants.server.ts), and
 *     recovery-tick.ts records the same rule from the other side.
 *   - Nothing NEW can accrue after cancellation. accountProcessingEligibleCondition
 *     excludes cancelled accounts, so no further recovery is ever created for one,
 *     so no later period can produce a new billable line.
 *   - Collection is bounded, not indefinite: decideFeeRetryAction's attempt and
 *     age caps terminate a cancelled account's invoice like any other.
 *
 * The two halves have to hold together. Letting the brake pause cancelled
 * accounts instead would flip this predicate false and defer exactly the
 * pre-cancellation fees this paragraph says are owed, for as long as the brake
 * stayed engaged. test/billing-charge-retry.test.ts pins both directions.
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
      id: billingLineItems.id,
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

/** Whether an account may still be charged, as of right now. */
export interface ChargeGuard {
  billingEligible: boolean;
}

/**
 * Re-read the billing gate for ONE account, fresh.
 *
 * queryStrandedInvoices applies accountBillingEligibleCondition once, in its
 * select, and then the sweep loops up to 200 rows charging each. That is the
 * same select-then-loop shape the recovery tick had before its mid-run guard:
 * an operator who engaged the emergency brake mid-sweep stopped nothing already
 * selected, while retryInvoiceCharge kept reaching Stripe and charging the
 * merchant's saved payment method for Foxhound's fee. Discharge review MEDIUM-A.
 *
 * It matters most on the one day it is least forgiving: this sweep runs inside
 * runMonthlyBilling, whose first ever execution is 2026-08-01 and is a
 * supervised event, which is exactly when someone reaches for the brake.
 *
 * Deliberately the SAME predicate the select uses, re-evaluated, so the two can
 * never disagree about what eligible means.
 */
async function checkChargeGuard(env: Env, accountId: string): Promise<ChargeGuard> {
  const db = getDb(env);
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), accountBillingEligibleCondition()))
    .limit(1);
  return { billingEligible: rows.length > 0 };
}

/**
 * A guard READ that failed, as distinct from a charge that failed.
 *
 * The sweep catches per-invoice errors and continues to the next invoice, which
 * is right for a charge: one merchant's Stripe failure must not stop the others.
 * It is wrong for a guard read. "I cannot tell whether the brake is engaged" is
 * not a per-invoice problem, and continuing past it on a sweep that collects
 * from saved cards is fail-open.
 *
 * The loop-level guard sits outside the try and needs no help. The two
 * PRE-CHARGE guards do: they run inside retryInvoiceCharge, which the sweep
 * calls inside its try, so a throw there was caught, recorded as
 * `outcome: "failed"`, and the sweep carried on (review LOW-2). The comment on
 * the loop-level check claimed fail-closed for all of them; this is what makes
 * that claim true rather than narrowing it.
 */
export class ChargeGuardReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "billing guard read failed");
    this.name = "ChargeGuardReadError";
    this.cause = cause;
  }
}

/** Injectable Stripe seams, so the sweep is testable without a network call. */
export interface ChargeRetryDeps {
  findExisting: typeof findPlatformInvoiceByBillingId;
  create: typeof createPlatformInvoice;
  finalize: typeof finalizePlatformInvoice;
  pay: typeof payPlatformInvoice;
  /** Re-read the billing gate. Default: the real per-account read. */
  checkGuard: (env: Env, accountId: string) => Promise<ChargeGuard>;
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
  const finalize = deps.finalize ?? finalizePlatformInvoice;
  const pay = deps.pay ?? payPlatformInvoice;
  const checkGuard = deps.checkGuard ?? checkChargeGuard;
  const now = new Date(nowMs);

  /** Fresh gate read placed immediately before a money-moving Stripe call, so
   *  the window between the sweep's loop-level check and the charge itself is
   *  closed rather than merely narrow. Returns a skipped result the caller can
   *  hand straight back: nothing is written, so the invoice survives untouched
   *  to the next sweep. */
  const blockedByGuard = async (): Promise<SweepResult | null> => {
    let billingEligible: boolean;
    try {
      ({ billingEligible } = await checkGuard(env, invoice.accountId));
    } catch (err) {
      // Rethrown as a distinct type so the sweep's per-invoice catch can let it
      // through instead of swallowing it into `outcome: "failed"`.
      throw new ChargeGuardReadError(err);
    }
    if (billingEligible) return null;
    return {
      invoiceId: invoice.id,
      outcome: "skipped",
      reason: "account_not_billing_eligible",
    };
  };

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
    // Immediately before the charge, after the line-items read. `create` both
    // creates AND collects, so this is a money-moving call.
    const blockedBeforeCreate = await blockedByGuard();
    if (blockedBeforeCreate) return blockedBeforeCreate;
    let created;
    try {
      created = await create(env, {
        platformCustomerId: invoice.platformCustomerId,
        // Passed explicitly, and asserted by a plant. Stripe bills a
        // multi-currency customer in a second currency only when `currency` is
        // set on the invoice AND on every invoice item, and this is the value
        // that reaches both (ruling 377(6)).
        currency: invoice.currency,
        lines,
        billingInvoiceId: invoice.id,
        billingEmail: () => lookupPlatformBillingEmail(env, invoice.accountId),
      });
    } catch (err) {
      // COUNT THE ATTEMPT EVEN THOUGH THE STRIPE CALL FAILED (ruling 377(6)).
      //
      // The pay path below has always done this; the CREATE path did not, so a
      // throw here propagated to the sweep's per-invoice catch with nothing
      // written. charge_attempt_count never moved, decideFeeRetryAction's
      // attempt cap was therefore unreachable on this branch, and an invoice
      // whose create fails permanently was retried every month until the AGE
      // cap eventually stopped it. Recording the attempt is what makes the cap
      // reachable at all.
      //
      // NO ChargeGuardReadError RETHROW HERE, deliberately. The obvious guard
      // is to let a guard-read failure through rather than count it as a charge
      // attempt, and one was written. A plant proved it UNREACHABLE: the gate is
      // read by blockedByGuard ABOVE this try, so its throw never enters this
      // catch, and `create` cannot raise that type. It was removed rather than
      // kept as unfalsifiable defence. The propagation itself is still asserted,
      // by the test that makes checkGuard throw.
      await writeAttempt(env, invoice, {
        status: "payment_failed",
        stripeInvoiceId: null,
        hostedInvoiceUrl: null,
        attemptCount,
        now,
      });
      return {
        invoiceId: invoice.id,
        outcome: "failed",
        reason: err instanceof Error ? err.message : "charge create failed",
      };
    }
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
  const stripeInvoiceId = existing.id as string;

  // The SECOND money-moving path, and the one the follow-up task did not name:
  // payPlatformInvoice collects on an existing Stripe invoice. Guarding only the
  // create branch would have left the more common retry path unguarded.
  const blockedBeforePay = await blockedByGuard();
  if (blockedBeforePay) return blockedBeforePay;

  try {
    // A Stripe DRAFT cannot be paid, it has to be finalized first. This is the
    // "createPlatformInvoice threw on its own finalize" stranding: Stripe holds
    // the draft with the items already attached. Before this branch existed the
    // sweep called invoices.pay on it every month, Stripe rejected it, the throw
    // skipped writeAttempt entirely so the attempt cap could never bind, and the
    // invoice was never collected (review MEDIUM-1). The two meanings of "draft"
    // are now separated: the sentinel above means Stripe has NO invoice, this
    // means Stripe has a real unfinalized one.
    if (liveStatus === "draft") {
      await finalize(env, stripeInvoiceId, invoice.id, {
        sendByEmail: existing.collection_method === "send_invoice",
      });
    }
    const paid = await pay(env, stripeInvoiceId, attemptCount);
    await writeAttempt(env, invoice, {
      status: billingStatusForSettledStripeStatus(paid.status ?? "") ?? "payment_failed",
      stripeInvoiceId: paid.id ?? stripeInvoiceId,
      hostedInvoiceUrl: paid.hosted_invoice_url ?? existing.hosted_invoice_url ?? null,
      attemptCount,
      now,
    });
    return { invoiceId: invoice.id, outcome: "retried", reason: decision.reason };
  } catch (err) {
    // Count the attempt even though the Stripe call failed, so a permanently
    // failing invoice reaches the attempt cap instead of being retried monthly
    // until the age cap. Recording it is what makes the cap reachable at all.
    await writeAttempt(env, invoice, {
      status: "payment_failed",
      stripeInvoiceId,
      hostedInvoiceUrl: existing.hosted_invoice_url ?? null,
      attemptCount,
      now,
    });
    return {
      invoiceId: invoice.id,
      outcome: "failed",
      reason: err instanceof Error ? err.message : "charge attempt failed",
    };
  }
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
  const checkGuard = opts.deps?.checkGuard ?? checkChargeGuard;
  const results: SweepResult[] = [];
  for (const invoice of stranded) {
    // OUTSIDE the per-invoice try/catch, on purpose, exactly like the recovery
    // tick's guard. If we cannot read whether the brake is engaged we do not
    // know whether it is safe to charge, and on a sweep that collects from a
    // merchant's saved card the safe answer to "I cannot tell" is to stop the
    // whole sweep. A caught-and-continued guard failure would be fail-open.
    //
    // Being outside the try is what makes THIS read fail closed. The two
    // pre-charge reads inside retryInvoiceCharge cannot be hoisted out here (they
    // exist precisely to run later, immediately before the Stripe call), so they
    // throw ChargeGuardReadError and the catch below rethrows it. Both routes end
    // at the same place: an unreadable guard stops the sweep.
    const guard = await checkGuard(env, invoice.accountId);
    if (!guard.billingEligible) {
      // Skipped, never failed: nothing went wrong and nothing was written, so
      // the invoice is untouched and the next sweep picks it up.
      results.push({
        invoiceId: invoice.id,
        outcome: "skipped",
        reason: "account_not_billing_eligible",
      });
      continue;
    }
    try {
      results.push(await retryInvoiceCharge(env, invoice, nowMs, opts.deps));
    } catch (err) {
      // A guard read that failed is not this invoice's problem, it is the
      // sweep's. Fail closed rather than recording it as one failed invoice and
      // charging the next merchant's card.
      if (err instanceof ChargeGuardReadError) throw err;
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
