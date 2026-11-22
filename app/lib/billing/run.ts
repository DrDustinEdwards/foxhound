import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  accountBillingEligibleCondition,
  buildGuardedRecoveryLineInsert,
  buildInvoiceTotalFromLines,
  getBillableDisputes,
  getBillableRecoveries,
} from "~/db/billable";
import type { Db, MoneyWriteBatch } from "~/db";
import { accounts, billingInvoices, billingLineItems, getDb } from "~/db";
import { executeMoneyWrite } from "~/lib/money/execute";

import { PLATFORM_CHARGES_ENABLED } from "./charges-switch";
import { ChargeGuardReadError, runChargeRetrySweep, type ChargeRetryDeps } from "./charge-retry";
import { feeForCurrency, recoveryFeeCents, unrefundedCents } from "./fees";
import {
  buildPlatformCustomerUpdate,
  ensurePlatformCustomer,
  lookupPlatformBillingEmail,
} from "./platform-customer";
import {
  createPlatformInvoice,
  buildInvoiceStripeRefUpdate,
  chargeableLines,
  disputeFeeItemIdempotencyKey,
  lineItemIdempotencyKey,
  recoveryFeeItemIdempotencyKey,
  type PlatformInvoiceLineInput,
} from "./stripe-invoice";

import { errorMessage } from "@dustinedwards/site-runtime/log";
import { monthKey } from "@dustinedwards/site-runtime/time";
// The monthly billing run (PRICING.md billing mechanics + SCHEMA.md billing).
// One invoice per account per currency, its line items FK-linked to their
// evidence (recovered payment / dispute), committed as ONE atomic money-write
// batch through the per-account Durable Object.
//
// Two-layer idempotency:
//   1. billing_invoices.idempotency_key is unique and deterministic per
//      (account, currency, period). A concurrent or repeated run collides on it
//      and the whole batch rolls back (applied=false). The DO storage fast path
//      short-circuits the common repeat before any SQL runs.
//   2. billing_line_items has a unique index per recovered_payment and per
//      dispute, so a recovery/dispute can never be billed twice even across
//      differently-keyed invoices. The billable queries also exclude
//      already-billed rows, so a second run's set is empty by construction.

export interface BillingPeriod {
  periodStart: Date;
  /** Exclusive: the first instant of the current month. */
  periodEnd: Date;
  /** YYYY-MM of the prior calendar month; drives the idempotency key. */
  periodKey: string;
}

/** The prior calendar month relative to `nowMs` (UTC). Pure. */
export function computeBillingPeriod(nowMs: number): BillingPeriod {
  const now = new Date(nowMs);
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-11, current month
  const startY = m === 0 ? y - 1 : y;
  const startM = m === 0 ? 11 : m - 1;
  const periodStart = new Date(Date.UTC(startY, startM, 1));
  return { periodStart, periodEnd: new Date(Date.UTC(y, m, 1)), periodKey: monthKey(periodStart) };
}

interface BillableRecoveryLite {
  id: string;
  amountCents: number;
  /** Refunded so far; the fee is taken on the rest. */
  refundedCents: number;
}
interface BillableDisputeLite {
  id: string;
  amountCents: number;
  /**
   * The cap-applied fee stored at resolution or by the pricing retry. An
   * unpriced win never reaches the run (billableDisputeRowConditions), and
   * there is no computed fallback: the fee billed is the fee the merchant was
   * told.
   */
  resolvedFeeCents: number;
}

export interface InvoiceBatchInput {
  invoiceId: string;
  accountId: string;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  /**
   * YYYY-MM of the period being billed. Part of each recovery line's Stripe
   * idempotency key, so the key is stable across retries of the same period
   * without depending on the run-scoped billing_invoices id.
   */
  periodKey: string;
  idempotencyKey: string;
  createdAt: Date;
  /**
   * The run's asOf, re-evaluated by the guarded line insert so the batch
   * applies the SAME maturity cutoff the billable read applied.
   */
  asOfMs: number;
  recoveries: BillableRecoveryLite[];
  disputes: BillableDisputeLite[];
}

