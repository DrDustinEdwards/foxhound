// Churn predictions: the nightly run logs one per paying customer with a horizon, and gradeDuePredictions fills in
// what happened once that horizon has passed.

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "~/db";
import { changedRows, customerContext, predictions } from "~/db";
import { DAY_MS } from "~/lib/constants";

interface PredictionFields {
  accountId: string;
  stripeCustomerId: string;
  score: number;
  horizonDays: number;
  predictedAt: Date;
}

/** The predictions insert for one customer's run; realizedOutcome and gradedAt stay null until gradeDuePredictions
 *  grades the row. Operational, not a money write. */
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
