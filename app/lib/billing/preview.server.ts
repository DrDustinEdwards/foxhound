import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { and, eq, gte } from "drizzle-orm";

import { getBillableDisputes, getBillableRecoveries } from "~/db/billable";
import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { accounts, recoveredPayments } from "~/db";
import {
  BILLABLE_ATTRIBUTION_KINDS,
  BILLING_RUN_DAY_OF_MONTH,
  BILLING_RUN_HOUR_UTC,
} from "~/lib/constants";
import { recoveryFeeCents, unrefundedCents } from "~/lib/billing/fees";

// This module computes NO money of its own. The billable sets come from
// app/db/billable.ts and the fee amounts from app/lib/billing/fees.ts, the same
// two modules app/lib/billing/run.ts reads, so the card and the invoice cannot
// disagree about who is billable or what a fee is.

export interface AccountBillingState {
  billingExempt: boolean;
  processingPaused: boolean;
  /**
   * Operator cancel/disconnect. A PROCESSING gate only, never a billing gate:
   * accountBillingEligibleCondition deliberately ignores it, so a canceled
   * account still owes its already-matured fees.
   */
  cancelledAt: Date | null;
}

export interface PendingDisputeFee {
  disputeId: string;
  amountCents: number;
  currency: string;
  feeCents: number;
  resolvedAt: Date | null;
}

export interface BillingPreview {
  /**
   * Recovered revenue for the current UTC calendar month, every attribution
   * kind including the free baseline. What the merchant got back, not what they
   * will be billed on.
   */
  recoveredThisMonth: CurrencyAmount[];
  attributedThisMonth: CurrencyAmount[];
  nextRunAtMs: number;
  estimatedInvoice: CurrencyAmount[];
  estimatedRecoveryFees: CurrencyAmount[];
  estimatedDisputeFees: CurrencyAmount[];
  pendingDisputeFees: PendingDisputeFee[];
  accountBillingState: AccountBillingState;
}

/**
 * The next instant the monthly billing cron fires, strictly after `nowMs`.
 *
 * Derived from the cron fields rather than written down as a date, so it cannot
 * go stale. Note the strictness: at exactly 04:00 on the 1st, THAT run is the
 * one already going, so the next one is a month out.
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

export function startOfUtcMonthMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/**
 * The forward-looking half of /billing for one account.
 *
 * Anchoring at `nowMs` would show the merchant a number smaller than the
 * invoice they are about to receive, which is the one direction an estimate
 * must never be wrong in.
 */
export async function getBillingPreview(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<BillingPreview> {
  const nextRunAtMs = nextBillingRunAtMs(nowMs);
  const monthStart = new Date(startOfUtcMonthMs(nowMs));

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
      .select({
        currency: recoveredPayments.currency,
        amountCents: recoveredPayments.amountCents,
        attributionKind: recoveredPayments.attributionKind,
      })
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

  const recoveryFeeRows = billableRecoveries.map((r) => ({
    currency: r.currency,
    cents: recoveryFeeCents(unrefundedCents(r.amountCents, r.refundedCents)),
  }));
  // Mirrors runAccountBilling exactly: the stored cap-applied fee, and an
  // unpriced win (no stored fee) is not pending, because the run skips it.
  const pendingDisputeFees: PendingDisputeFee[] = billableDisputes.flatMap((d) =>
    d.resolvedFeeCents == null
      ? []
      : [
          {
            disputeId: d.id,
            amountCents: d.amountCents,
            currency: d.currency,
            feeCents: d.resolvedFeeCents,
            resolvedAt: d.resolvedAt ?? null,
          },
        ],
  );
  const disputeFeeRows = pendingDisputeFees.map((d) => ({
    currency: d.currency,
    cents: d.feeCents,
  }));
  const attributed = new Set<string>(BILLABLE_ATTRIBUTION_KINDS);

  return {
    recoveredThisMonth: groupSumByCurrency(
      recoveredRows.map((r) => ({ currency: r.currency, cents: r.amountCents })),
    ),
    attributedThisMonth: groupSumByCurrency(
      recoveredRows
        .filter((r) => attributed.has(r.attributionKind))
        .map((r) => ({ currency: r.currency, cents: r.amountCents })),
    ),
    nextRunAtMs,
    estimatedInvoice: groupSumByCurrency([...recoveryFeeRows, ...disputeFeeRows]),
    estimatedRecoveryFees: groupSumByCurrency(recoveryFeeRows),
    estimatedDisputeFees: groupSumByCurrency(disputeFeeRows),
    pendingDisputeFees,
    accountBillingState: {
      billingExempt: account?.billingExempt ?? false,
      processingPaused: account?.processingPaused ?? false,
      cancelledAt: account?.cancelledAt ?? null,
    },
  };
}
