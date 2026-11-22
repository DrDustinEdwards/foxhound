import { and, eq } from "drizzle-orm";

import type { Db } from "~/db";
import { benchmarkData, estimatorRuns } from "~/db";

// No-auth estimator: looks up seeded benchmark_data rows (drizzle/seed/benchmark_data.sql) by MRR band and
// produces a directional leakage ESTIMATE with a stated range, never a platform-derived recovery-rate claim.

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
  /** The seed's p25/p75 spread, stored with the run but not shown: the seed is an interpolation, not a study. */
  low: number;
  high: number;
  medianPct: number;
  sampleSize: number;
}

/** Directional leakage estimate (median of the percentile range times MRR) plus the p25/p75 spread. Null
 *  when no benchmark row exists for the band, which the caller renders as "not enough data", never a made-up number. */
export async function estimateLeakage(
  db: Db,
  input: EstimatorInput,
): Promise<EstimatorResult | null> {
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
