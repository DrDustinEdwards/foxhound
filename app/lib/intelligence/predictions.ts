// Churn predictions: the nightly run logs one per paying customer with a horizon, and gradeDuePredictions fills in
// what happened once that horizon has passed.

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { fnv1a32 } from "@dustinedwards/site-runtime/encoding";
import type { Db } from "~/db";
import { changedRows, customerContext, predictions } from "~/db";
import { DAY_MS } from "~/lib/constants";
import type { HealthFactor } from "./risk";

/** Deterministic, stable hash of the factor bands behind a score, so identical evidence hashes identically (for
 *  backtest bucketing) without an async crypto call. FNV-1a over the sorted factor list; not a security hash. */
export function hashFactorBands(factors: HealthFactor[]): string {
  const sorted = [...factors].sort((a, b) => a.signal.localeCompare(b.signal));
  const input = JSON.stringify(sorted.map((f) => [f.signal, f.deltaPoints]));
  return fnv1a32(input);
}

export interface PredictionFields {
  accountId: string;
  stripeCustomerId: string;
  score: number;
  bandEvidenceHash: string;
  horizonDays: number;
  predictedAt: Date;
}

/** One predictions row's field values from a computed health score. realizedOutcome / gradedAt stay null until
 *  gradeDuePredictions grades the row. */
export function buildPredictionFields(input: {
  accountId: string;
  stripeCustomerId: string;
  score: number;
  factors: HealthFactor[];
  horizonDays: number;
  predictedAt: Date;
}): PredictionFields {
  return {
    accountId: input.accountId,
    stripeCustomerId: input.stripeCustomerId,
    score: input.score,
    bandEvidenceHash: hashFactorBands(input.factors),
    horizonDays: input.horizonDays,
    predictedAt: input.predictedAt,
  };
}

/** The predictions insert for one customer's run. Operational, not a money write. */
export function buildPredictionInsert(db: Db, fields: PredictionFields) {
  return db.insert(predictions).values(fields);
}

type PredictionOutcome = "retained" | "churned";

/** Grade this account's due predictions in one UPDATE: "churned" once the customer's MRR (or the customer) is gone. */
export async function gradeDuePredictions(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<number> {
  const stillPaying = sql`exists (select 1 from ${customerContext} where ${customerContext.accountId} = ${predictions.accountId} and ${customerContext.stripeCustomerId} = ${predictions.stripeCustomerId} and coalesce(${customerContext.mrrContributionCents}, 0) > 0)`;
  const outcome = sql<PredictionOutcome>`case when ${stillPaying} then 'retained' else 'churned' end`;
  const result = await db
    .update(predictions)
    .set({ realizedOutcome: outcome, gradedAt: new Date(nowMs) })
    .where(
      and(
        eq(predictions.accountId, accountId),
        isNull(predictions.gradedAt),
        lte(sql`${predictions.predictedAt} + ${predictions.horizonDays} * ${DAY_MS}`, nowMs),
      ),
    );
  return changedRows(result);
}
