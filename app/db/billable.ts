import { and, eq, getTableColumns, inArray, isNull, lte, notLike, type SQL } from "drizzle-orm";

import { BILLABLE_ATTRIBUTION_KINDS, DEMO_ACCOUNT_ID_PREFIX, RECOVERY_MATURITY_MS } from "~/lib/constants";
import type { Db } from "./client";
import { accounts, billingLineItems, disputes, recoveredPayments } from "./schema";

// THE single source of truth for the billable sets (PRICING.md maturity-window
// billing + SCHEMA.md spine #3). No other module reimplements these predicates.
// A recovery bills only when ALL hold:
//   - attributed to a Foxhound action (attribution_kind is one of
//     BILLABLE_ATTRIBUTION_KINDS, the same allow-list app/lib/recovery/attribution.ts's
//     isBillableAttribution uses, consolidated here 2026-07-19 per Phase 5 review
//     LOW/INFO finding: this used to be a deny-list, attribution_kind != 'stripe_baseline',
//     which happened to be equivalent only because exactly four attribution kinds exist. A
//     fifth kind added to the schema CHECK constraint in the future would have silently
//     become billable by default under the old deny-list; the allow-list fails closed instead),
//   - matured >= RECOVERY_MATURITY_DAYS (recovered_at <= asOf - maturity),
//   - not refunded, not disputed, not soft-deleted,
//   - not already billed (no billing_line_item references it),
//   - the account is billing-eligible (not exempt, not paused, not a demo account).
// A won dispute bills only when it is resolved_won by asOf, not previously billed,
// and the account is billing-eligible.

/** Account-level billing gate (PRICING.md: billing_exempt / processing_paused
 *  honored in the billable query itself; demo accounts never bill). Applied via an
 *  inner join on accounts in every billable query below. */
export function accountBillingEligibleCondition(): SQL {
  return and(
    eq(accounts.billingExempt, false),
    eq(accounts.processingPaused, false),
    notLike(accounts.id, `${DEMO_ACCOUNT_ID_PREFIX}%`),
  ) as SQL;
}

/** Row-level billable conditions for recoveries (everything except the
 *  not-already-billed clause, which is a join and lives in the query below). */
export function billableRecoveryRowConditions(accountId: string, asOfMs: number): SQL {
  const maturityCutoff = new Date(asOfMs - RECOVERY_MATURITY_MS);
  return and(
    eq(recoveredPayments.accountId, accountId),
    inArray(recoveredPayments.attributionKind, BILLABLE_ATTRIBUTION_KINDS),
    lte(recoveredPayments.recoveredAt, maturityCutoff),
    isNull(recoveredPayments.refundedAt),
    isNull(recoveredPayments.disputedAt),
    isNull(recoveredPayments.deletedAt),
  ) as SQL;
}

/**
 * The canonical billable-recovery query for one account as of `asOfMs`.
 * Inner-joins accounts (billing-eligibility gate) and left-joins billing_line_items,
 * keeping only rows with no existing line item (structural "not previously billed").
 * Returns recovered_payments rows.
 */
export function getBillableRecoveries(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(recoveredPayments))
    .from(recoveredPayments)
    .innerJoin(accounts, eq(accounts.id, recoveredPayments.accountId))
    .leftJoin(
      billingLineItems,
      eq(billingLineItems.recoveredPaymentId, recoveredPayments.id),
    )
    .where(
      and(
        billableRecoveryRowConditions(accountId, asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}

/** Row-level billable conditions for disputes: resolved_won by asOf. Disputes have
 *  no maturity window (PRICING.md: billed at the next run after resolution); the
 *  resolved fee snapshot on the row already carries the cap applied at resolution. */
export function billableDisputeRowConditions(accountId: string, asOfMs: number): SQL {
  return and(
    eq(disputes.accountId, accountId),
    eq(disputes.state, "resolved_won"),
    lte(disputes.resolvedAt, new Date(asOfMs)),
  ) as SQL;
}

/**
 * The canonical billable-dispute query for one account as of `asOfMs`.
 * Inner-joins accounts (billing-eligibility gate) and left-joins billing_line_items,
 * keeping only disputes with no existing dispute_fee line item (structural
 * "not previously billed"; the dispute unique index prevents double-billing on
 * reopen). Returns disputes rows.
 */
export function getBillableDisputes(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(disputes))
    .from(disputes)
    .innerJoin(accounts, eq(accounts.id, disputes.accountId))
    .leftJoin(billingLineItems, eq(billingLineItems.disputeId, disputes.id))
    .where(
      and(
        billableDisputeRowConditions(accountId, asOfMs),
        accountBillingEligibleCondition(),
        isNull(billingLineItems.id),
      ),
    );
}
