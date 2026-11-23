import { and, eq, inArray, notInArray, sql } from "drizzle-orm";

import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { accountBillingEligibleCondition } from "~/db/billable";
import { PLATFORM_CHARGES_ENABLED } from "./charges-switch";
import { decideFeeRetryAction, billingStatusForSettledStripeStatus } from "./fee-retry";
import {
  buildPlatformCustomerUpdate,
  ensurePlatformCustomer,
  lookupPlatformBillingEmail,
} from "./platform-customer";
import {
  chargeableLines,
  createPlatformInvoice,
  finalizePlatformInvoice,
  findPlatformInvoiceByBillingId,
  lineItemIdempotencyKey,
  payPlatformInvoice,
  STRIPE_CHARGEABLE_TYPES,
  STRIPE_SETTLED_STATUSES,
  type PlatformInvoiceLineInput,
} from "./stripe-invoice";
import { monthKey } from "@dustinedwards/site-runtime/time";
import { errorMessage } from "@dustinedwards/site-runtime/log";

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

async function loadLines(
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

type SweepOutcome = "charged" | "adopted" | "retried" | "gave_up" | "skipped" | "failed";

export interface SweepResult {
  invoiceId: string;
  outcome: SweepOutcome;
  reason: string;
}

/** Whether an account may still be charged, as of right now. */
interface ChargeGuard {
  billingEligible: boolean;
}

/**
 * Re-read the billing gate for ONE account, fresh.
 *
 * That is the same select-then-loop shape the recovery tick had before its
 * mid-run guard: an operator who engaged the emergency brake mid-sweep stopped
 * nothing already selected, while retryInvoiceCharge kept reaching Stripe and
 * charging the merchant's saved payment method for Foxhound's fee.
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
 * is right for a charge: one merchant's Stripe failure must not stop the
 * others. "I cannot tell whether the brake is engaged" is not a per-invoice
 * problem, and continuing past it on a sweep that collects from saved cards is
 * fail-open.
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
  /**
   * Make a platform customer for an account with none. Default: the real one.
   */
  ensureCustomer: (env: Env, accountId: string) => Promise<string>;
}

/**
 * Create an account's platform customer at Stripe. Does not persist: the caller
 * stores the id through the SAME money write the billing setup action and the
 * billing run use (same builder, same key).
 */
