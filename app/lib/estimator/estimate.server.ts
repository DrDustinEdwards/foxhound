import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { benchmarkData, estimatorRuns } from "~/db";

// No-auth estimator logic (Phase 6 Pass 3, PRICING.md: "No-auth estimator
// first: MRR + customer count -> benchmark leakage estimate"). Looks up
// seeded benchmark_data rows (drizzle/seed/benchmark_data.sql) by MRR band
// and produces a directional leakage estimate, never a platform-derived
// recovery-rate claim (no platform data exists yet -- PRICING.md/DESIGN.md
// flagship-surface-3 confidence-caveat convention: this is an ESTIMATE with
// a stated range, not a precise number).

const COHORT_DIMENSION = "mrr_band";
const LEAKAGE_METRIC_NAME = "monthly_failed_payment_leakage_pct_of_mrr";

const MRR_BANDS = [
  { cohortValue: "under_10k", maxMrrCents: 10_000_00 },
  { cohortValue: "10k_50k", maxMrrCents: 50_000_00 },
  { cohortValue: "50k_250k", maxMrrCents: 250_000_00 },
  { cohortValue: "250k_plus", maxMrrCents: Infinity },
] as const;

function mrrBandForCents(mrrCents: number): string {
  const band = MRR_BANDS.find((b) => mrrCents <= b.maxMrrCents);
  return (band ?? MRR_BANDS[MRR_BANDS.length - 1]).cohortValue;
}

export interface EstimatorInput {
  mrrCents: number;
  customerCount: number;
  currency: string;
}

export interface EstimatorResult {
  benchmarkCohort: string;
  estimatedLeakageCents: number;
  /** The seed's p25/p75 spread, stored with the run but NOT shown: the seed is
   *  an interpolation, not a study, so /audit never presents it as what
   *  comparable accounts show. The page shows medianPct as an assumption. */
  low: number;
  high: number;
  medianPct: number;
  sampleSize: number;
}

/**
 * Looks up the seeded benchmark row for this MRR's band and returns a
 * directional leakage estimate (median of the percentile range times MRR),
 * plus the p25/p75 spread for an honest confidence caveat. Returns null when
 * no benchmark row exists for the band (an unseeded environment, or a band
 * with no data), which the caller renders as an honest "not enough data
 * yet" state rather than a fabricated number.
 */
export async function estimateLeakage(db: Db, input: EstimatorInput): Promise<EstimatorResult | null> {
  const cohortValue = mrrBandForCents(input.mrrCents);
  const rows = await db
    .select()
    .from(benchmarkData)
    .where(
      and(
        eq(benchmarkData.cohortDimension, COHORT_DIMENSION),
        eq(benchmarkData.cohortValue, cohortValue),
        eq(benchmarkData.metricName, LEAKAGE_METRIC_NAME),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.p50 == null) return null;

  const medianPct = row.p50;
  const lowPct = row.p25 ?? row.p50;
  const highPct = row.p75 ?? row.p50;

  return {
    benchmarkCohort: cohortValue,
    estimatedLeakageCents: Math.round(input.mrrCents * medianPct),
    low: Math.round(input.mrrCents * lowPct),
    high: Math.round(input.mrrCents * highPct),
    medianPct,
    sampleSize: row.sampleSize,
  };
}

export interface RecordEstimatorRunInput extends EstimatorInput {
  result: EstimatorResult;
  nowMs: number;
}

/** Writes the single minimal-PII estimator_runs row (inputs + result only, no email/name). */
export async function recordEstimatorRun(db: Db, input: RecordEstimatorRunInput): Promise<void> {
  await db.insert(estimatorRuns).values({
    createdAt: new Date(input.nowMs),
    mrrCents: input.mrrCents,
    customerCount: input.customerCount,
    currency: input.currency,
    estimatedLeakageCents: input.result.estimatedLeakageCents,
    benchmarkCohort: input.result.benchmarkCohort,
    resultJson: input.result,
  });
}
