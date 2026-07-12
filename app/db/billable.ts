import { and, eq, getTableColumns, isNull, lte, ne, type SQL } from "drizzle-orm";

import { RECOVERY_MATURITY_MS } from "~/lib/constants";
import type { Db } from "./client";
import { billingLineItems, recoveredPayments } from "./schema";

// THE single source of truth for "is this recovery billable" (PRICING.md
// maturity-window billing + SCHEMA.md spine #3). No other module reimplements
// this predicate. A recovery bills only when ALL hold:
//   - attributed to a Foxhound action (attribution_kind != 'stripe_baseline'),
//   - matured >= RECOVERY_MATURITY_DAYS (recovered_at <= asOf - maturity),
//   - not refunded, not disputed, not soft-deleted,
//   - not already billed (no billing_line_item references it).

/** Row-level billable conditions (everything except the not-already-billed clause,
 *  which is a join and lives in the canonical query below). */
export function billableRecoveryRowConditions(accountId: string, asOfMs: number): SQL {
  const maturityCutoff = new Date(asOfMs - RECOVERY_MATURITY_MS);
  return and(
    eq(recoveredPayments.accountId, accountId),
    ne(recoveredPayments.attributionKind, "stripe_baseline"),
    lte(recoveredPayments.recoveredAt, maturityCutoff),
    isNull(recoveredPayments.refundedAt),
    isNull(recoveredPayments.disputedAt),
    isNull(recoveredPayments.deletedAt),
  ) as SQL;
}

/**
 * The canonical billable-recovery query for one account as of `asOfMs`.
 * Left-joins billing_line_items and keeps only rows with no existing line item
 * (structural "not previously billed"). Returns recovered_payments rows.
 */
export function getBillableRecoveries(db: Db, accountId: string, asOfMs: number) {
  return db
    .select(getTableColumns(recoveredPayments))
    .from(recoveredPayments)
    .leftJoin(
      billingLineItems,
      eq(billingLineItems.recoveredPaymentId, recoveredPayments.id),
    )
    .where(
      and(
        billableRecoveryRowConditions(accountId, asOfMs),
        isNull(billingLineItems.id),
      ),
    );
}
