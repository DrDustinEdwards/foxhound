import { desc, eq } from "drizzle-orm";

import { getBillableRecoveries } from "~/db/billable";
import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { failedPayments, mrrSnapshots, recoveredPayments } from "~/db";
import { recoveryFeeCents } from "~/lib/billing/fees";

// Dashboard read models (Phase 5 slice 5a). Every query is account-scoped and
// read-only. "Fee owed" previews what the next billing run would invoice: it
// reuses the same billable predicate (app/db/billable.ts) and fee function
// (app/lib/billing/fees.ts) the billing run itself uses, never re-derives them.

export interface CurrencyAmount {
  currency: string;
  cents: number;
}

/**
 * Sum cents per currency. Exported because three dashboard surfaces render the
 * same money totals and each carried its own copy. A local reduce that ignores
 * currency silently adds EUR to USD and labels the result with whichever row
 * happened to be first, which is what the console's at-risk hero shipped.
 * One number, one computation.
 */
export function groupSumByCurrency(rows: { currency: string; amountCents: number }[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountCents);
  }
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

export interface RecoveryStats {
  activeFailedCount: number;
  totalFailedCount: number;
  recoveredCount: number;
  /** null when there is no failure history yet (a zero state, not a 0%). */
  recoveryRatePct: number | null;
  revenueRecovered: CurrencyAmount[];
  /** The billable (attributed, matured) subset of revenueRecovered that feeOwed is 20% of. */
  billableRevenue: CurrencyAmount[];
  feeOwed: CurrencyAmount[];
}

export async function getRecoveryStats(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<RecoveryStats> {
  // Three independent reads, none depending on another's result (perf-audit
  // fix, foxhound-audit-perf.md M-3): the dashboard's own outer loader already
  // parallelizes getRecoveryStats against getMrrAnalytics, but these three
  // were running one after another inside this function.
  const [failures, recovered, billable] = await Promise.all([
    db
      .select({ status: failedPayments.status, isRenewalNoise: failedPayments.isRenewalNoise })
      .from(failedPayments)
      .where(byAccountActive(failedPayments.accountId, failedPayments.deletedAt, accountId)),
    db
      .select({ currency: recoveredPayments.currency, amountCents: recoveredPayments.amountCents })
      .from(recoveredPayments)
      .where(byAccountActive(recoveredPayments.accountId, recoveredPayments.deletedAt, accountId)),
    getBillableRecoveries(db, accountId, nowMs),
  ]);

  // Renewal noise (duplicate/renewal-driven failure records) is not a real
  // recovery-funnel event; excluded from both sides of the rate.
  const countable = failures.filter((f) => !f.isRenewalNoise);
  const totalFailedCount = countable.length;
  const activeFailedCount = countable.filter((f) => f.status === "active").length;
  const recoveredCount = countable.filter((f) => f.status === "recovered").length;
  const recoveryRatePct =
    totalFailedCount > 0 ? Math.round((recoveredCount / totalFailedCount) * 100) : null;

  const feeRows = billable.map((r) => ({
    currency: r.currency,
    amountCents: recoveryFeeCents(r.amountCents),
  }));

  return {
    activeFailedCount,
    totalFailedCount,
    recoveredCount,
    recoveryRatePct,
    revenueRecovered: groupSumByCurrency(recovered),
    billableRevenue: groupSumByCurrency(billable),
    feeOwed: groupSumByCurrency(feeRows),
  };
}

export type MrrSnapshotRow = typeof mrrSnapshots.$inferSelect;

export interface MrrAnalytics {
  latest: MrrSnapshotRow | null;
  /** Chronological (oldest -> newest), for trend charts. */
  trend: MrrSnapshotRow[];
}

const MRR_TREND_POINTS = 12;

export async function getMrrAnalytics(db: Db, accountId: string): Promise<MrrAnalytics> {
  const rows = await db
    .select()
    .from(mrrSnapshots)
    .where(eq(mrrSnapshots.accountId, accountId))
    .orderBy(desc(mrrSnapshots.snapshotDate))
    .limit(MRR_TREND_POINTS);

  return {
    latest: rows[0] ?? null,
    trend: [...rows].reverse(),
  };
}
