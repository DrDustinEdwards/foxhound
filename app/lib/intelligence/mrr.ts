// Pure MRR movement math (PRICING.md free tier: MRR, movements, churn, simple
// cohorts; mrr_snapshots in SCHEMA.md). There is no subscription-history table
// in the schema (the task's key architectural fact), so movements are computed
// by diffing each customer's MRR contribution this run against the value
// customer_context held for that customer BEFORE this run overwrote it. On an
// account's very first-ever sync there is no prior state to diff against, so
// movements are all zero: a fresh baseline, not fabricated churn/expansion
// against nothing (the caller passes `null` for priorByCustomer in that case).

import type { CohortRow } from "~/components/charts";

export type ChurnReason = "voluntary" | "involuntary" | null;

export interface CustomerMrrPoint {
  stripeCustomerId: string;
  mrrCents: number;
  planName: string | null;
  /** Cohort bucket, e.g. the UTC year-month of the customer's Stripe `created`. */
  cohortKey: string;
  /** Only meaningful when this customer's MRR dropped to 0 this run; ignored otherwise. */
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
 * `priorByCustomer` is `null` on an account's first-ever sync (no prior state
 * exists at all: every current customer counts only toward totals, no movement
 * bucket). Otherwise it maps stripeCustomerId -> prior mrrCents, built from the
 * account's customer_context rows as they stood before this run's writes; a
 * customer absent from the map never had a context row before (a true "new"),
 * while one present with 0 had a row but no active subscription last time.
 *
 * Each current customer falls into exactly one bucket (no double-count, the
 * property a fresh-context review checks first): new / reactivation / churn /
 * expansion / contraction / unchanged. A prior customer entirely absent from
 * `current` (the connected account no longer returns that Stripe customer at
 * all) is still counted as churn, not silently dropped.
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

  // A prior customer this run's enumeration never returned at all (deleted or
  // otherwise vanished from the connected account) still churned; reason unknown.
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
    voluntaryChurnRateBps: priorTotalMrrCents > 0 ? bps(voluntaryChurnCents, priorTotalMrrCents) : null,
    involuntaryChurnRateBps: priorTotalMrrCents > 0 ? bps(involuntaryChurnCents, priorTotalMrrCents) : null,
    netRevenueRetentionBps:
      priorTotalMrrCents > 0
        ? bps(priorTotalMrrCents + expansionMrrCents - contractionMrrCents - churnMrrCents, priorTotalMrrCents)
        : null,
    grossRevenueRetentionBps:
      priorTotalMrrCents > 0
        ? bps(priorTotalMrrCents - contractionMrrCents - churnMrrCents, priorTotalMrrCents)
        : null,
  };
}

/** MRR cents by plan name (customers with 0 current MRR contribute nothing). */
export function buildPlanBreakdown(current: CustomerMrrPoint[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of current) {
    if (c.mrrCents <= 0) continue;
    const key = c.planName ?? "unknown";
    out[key] = (out[key] ?? 0) + c.mrrCents;
  }
  return out;
}

/**
 * One CohortGrid row (app/components/charts.tsx) per signup cohort, with a
 * single "retention now" column: the percentage of that cohort's customers
 * (everyone this run's enumeration saw with that cohort key, active or
 * churned-but-still-a-Stripe-customer) who still contribute MRR today.
 * PRICING.md's free tier promises "simple cohorts"; a full month-by-month
 * decay curve needs several months of accumulated snapshot history this
 * slice's first run does not have. One honest current data point per cohort
 * beats a fabricated curve, and later runs can extend this without a schema
 * change (CohortRow.values is already an array).
 */
export function buildCohortBreakdown(current: CustomerMrrPoint[]): CohortRow[] {
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
      values: [Math.round(((activeByCohort.get(cohortKey) ?? 0) / total) * 100)],
    }));
}

export interface MrrSnapshotFields extends MrrMovements {
  perPlanBreakdown: Record<string, number>;
  perCohortBreakdown: CohortRow[];
  /** Always {}: nothing in the schema tracks customer acquisition channel yet.
   *  An honest empty object, not fabricated data (DESIGN.md: charts render real
   *  data or an honest empty state). */
  perChannelBreakdown: Record<string, number>;
}

/** The full mrr_snapshots payload (minus id/accountId/snapshotDate/currency/
 *  createdAt, which the caller supplies) for one account's sync run. */
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
