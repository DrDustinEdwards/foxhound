import { and, eq, gte } from "drizzle-orm";

import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { accounts, recoveredPayments } from "~/db";
import { disputeFeeCents, recoveryFeeCents } from "~/lib/billing/fees";

// The /billing fee preview (ruling 33): what the next monthly run will invoice,
// shown to the merchant before the invoice exists. Strictly read-only.
//
// This module computes NO money of its own. The billable sets come from
// app/db/billable.ts and the fee amounts from app/lib/billing/fees.ts, the same
// two modules app/lib/billing/run.ts reads, so the card and the invoice cannot
// disagree about who is billable or what a fee is. The one piece of run.ts this
// mirrors rather than imports is the per-dispute `resolvedFeeCents ?? computed`
// ordering, which lives inside buildBillingInvoiceBatch's loop and is not
// separately exported; test/billing-preview.test.ts pins the two against each
// other with a fixture whose snapshot deliberately differs from the computed
// fee, so a drift in that ordering fails a test rather than reaching a merchant.
//
// Everything here is evaluated at the NEXT RUN INSTANT, not at now. See
// nextBillingRunAtMs.

/** The monthly billing Cron Trigger, "0 4 1 * *" in wrangler.jsonc. Kept as the
 *  two fields the derivation actually uses so a cron change is a one-line edit
 *  here rather than arithmetic buried in a function body. */
const BILLING_RUN_DAY_OF_MONTH = 1;
const BILLING_RUN_HOUR_UTC = 4;

export interface CurrencyAmount {
  currency: string;
  cents: number;
}

export interface AccountBillingState {
  billingExempt: boolean;
  processingPaused: boolean;
  /** Operator cancel/disconnect. A PROCESSING gate only, never a billing gate:
   *  accountBillingEligibleCondition deliberately ignores it, so a cancelled
   *  account still owes its already-matured fees. */
  cancelledAt: Date | null;
}

export interface BillingPreview {
  /** Recovered revenue for the current UTC calendar month, every attribution
   *  kind including the free baseline. What the merchant got back, not what
   *  they will be billed on. */
  recoveredThisMonth: CurrencyAmount[];
  /** The instant the next monthly run fires. */
  nextRunAtMs: number;
  /** Per-currency fee totals the next run is on course to invoice. */
  estimatedInvoice: CurrencyAmount[];
  accountBillingState: AccountBillingState;
}

/**
 * The next instant the monthly billing cron fires, strictly after `nowMs`.
 *
 * Derived from the cron fields rather than written down as a date, so it cannot
 * go stale. Note the strictness: at exactly 04:00 on the 1st, THAT run is the
 * one already going, so the next one is a month out. And on the 1st at 02:00
 * the next run is two hours away, not a month away, which is the case a
 * "first of next month" shortcut gets wrong by a whole billing period.
 *
 * Pure and exported so the derivation is pinned by tests across month and year
 * boundaries instead of being trusted.
 */
export function nextBillingRunAtMs(nowMs: number): number {
  const now = new Date(nowMs);
  const thisMonth = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    BILLING_RUN_DAY_OF_MONTH,
    BILLING_RUN_HOUR_UTC,
  );
  if (thisMonth > nowMs) return thisMonth;
  // Date.UTC normalizes a month index of 12 into January of the next year, so
  // the year boundary needs no special case.
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    BILLING_RUN_DAY_OF_MONTH,
    BILLING_RUN_HOUR_UTC,
  );
}

/** First instant of the UTC calendar month containing `nowMs`. */
function startOfUtcMonthMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

function groupSumByCurrency(rows: { currency: string; cents: number }[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.cents);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

/**
 * The forward-looking half of /billing for one account.
 *
 * `nowMs` is when the merchant is looking. The estimate is deliberately NOT
 * evaluated at that instant: the billable predicate matures a recovery 30 days
 * after it was recovered, so a recovery aged 20 days today is not billable now
 * and IS billable by the time the run fires. Anchoring at `nowMs` would show
 * the merchant a number smaller than the invoice they are about to receive,
 * which is the one direction an estimate must never be wrong in.
 */
export async function getBillingPreview(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<BillingPreview> {
  const nextRunAtMs = nextBillingRunAtMs(nowMs);
  const monthStart = new Date(startOfUtcMonthMs(nowMs));

  // Four independent reads, none depending on another's result.
  const [accountRows, recoveredRows, billableRecoveries, billableDisputes] = await Promise.all([
    db
      .select({
        billingExempt: accounts.billingExempt,
        processingPaused: accounts.processingPaused,
        cancelledAt: accounts.cancelledAt,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
    db
      .select({ currency: recoveredPayments.currency, amountCents: recoveredPayments.amountCents })
      .from(recoveredPayments)
      .where(
        and(
          byAccountActive(recoveredPayments.accountId, recoveredPayments.deletedAt, accountId),
          gte(recoveredPayments.recoveredAt, monthStart),
        ),
      ),
    getBillableRecoveries(db, accountId, nextRunAtMs),
    getBillableDisputes(db, accountId, nextRunAtMs),
  ]);

  const account = accountRows[0] ?? null;

  const feeRows = [
    ...billableRecoveries.map((r) => ({
      currency: r.currency,
      cents: recoveryFeeCents(r.amountCents),
    })),
    ...billableDisputes.map((d) => ({
      currency: d.currency,
      // Mirrors buildBillingInvoiceBatch exactly: the cap-applied snapshot taken
      // at resolution wins, and the fee function is the fallback for a dispute
      // resolved before that column was written.
      cents: d.resolvedFeeCents ?? disputeFeeCents(d.amountCents),
    })),
  ];

  return {
    recoveredThisMonth: groupSumByCurrency(
      recoveredRows.map((r) => ({ currency: r.currency, cents: r.amountCents })),
    ),
    nextRunAtMs,
    estimatedInvoice: groupSumByCurrency(feeRows),
    accountBillingState: {
      billingExempt: account?.billingExempt ?? false,
      processingPaused: account?.processingPaused ?? false,
      cancelledAt: account?.cancelledAt ?? null,
    },
  };
}
