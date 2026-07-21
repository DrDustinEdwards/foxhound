// Prediction logging (PRICING.md: "Every prediction logged with horizon +
// realized-outcome slot. Accuracy claims in marketing only after backtests
// support them."). This file only LOGS predictions; grading (filling
// realizedOutcome once the horizon elapses) is a later backtest pass, out of
// scope for TASK-foxhound-intelligence-ai.md.

import type { Db } from "~/db";
import { predictions } from "~/db";
import type { HealthFactor } from "./risk";

/**
 * Deterministic, stable hash of the factor bands that produced a score, so
 * two predictions with identical evidence hash identically (grouping /
 * backtest-bucketing), without an async crypto call. Not a security hash:
 * collisions are acceptable, cryptographic strength is not the goal. FNV-1a
 * over the sorted, stringified factor list (sorted so factor emission order
 * never changes the hash).
 */
export function hashFactorBands(factors: HealthFactor[]): string {
  const sorted = [...factors].sort((a, b) => a.signal.localeCompare(b.signal));
  const input = JSON.stringify(sorted.map((f) => [f.signal, f.deltaPoints]));
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface PredictionFields {
  accountId: string;
  stripeCustomerId: string;
  score: number;
  bandEvidenceHash: string;
  horizonDays: number;
  predictedAt: Date;
}

/** Build one predictions row's field values from a computed health score.
 *  realizedOutcome / gradedAt are left unset (null by column default): a
 *  later backtest pass fills them once horizonDays has elapsed. */
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

/** The predictions insert for one customer's run. Operational, not a money
 *  write (mirrors app/lib/ai/cost.ts's buildAiCallRow shape). */
export function buildPredictionInsert(db: Db, fields: PredictionFields) {
  return db.insert(predictions).values(fields);
}
