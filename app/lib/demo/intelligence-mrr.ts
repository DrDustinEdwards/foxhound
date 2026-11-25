import { buildMrrSnapshotFields, type CustomerMrrPoint } from "~/lib/intelligence/mrr";
import { monthlyMrrCents, planNameFor, type DemoCustomer } from "./customer-base";
import { DAY_MS } from "~/lib/constants";
import { monthKey } from "@dustinedwards/site-runtime/time";
import type { MrrSnapshotInsert } from "./intelligence-seed";

const MONTH_COUNT = 12;
const DAILY_SNAPSHOT_DAYS = 90;

interface MrrRosterEntry {
  stripeCustomerId: string;
  planName: string;
  cohortKey: string;
  joinedAt: Date;
  churnedAt: Date | null;
  activeMonthlyMrrCents: number;
}

export function buildMrrRoster(
  customers: DemoCustomer[],
  disputeOnly: { id: string; planName: string; joinedAt: Date; mrrCents: number }[],
): MrrRosterEntry[] {
  const fromBase: MrrRosterEntry[] = customers.map((c) => ({
    stripeCustomerId: c.stripeCustomerId,
    planName: planNameFor(c),
    cohortKey: monthKey(c.customerSince),
    joinedAt: c.customerSince,
    churnedAt: c.status === "churned" ? c.churnedAt : null,
    // Ignore the *current* churned/paused status for the historical-arc walk;
    // months before any churn date should still show the customer's normal
    // contribution (monthlyMrrCents zeroes churned customers unconditionally).
    activeMonthlyMrrCents: monthlyMrrCents({ ...c, status: "active" }),
  }));
  const fromDisputes: MrrRosterEntry[] = disputeOnly.map((d) => ({
    stripeCustomerId: d.id,
    planName: d.planName,
    cohortKey: monthKey(d.joinedAt),
    joinedAt: d.joinedAt,
    churnedAt: null,
    activeMonthlyMrrCents: d.mrrCents,
  }));
  return [...fromBase, ...fromDisputes];
}

/**
 * The demo's snapshot dates, oldest first: one a month for the year before the
 * last DAILY_SNAPSHOT_DAYS, then one a day, as intelligence-sync writes them,
 * so the dashboard's 90 days and the console's twelve months both have rows.
 */
function snapshotDates(now: Date): Date[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dailyFrom = today - (DAILY_SNAPSHOT_DAYS - 1) * DAY_MS;
  const dates: Date[] = [];
  for (let m = MONTH_COUNT - 1; m >= 1; m--) {
    const d = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, now.getUTCDate());
    if (d < dailyFrom) dates.push(new Date(d));
  }
  for (let t = dailyFrom; t <= today; t += DAY_MS) dates.push(new Date(t));
  return dates;
}

export function buildSnapshots(
  accountId: string,
  idPrefix: string,
  roster: MrrRosterEntry[],
  now: Date,
): MrrSnapshotInsert[] {
  const rows: MrrSnapshotInsert[] = [];
  let priorByCustomer: Map<string, number> | null = null;

  const dates = snapshotDates(now);
  for (const [m, snapshotDate] of dates.entries()) {
    const current: CustomerMrrPoint[] = roster.map((r) => {
      const joined = r.joinedAt.getTime() <= snapshotDate.getTime();
      const churnedByNow = r.churnedAt !== null && r.churnedAt.getTime() <= snapshotDate.getTime();
      return {
        stripeCustomerId: r.stripeCustomerId,
        mrrCents: joined && !churnedByNow ? r.activeMonthlyMrrCents : 0,
        planName: r.planName,
        cohortKey: r.cohortKey,
        churnReason: churnedByNow ? "involuntary" : null,
      };
    });

    const fields = buildMrrSnapshotFields(priorByCustomer, current);
    rows.push({
      id: `${idPrefix}mrr_${dates.length - 1 - m}`,
      accountId,
      snapshotDate,
      totalMrrCents: fields.totalMrrCents,
      newMrrCents: fields.newMrrCents,
      expansionMrrCents: fields.expansionMrrCents,
      contractionMrrCents: fields.contractionMrrCents,
      churnMrrCents: fields.churnMrrCents,
      reactivationMrrCents: fields.reactivationMrrCents,
      activeCustomersCount: fields.activeCustomersCount,
      newCustomersCount: fields.newCustomersCount,
      churnedCustomersCount: fields.churnedCustomersCount,
      perPlanBreakdown: fields.perPlanBreakdown,
      perCohortBreakdown: fields.perCohortBreakdown,
      perChannelBreakdown: fields.perChannelBreakdown,
      voluntaryChurnRateBps: fields.voluntaryChurnRateBps,
      involuntaryChurnRateBps: fields.involuntaryChurnRateBps,
      netRevenueRetentionBps: fields.netRevenueRetentionBps,
      grossRevenueRetentionBps: fields.grossRevenueRetentionBps,
      currency: "usd",
      createdAt: snapshotDate,
    });

    // Only customers who had signed up by this date, as the sync's
    // customer_context holds only customers Stripe has: one who signs up later
    // is new MRR then, not a reactivation.
    priorByCustomer = new Map(
      current
        .filter((_, i) => roster[i].joinedAt.getTime() <= snapshotDate.getTime())
        .map((c) => [c.stripeCustomerId, c.mrrCents]),
    );
  }

  return rows;
}