export interface BuiltInvoiceBatch {
  batch: MoneyWriteBatch;
  totalCents: number;
  lineItemCount: number;
  /**
   * The plain line data, alongside the SQL batch, so the caller can hand it to
   * createPlatformInvoice after the write commits without a re-query.
   */
  lines: PlatformInvoiceLineInput[];
}

/**
 * Re-read one invoice's committed line items and rebuild the Stripe input from
 * them. Used after the money batch commits, because a guarded line can decline
 * to insert itself and the pre-write list would then overstate the invoice.
 */
async function readCommittedInvoice(
  db: Db,
  opts: { invoiceId: string; accountId: string; currency: string; periodKey: string },
): Promise<{ totalCents: number; lineItemCount: number; lines: PlatformInvoiceLineInput[] }> {
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
    .where(eq(billingLineItems.invoiceId, opts.invoiceId));

  const lines: PlatformInvoiceLineInput[] = rows.map((row) => ({
    type: row.type,
    amountCents: row.amountCents,
    description: row.description ?? "",
    idempotencyKey: lineItemIdempotencyKey(row, opts),
  }));

  return {
    totalCents: rows.reduce((sum, row) => sum + row.amountCents, 0),
    lineItemCount: rows.length,
    lines,
  };
}

/**
 * Builds the atomic invoice batch (the billing_invoices row followed by its
 * billing_line_items). The invoice is first so the line items' FK resolves
 * inside the same transaction. Pure and unit-testable; the caller supplies the
 * invoice id so the linkage is deterministic.
 */
export function buildBillingInvoiceBatch(db: Db, input: InvoiceBatchInput): BuiltInvoiceBatch {
  const lineItems: BatchItem<"sqlite">[] = [];
  const lines: PlatformInvoiceLineInput[] = [];
  let total = 0;

  for (const r of input.recoveries) {
    const fee = feeForCurrency(
      recoveryFeeCents(unrefundedCents(r.amountCents, r.refundedCents)),
      input.currency,
    );
    // Refunded down to nothing chargeable: no line, as for a full refund.
    if (fee <= 0) continue;
    total += fee;
    // GUARDED: the predicate is re-evaluated by the database as this row is
    // written, inside the batch. A refund landing between the billable read and
    // this write selects zero rows and bills nothing; the next run bills what
    // is left.
    lineItems.push(
      buildGuardedRecoveryLineInsert(db, {
        lineItemId: crypto.randomUUID(),
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        currency: input.currency,
        recoveredPaymentId: r.id,
        feeCents: fee,
        refundedCents: r.refundedCents,
        description: "Recovery fee",
        createdAt: input.createdAt,
        asOfMs: input.asOfMs,
      }),
    );
    lines.push({
      type: "recovery_fee",
      amountCents: fee,
      description: "Recovery fee",
      idempotencyKey: recoveryFeeItemIdempotencyKey(
        input.accountId,
        input.periodKey,
        input.currency,
        r.id,
      ),
    });
  }

  for (const d of input.disputes) {
    const fee = d.resolvedFeeCents;
    total += fee;
    lineItems.push(
      db.insert(billingLineItems).values({
        invoiceId: input.invoiceId,
        accountId: input.accountId,
        type: "dispute_fee",
        currency: input.currency,
        amountCents: fee,
        feeCents: fee,
        disputeId: d.id,
        description: "Dispute fee",
        createdAt: input.createdAt,
      }),
    );
    lines.push({
      type: "dispute_fee",
      amountCents: fee,
      description: "Dispute fee",
      idempotencyKey: disputeFeeItemIdempotencyKey(d.id),
    });
  }

  const invoiceInsert = db.insert(billingInvoices).values({
    id: input.invoiceId,
    accountId: input.accountId,
    currency: input.currency,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    status: "draft",
    totalCents: total,
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
  });

  // The invoice row carries the JS total, then the last statement in the batch
  // replaces it with the sum of the lines that ACTUALLY landed. Without this a
  // withdrawn line would leave the invoice overstated by exactly its fee, which
  // is the same defect one level up.
  const batch: MoneyWriteBatch = [
    invoiceInsert,
    ...lineItems,
    buildInvoiceTotalFromLines(db, input.invoiceId),
  ];
  return { batch, totalCents: total, lineItemCount: lineItems.length, lines };
}

