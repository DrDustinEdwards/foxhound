import { percent } from "capsomer/behavior/meter";
// Pure MRR movement math. With no subscription-history table, movements come from diffing each customer's MRR
// this run against the value customer_context held BEFORE this run overwrote it. On an account's first sync
// there is no prior state (the caller passes `null` for priorByCustomer), so movements are all zero: a fresh
// baseline, not fabricated churn or expansion.

/** One signup cohort: values[i] is a 0-100 share per column (months since the cohort started). Stored as JSON on mrr_snapshots. */
export interface CohortRow {
  label: string;
  values: number[];
}

/** True when `value` structurally matches CohortRow[] (nothing in the schema fixes a JSON column's shape). */
export function isCohortRows(value: unknown): value is CohortRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as CohortRow).label === "string" &&
        Array.isArray((r as CohortRow).values) &&
        (r as CohortRow).values.every((v) => typeof v === "number"),
    )
  );
}

export type ChurnReason = "voluntary" | "involuntary" | null;

/** The one churn definition, shared by the daily sync and the audit: a cancellation Stripe attributes to a failed or disputed payment is involuntary, any other stated reason voluntary, none unknown. */
export function churnReasonOf(cancellationReason: string | null | undefined): ChurnReason {
  if (!cancellationReason) return null;
  return cancellationReason === "payment_failed" || cancellationReason === "payment_disputed"
    ? "involuntary"
    : "voluntary";
}

export interface CustomerMrrPoint {
  stripeCustomerId: string;
  mrrCents: number;
  planName: string | null;
  cohortKey: string;
  churnReason?: ChurnReason;
}

export interface MrrMovements {
  totalMrrCents: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  reactivationMrrCents: number;
  activeCustomersCount: number;
  newCustomersCount: number;
  churnedCustomersCount: number;
  voluntaryChurnRateBps: number | null;
  involuntaryChurnRateBps: number | null;
  netRevenueRetentionBps: number | null;
  grossRevenueRetentionBps: number | null;
}

function bps(part: number, whole: number): number {
  return Math.round((part / whole) * 10000);
}

/**
 * `priorByCustomer` is `null` on a first-ever sync (every customer counts only toward totals). Otherwise it maps
 * stripeCustomerId -> prior mrrCents from customer_context as it stood before this run: absent means a true "new",
 * present with 0 means a row but no active subscription. Each current customer falls into exactly one bucket (new /
 * reactivation / churn / expansion / contraction / unchanged); a prior customer absent from `current` counts as churn.
 */
export function computeMrrMovements(
  priorByCustomer: Map<string, number> | null,
  current: CustomerMrrPoint[],
): MrrMovements {
  const totalMrrCents = current.reduce((sum, c) => sum + c.mrrCents, 0);
  const activeCustomersCount = current.filter((c) => c.mrrCents > 0).length;

  if (priorByCustomer === null) {
    return {
      totalMrrCents,
      newMrrCents: 0,
      expansionMrrCents: 0,
      contractionMrrCents: 0,
      churnMrrCents: 0,
      reactivationMrrCents: 0,
      activeCustomersCount,
      newCustomersCount: 0,
      churnedCustomersCount: 0,
      voluntaryChurnRateBps: null,
      involuntaryChurnRateBps: null,
      netRevenueRetentionBps: null,
      grossRevenueRetentionBps: null,
    };
  }

  let newMrrCents = 0;
  let expansionMrrCents = 0;
  let contractionMrrCents = 0;
  let churnMrrCents = 0;
  let reactivationMrrCents = 0;
  let newCustomersCount = 0;
  let churnedCustomersCount = 0;
  let voluntaryChurnCents = 0;
  let involuntaryChurnCents = 0;
  let priorTotalMrrCents = 0;
  for (const cents of priorByCustomer.values()) priorTotalMrrCents += cents;

  const visited = new Set<string>();
  for (const c of current) {
    visited.add(c.stripeCustomerId);
    const hadRow = priorByCustomer.has(c.stripeCustomerId);
    const prior = priorByCustomer.get(c.stripeCustomerId) ?? 0;

    if (!hadRow) {
      if (c.mrrCents > 0) {
        newMrrCents += c.mrrCents;
        newCustomersCount += 1;
      }
      continue;
    }
    if (prior === 0 && c.mrrCents > 0) {
      reactivationMrrCents += c.mrrCents;
    } else if (prior > 0 && c.mrrCents === 0) {
      churnMrrCents += prior;
      churnedCustomersCount += 1;
      if (c.churnReason === "voluntary") voluntaryChurnCents += prior;
      else if (c.churnReason === "involuntary") involuntaryChurnCents += prior;
    } else if (prior > 0 && c.mrrCents > prior) {
      expansionMrrCents += c.mrrCents - prior;
    } else if (prior > 0 && c.mrrCents < prior && c.mrrCents > 0) {
      contractionMrrCents += prior - c.mrrCents;
    }
  }

  // A prior customer the enumeration never returned (deleted or vanished) still churned; reason unknown.
  for (const [stripeCustomerId, prior] of priorByCustomer) {
    if (visited.has(stripeCustomerId) || prior <= 0) continue;
    churnMrrCents += prior;
    churnedCustomersCount += 1;
  }

  return {
    totalMrrCents,
    newMrrCents,
    expansionMrrCents,
    contractionMrrCents,
    churnMrrCents,
    reactivationMrrCents,
    activeCustomersCount,
    newCustomersCount,
    churnedCustomersCount,
    voluntaryChurnRateBps:
      priorTotalMrrCents > 0 ? bps(voluntaryChurnCents, priorTotalMrrCents) : null,
    involuntaryChurnRateBps:
      priorTotalMrrCents > 0 ? bps(involuntaryChurnCents, priorTotalMrrCents) : null,
    netRevenueRetentionBps:
      priorTotalMrrCents > 0
        ? bps(
            priorTotalMrrCents + expansionMrrCents - contractionMrrCents - churnMrrCents,
            priorTotalMrrCents,
          )
        : null,
    grossRevenueRetentionBps:
      priorTotalMrrCents > 0
        ? bps(priorTotalMrrCents - contractionMrrCents - churnMrrCents, priorTotalMrrCents)
        : null,
  };
}