async function makePlatformCustomer(env: Env, accountId: string): Promise<string> {
  const [row] = await getDb(env)
    .select({ name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  const customerId = await ensurePlatformCustomer(env, {
    existingCustomerId: null,
    accountId,
    accountName: row?.name ?? null,
  });
  return customerId;
}

/**
 * Settle one stranded invoice.
 *
 * Only when Stripe genuinely has no invoice for this billing_invoices id do we
 * make one. After that the live Stripe status drives decideFeeRetryAction, so a
 * row that is locally stale because a webhook was lost is corrected rather than
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

  /**
   * Fresh gate read placed immediately before a money-moving Stripe call, so
   * the window between the sweep's loop-level check and the charge itself is
   * closed rather than merely narrow. Returns a skipped result the caller can
   * hand straight back: nothing is written, so the invoice survives untouched
   * to the next sweep.
   */
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

  let platformCustomerId = invoice.platformCustomerId;
  if (!platformCustomerId) {
    const ensureCustomer = deps.ensureCustomer ?? makePlatformCustomer;
    try {
      const customerId = await ensureCustomer(env, invoice.accountId);
      await executeMoneyWrite(env, {
        accountId: invoice.accountId,
        idempotencyKey: `platform-customer:${invoice.accountId}`,
        build: (db) =>
          buildPlatformCustomerUpdate(db, {
            accountId: invoice.accountId,
            platformStripeCustomerId: customerId,
          }),
      });
      platformCustomerId = customerId;
    } catch (err) {
      console.error(
        `platform customer create failed for billing invoice ${invoice.id}:`,
        errorMessage(err),
      );
      return { invoiceId: invoice.id, outcome: "skipped", reason: "no_platform_customer" };
    }
  }

  const existing = await findExisting(env, invoice.id);

  if (!existing) {
    const attemptCount = invoice.chargeAttemptCount + 1;
    const decision = decideFeeRetryAction({
      // No live status to read: "draft" routes it through the caps, which bound a create that keeps failing.
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

    const { lines, periodStart } = await loadLines(env, invoice.id);
    if (lines.length === 0 || !periodStart) {
      return { invoiceId: invoice.id, outcome: "skipped", reason: "no_line_items" };
    }
    // Immediately before the charge, after the line-items read. `create` both
    // creates AND collects, so this is a money-moving call.
    const blockedBeforeCreate = await blockedByGuard();
    if (blockedBeforeCreate) return blockedBeforeCreate;
    let created;
    try {
      created = await create(env, {
        platformCustomerId,
        // Passed explicitly, and asserted by a plant. Stripe bills a
        // multi-currency customer in a second currency only when `currency` is
        // set on the invoice AND on every invoice item, and this is the value
        // that reaches both.
        currency: invoice.currency,
        lines,
        billingInvoiceId: invoice.id,
        periodStart,
        billingEmail: () => lookupPlatformBillingEmail(env, invoice.accountId),
      });
    } catch (err) {
      // COUNT THE ATTEMPT EVEN THOUGH THE STRIPE CALL FAILED, as the pay path does: otherwise
      // charge_attempt_count never moves and the attempt cap is unreachable on this branch.
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

  // A draft is finalized only when its items add up to the chargeable lines we hold: createPlatformInvoice
  // attaches them one by one, and a throw midway leaves some. Re-attaching could double-bill (item keys
  // expire in 24 hours, the sweep runs monthly), so the draft is left for review.
  if (liveStatus === "draft") {
    const { lines } = await loadLines(env, invoice.id);
    if (existing.total !== chargeableLines(lines).reduce((sum, l) => sum + l.amountCents, 0)) {
      return { invoiceId: invoice.id, outcome: "skipped", reason: "draft_lines_incomplete" };
    }
  }

  // AN EMAILED INVOICE IS NEVER CHARGED BY THE SWEEP. Writes go through
  // writeAttempt, the sweep's one money write, with the attempt count
  // unchanged.
  if (existing.collection_method === "send_invoice") {
    return settleEmailedInvoice(env, invoice, existing, liveStatus, finalize, blockedByGuard, now);
  }
  const decision = decideFeeRetryAction({
    invoiceStatus: liveStatus,
    attemptCount: invoice.chargeAttemptCount,
    invoiceCreatedMs: invoice.createdAt.getTime(),
    nowMs,
  });

  if (decision.action === "sync_paid" || decision.action === "give_up") {
    // Either Stripe already settled this (mode 2: the charge landed, our
    // follow-up write did not) or it is terminal. Both are a local status
    // write, never another charge.
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

  // The second money-moving path: payPlatformInvoice collects on an existing Stripe invoice.
  if (liveStatus === "draft") {
  }
  const blockedBeforePay = await blockedByGuard();
  if (blockedBeforePay) return blockedBeforePay;

  try {
    // A Stripe DRAFT cannot be paid, it has to be finalized first (createPlatformInvoice threw on its own finalize).
    if (liveStatus === "draft") {
      await finalize(env, stripeInvoiceId, invoice.id);
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
    // Counted although the Stripe call failed, so a permanently failing invoice reaches the attempt cap.
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

async function settleEmailedInvoice(
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
 * never aborts the rest, matching runMonthlyBilling's own per-account
 * isolation.
 */
export async function runChargeRetrySweep(
  env: Env,
  nowMs: number,
  opts: { limit?: number; deps?: Partial<ChargeRetryDeps> } = {},
): Promise<SweepResult[]> {
  if (!PLATFORM_CHARGES_ENABLED) return [];
  const stranded = await queryStrandedInvoices(env, opts.limit ?? 200);
  const checkGuard = opts.deps?.checkGuard ?? checkChargeGuard;
  const results: SweepResult[] = [];
  for (const invoice of stranded) {
    // OUTSIDE the per-invoice try/catch, on purpose, exactly like the recovery
    // tick's guard. If we cannot read whether the brake is engaged we do not
    // know whether it is safe to charge, and on a sweep that collects from a
    // merchant's saved card the safe answer to "I cannot tell" is to stop the
    // whole sweep.
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
      console.error(`charge retry failed for billing invoice ${invoice.id}:`, errorMessage(err));
    }
  }
  return results;
}