/**
 * The one guard deciding whether the billing run may even attempt a platform
 * charge: a platform customer id must be stored AND there must be at least one
 * Stripe-chargeable line (createPlatformInvoice itself also throws on either
 * missing precondition; this lets the caller skip the attempt, and the network
 * call, entirely rather than throw-and-catch the common no-customer-yet case).
 * Pure, so "never charge without a stored platform customer id" is directly
 * unit-tested without needing a live Stripe call.
 */
export function shouldAttemptPlatformCharge(
  platformCustomerId: string | null,
  lines: PlatformInvoiceLineInput[],
): boolean {
  return Boolean(platformCustomerId) && chargeableLines(lines).length > 0;
}

interface InvoiceRunResult {
  currency: string;
  idempotencyKey: string;
  applied: boolean;
  totalCents: number;
  lineItemCount: number;
  invoiceId: string;
  /**
   * True only when a platform Stripe invoice was actually created for this run.
   */
  charged: boolean;
}
export interface AccountBillingResult {
  accountId: string;
  invoices: InvoiceRunResult[];
  /** Set only when this account's billing threw; the cron alerts on it. */
  error?: string;
}

type SweepRunStatus = "completed" | "aborted";

/**
 * What the charge-retry sweep did, in a shape the cron message can name.
 *
 * A failed invoice is a per-invoice outcome and the sweep carried on to the
 * next one; an abort means the sweep stopped early because it could not read
 * the billing gate, so an unknown number of stranded invoices were never looked
 * at at all.
 */
export interface SweepRunSummary {
  status: SweepRunStatus;
  /**
   * Per-outcome counts of the results the sweep produced. Empty on an abort,
   * which discards its partial results by design.
   */
  tally: Record<string, number>;
  /** Why the sweep stopped. Present only when status is "aborted". */
  abortReason?: string;
}

export interface MonthlyBillingResult {
  accounts: AccountBillingResult[];
  sweep: SweepRunSummary;
}

/**
 * The sweep clause of the cron_run_log message. Pure, so the wording an
 * operator actually reads is asserted in a test rather than eyeballed after a
 * deploy. ABORTED is shouted because it is the one value that means a silence
 * is not evidence of nothing to do.
 */
export function describeSweepRun(sweep: SweepRunSummary): string {
  if (sweep.status === "aborted") {
    return `sweep ABORTED (${sweep.abortReason ?? "unknown"})`;
  }
  const entries = Object.entries(sweep.tally);
  if (entries.length === 0) return "sweep found nothing stranded";
  return `sweep ${entries.map(([outcome, n]) => `${n} ${outcome}`).join(", ")}`;
}

/**
 * Bills one account for the prior period: reads the billable recoveries + won
 * disputes, groups by currency, and commits one atomic invoice per currency.
 * Returns per-currency results (applied=false means an idempotent no-op).
 *
 * Finalize/charge step (5d): once an invoice is newly applied, the run attempts
 * a platform Stripe charge ONLY when the account has a stored platform Stripe
 * customer id (shouldAttemptPlatformCharge; createPlatformInvoice's own throw
 * is a second, redundant guard). The charge attempt is a separate try/catch so
 * a Stripe-side failure never rolls back or reruns the already-committed
 * ledger; it is a distinct follow-up write (buildInvoiceStripeRefUpdate), not
 * part of the ledger's atomic batch, since it depends on an external network
 * call the DO batch cannot make.
 */
