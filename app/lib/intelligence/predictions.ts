// Prediction logging: every prediction is logged with a horizon and a realized-outcome slot. This file only LOGS;
// grading (filling realizedOutcome once the horizon elapses) is a later backtest pass.

import { fnv1a32 } from "@dustinedwards/site-runtime/encoding";
import type { Db } from "~/db";
import { predictions } from "~/db";
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

/** One predictions row's field values from a computed health score. realizedOutcome / gradedAt stay null until a
 *  backtest pass fills them once horizonDays has elapsed. */
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
