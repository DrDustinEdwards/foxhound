import { groupSumByCurrency, type CurrencyAmount } from "~/lib/money/totals";
import { and, asc, eq, gte } from "drizzle-orm";

import { getBillableRecoveries } from "~/db/billable";
import { byAccountActive } from "~/db/scope";
import type { Db } from "~/db";
import { failedPayments, mrrSnapshots, recoveredPayments } from "~/db";
import { recoveryFeeCents } from "~/lib/billing/fees";
import { rollUpByMonth } from "~/lib/intelligence/mrr";

// Dashboard read models (Phase 5 slice 5a). Every query is account-scoped and
// read-only. "Fee owed" previews what the next billing run would invoice: it
// reuses the same billable predicate (app/db/billable.ts) and fee function
// (app/lib/billing/fees.ts) the billing run itself uses, never re-derives them.

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
    cents: recoveryFeeCents(r.amountCents),
  }));

  return {
    activeFailedCount,
    totalFailedCount,
    recoveredCount,
    recoveryRatePct,
    revenueRecovered: groupSumByCurrency(recovered.map((r) => ({ currency: r.currency, cents: r.amountCents }))),
    billableRevenue: groupSumByCurrency(billable.map((r) => ({ currency: r.currency, cents: r.amountCents }))),
    feeOwed: groupSumByCurrency(feeRows),
  };
}

type MrrSnapshotRow = typeof mrrSnapshots.$inferSelect;

export interface MrrAnalytics {
  /** This month so far: the latest snapshot, with the month's movements and
   *  rates (rollUpByMonth). */
  latest: MrrSnapshotRow | null;
  /** One row per month, chronological (oldest -> newest), for trend charts. */
  trend: MrrSnapshotRow[];
}

const MRR_TREND_MONTHS = 12;

/** The console's and the narrative's MRR, by month. intelligence-sync writes a
 *  row a day, so the rows are rolled up into months here; the window reaches
 *  one day further back so the oldest month has its starting MRR. */
export async function getMrrAnalytics(db: Db, accountId: string, nowMs: number = Date.now()): Promise<MrrAnalytics> {
  const now = new Date(nowMs);
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MRR_TREND_MONTHS - 1), 1));
  const rows = await db
    .select()
    .from(mrrSnapshots)
    .where(and(eq(mrrSnapshots.accountId, accountId), gte(mrrSnapshots.snapshotDate, new Date(from.getTime() - 86_400_000 * 2))))
    .orderBy(asc(mrrSnapshots.snapshotDate));

  const months = rollUpByMonth(rows).filter((m) => m.snapshotDate >= from);
  return { latest: months[months.length - 1] ?? null, trend: months };
}