export async function runAccountBilling(
  env: Env,
  opts: { accountId: string; nowMs: number },
): Promise<AccountBillingResult> {
  const db = getDb(env);
  const { accountId, nowMs } = opts;
  const period = computeBillingPeriod(nowMs);
  const createdAt = new Date(nowMs);

  const [account] = await db
    .select({ platformStripeCustomerId: accounts.platformStripeCustomerId, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  // Not const: an account billed before it has a platform customer gets one
  // below, and every later currency in this run uses it.
  let platformCustomerId = account?.platformStripeCustomerId ?? null;

  const recoveries = await getBillableRecoveries(db, accountId, nowMs);
  const disputes = await getBillableDisputes(db, accountId, nowMs);

  const currencies = [
    ...new Set([...recoveries.map((r) => r.currency), ...disputes.map((d) => d.currency)]),
  ];

  const invoices: InvoiceRunResult[] = [];
  for (const currency of currencies) {
    const cr: BillableRecoveryLite[] = recoveries
      .filter((r) => r.currency === currency)
      .map((r) => ({ id: r.id, amountCents: r.amountCents, refundedCents: r.refundedCents }));
    // The billable query already leaves out an unpriced win; this filter is the
    // same rule restated where the fee is read, so a null can never become a
    // computed number on an invoice.
    const cd: BillableDisputeLite[] = disputes.flatMap((d) =>
      d.currency === currency && d.resolvedFeeCents != null
        ? [{ id: d.id, amountCents: d.amountCents, resolvedFeeCents: d.resolvedFeeCents }]
        : [],
    );
    if (cr.length === 0 && cd.length === 0) continue;

    const invoiceId = crypto.randomUUID();
    const idempotencyKey = `billing:${accountId}:${currency}:${period.periodKey}`;
    let summary = { totalCents: 0, lineItemCount: 0, lines: [] as PlatformInvoiceLineInput[] };
    const { applied } = await executeMoneyWrite(env, {
      accountId,
      idempotencyKey,
      build: (bdb) => {
        const built = buildBillingInvoiceBatch(bdb, {
          invoiceId,
          accountId,
          currency,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          periodKey: period.periodKey,
          idempotencyKey,
          createdAt,
          asOfMs: nowMs,
          recoveries: cr,
          disputes: cd,
        });
        summary = {
          totalCents: built.totalCents,
          lineItemCount: built.lineItemCount,
          lines: built.lines,
        };
        return built.batch;
      },
    });

    // THE STRIPE CALL BILLS WHAT COMMITTED, NOT WHAT WAS PLANNED.
    //
    // Now that a line can be withdrawn by its own guard as it writes, handing
    // that list to Stripe would move the defect rather than close it: the
    // ledger would be right and the merchant's invoice would still carry the
    // refunded recovery's fee. So the committed rows are re-read and they are
    // what Stripe is told about.
    if (applied) {
      summary = await readCommittedInvoice(db, {
        invoiceId,
        accountId,
        currency,
        periodKey: period.periodKey,
      });
    }

    let charged = false;
    // NO BRAKE RE-CHECK HERE, AND THAT ASYMMETRY WITH THE SWEEP IS DELIBERATE.
    //
    // charge-retry.ts re-reads the billing gate immediately before each of its
    // money-moving Stripe calls, and the obvious next move is to do the same
    // here. Refusing the charge at this point would not un-bill anything, it
    // would manufacture exactly the stranded invoice the retry sweep exists to
    // clean up (mode 1: our ledger committed, Stripe has nothing, and the key
    // collides forever after).
    if (PLATFORM_CHARGES_ENABLED && applied && chargeableLines(summary.lines).length > 0) {
      try {
        if (!platformCustomerId) {
          const createdCustomerId = await ensurePlatformCustomer(env, {
            existingCustomerId: null,
            accountId,
            accountName: account?.name ?? null,
          });
          await executeMoneyWrite(env, {
            accountId,
            idempotencyKey: `platform-customer:${accountId}`,
            build: (bdb) =>
              buildPlatformCustomerUpdate(bdb, {
                accountId,
                platformStripeCustomerId: createdCustomerId,
              }),
          });
          platformCustomerId = createdCustomerId;
        }
      } catch (err) {
        console.error(
          `platform customer create failed for account ${accountId} invoice ${invoiceId}:`,
          errorMessage(err),
        );
      }
    }
    if (
      PLATFORM_CHARGES_ENABLED &&
      applied &&
      shouldAttemptPlatformCharge(platformCustomerId, summary.lines)
    ) {
      try {
        // platformCustomerId is non-null here (the guard above requires it).
        const result = await createPlatformInvoice(env, {
          platformCustomerId: platformCustomerId as string,
          currency,
          lines: summary.lines,
          billingInvoiceId: invoiceId,
          periodStart: period.periodStart,
          billingEmail: () => lookupPlatformBillingEmail(env, accountId),
        });
        await executeMoneyWrite(env, {
          accountId,
          idempotencyKey: `${idempotencyKey}:stripe-ref`,
          build: (bdb) =>
            buildInvoiceStripeRefUpdate(bdb, {
              billingInvoiceId: invoiceId,
              stripeInvoiceId: result.stripeInvoiceId,
              hostedInvoiceUrl: result.hostedInvoiceUrl,
              status: "finalized",
              now: createdAt,
            }),
        });
        charged = true;
      } catch (err) {
        // The ledger already committed; a Stripe-side failure here never reruns
        // or rolls back the invoice, it stays 'draft' for retry/Phase 8.
        console.error(
          `platform charge failed for account ${accountId} invoice ${invoiceId}:`,
          errorMessage(err),
        );
      }
    }

    invoices.push({
      currency,
      idempotencyKey,
      applied,
      totalCents: summary.totalCents,
      lineItemCount: summary.lineItemCount,
      invoiceId,
      charged,
    });
  }

  return { accountId, invoices };
}

/**
 * The full monthly run: every billing-eligible account (not exempt, not paused,
 * not a demo account) billed for the prior period. This is the entry point the
 * Phase 4e Cron Trigger invokes.
 *
 * The charge-dispatch retry sweep runs FIRST, before any new invoice is raised.
 * A committed invoice whose charge never landed is otherwise stranded forever
 * (its own idempotency key blocks re-billing the period), and settling last
 * period's outstanding fee before raising this period's is the order a merchant
 * would expect.
 */
export async function runMonthlyBilling(
  env: Env,
  nowMs: number,
  opts: { sweepDeps?: Partial<ChargeRetryDeps> } = {},
): Promise<MonthlyBillingResult> {
  const db = getDb(env);

  let sweep: SweepRunSummary;
  try {
    const swept = await runChargeRetrySweep(env, nowMs, { deps: opts.sweepDeps });
    sweep = {
      status: "completed",
      tally: swept.reduce<Record<string, number>>((acc, r) => {
        acc[r.outcome] = (acc[r.outcome] ?? 0) + 1;
        return acc;
      }, {}),
    };
  } catch (err) {
    // WHERE THE SWEEP'S FAIL-CLOSED PROPERTY STOPS, AND THAT IS DELIBERATE.
    //
    // charge-retry.ts says "an unreadable guard stops the sweep", and that is
    // exactly what it means: the SWEEP.
    //
    // It is safe because the loop below does not depend on the guard that just
    // failed: every per-account billable query inner-joins accounts on
    // accountBillingEligibleCondition, so a brake-paused account yields an
    // empty billable set and no invoice is ever built, and a D1 that cannot be
    // read makes those queries throw into the per-account catch rather than
    // charge anything.
    sweep = {
      status: "aborted",
      tally: {},
      abortReason:
        err instanceof ChargeGuardReadError
          ? `billing guard unreadable: ${err.message}`
          : err instanceof Error
            ? err.message
            : "charge retry sweep failed",
    };
    console.error("charge retry sweep aborted:", sweep.abortReason);
  }

  const eligible = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(accountBillingEligibleCondition());

  const results: AccountBillingResult[] = [];
  for (const { id } of eligible) {
    try {
      results.push(await runAccountBilling(env, { accountId: id, nowMs }));
    } catch (err) {
      results.push({
        accountId: id,
        invoices: [],
        error: errorMessage(err),
      });
      // Surface the failure without aborting the run; the cron logs the
      // aggregate.
      console.error(`billing run failed for account ${id}:`, errorMessage(err));
    }
  }
  return { accounts: results, sweep };
}