export function buildPlanBreakdown(current: CustomerMrrPoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of current) {
    if (c.mrrCents <= 0) continue;
    const key = c.planName ?? "unknown";
    out[key] = (out[key] ?? 0) + c.mrrCents;
  }
  return out;
}

/** One CohortRow per signup cohort with a single "retention now" column: the share of that cohort's customers
 *  who still contribute MRR. A full decay curve needs months of snapshot history; later runs can extend this
 *  (CohortRow.values is already an array). */
function buildCohortBreakdown(current: CustomerMrrPoint[]): CohortRow[] {
  const totalByCohort = new Map<string, number>();
  const activeByCohort = new Map<string, number>();
  for (const c of current) {
    totalByCohort.set(c.cohortKey, (totalByCohort.get(c.cohortKey) ?? 0) + 1);
    if (c.mrrCents > 0) activeByCohort.set(c.cohortKey, (activeByCohort.get(c.cohortKey) ?? 0) + 1);
  }
  return [...totalByCohort.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohortKey, total]) => ({
      label: cohortKey,
      values: [percent(activeByCohort.get(cohortKey) ?? 0, total)],
    }));
}

export interface MrrSnapshotFields extends MrrMovements {
  perPlanBreakdown: Record<string, number>;
  perCohortBreakdown: CohortRow[];
  /** Always {}: nothing tracks acquisition channel yet; an honest empty object, not fabricated data. */
  perChannelBreakdown: Record<string, number>;
}

/** The mrr_snapshots payload for one sync run, minus id/accountId/snapshotDate/currency/createdAt (the caller's). */
export function buildMrrSnapshotFields(
  priorByCustomer: Map<string, number> | null,
  current: CustomerMrrPoint[],
): MrrSnapshotFields {
  return {
    ...computeMrrMovements(priorByCustomer, current),
    perPlanBreakdown: buildPlanBreakdown(current),
    perCohortBreakdown: buildCohortBreakdown(current),
    perChannelBreakdown: {},
  };
}

export interface DailyMrrRow {
  snapshotDate: Date;
  totalMrrCents: number;
  newMrrCents: number;
  expansionMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  reactivationMrrCents: number;
  newCustomersCount: number;
  churnedCustomersCount: number;
  voluntaryChurnRateBps: number | null;
  involuntaryChurnRateBps: number | null;
  netRevenueRetentionBps: number | null;
  grossRevenueRetentionBps: number | null;
}

/** Daily snapshots rolled up into one row per UTC month, oldest first. Each month is its LAST day's row, with
 *  movements and customer counts summed and rates measured against the month's starting MRR (the previous day's
 *  total; a day's churned cents are its rate times the previous row's total). A month with unknown starting MRR
 *  keeps null rates. */
export function rollUpByMonth<T extends DailyMrrRow>(rowsAsc: readonly T[]): T[] {
  const monthOf = (d: Date) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  const months: T[] = [];
  let i = 0;
  while (i < rowsAsc.length) {
    const key = monthOf(rowsAsc[i].snapshotDate);
    const start = i > 0 ? rowsAsc[i - 1].totalMrrCents : null;
    let j = i;
    const sum = {
      new: 0,
      exp: 0,
      contr: 0,
      churn: 0,
      react: 0,
      newCust: 0,
      churnedCust: 0,
      vol: 0,
      invol: 0,
    };
    while (j < rowsAsc.length && monthOf(rowsAsc[j].snapshotDate) === key) {
      const r = rowsAsc[j];
      const prior = j > 0 ? rowsAsc[j - 1].totalMrrCents : 0;
      sum.new += r.newMrrCents;
      sum.exp += r.expansionMrrCents;
      sum.contr += r.contractionMrrCents;
      sum.churn += r.churnMrrCents;
      sum.react += r.reactivationMrrCents;
      sum.newCust += r.newCustomersCount;
      sum.churnedCust += r.churnedCustomersCount;
      sum.vol += ((r.voluntaryChurnRateBps ?? 0) * prior) / 10000;
      sum.invol += ((r.involuntaryChurnRateBps ?? 0) * prior) / 10000;
      j += 1;
    }
    const known = start !== null && start > 0;
    months.push({
      ...rowsAsc[j - 1],
      newMrrCents: sum.new,
      expansionMrrCents: sum.exp,
      contractionMrrCents: sum.contr,
      churnMrrCents: sum.churn,
      reactivationMrrCents: sum.react,
      newCustomersCount: sum.newCust,
      churnedCustomersCount: sum.churnedCust,
      voluntaryChurnRateBps: known ? bps(sum.vol, start) : null,
      involuntaryChurnRateBps: known ? bps(sum.invol, start) : null,
      netRevenueRetentionBps: known ? bps(start + sum.exp - sum.contr - sum.churn, start) : null,
      grossRevenueRetentionBps: known ? bps(start - sum.contr - sum.churn, start) : null,
    });
    i = j;
  }
  return months;
}
