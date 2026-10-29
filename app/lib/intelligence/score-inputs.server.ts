import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";

import { customerContext, failedPayments, subscriptionChanges, type Db } from "~/db";

import { computeHealthScore, type HealthScoreInput } from "./risk";
import type { EngagementSignals, RecoverySignals } from "./signals";
import {
  summarizeSubscriptionChanges,
  type SubscriptionChangeRow,
  type SubscriptionChangeState,
} from "./subscription-change";

// The health score's inputs that are not customer_context columns: the
// recorded subscription changes (subscription_changes, from the webhook) and
// the card funding on the customer's latest failed payment. Read by the nightly
// scoring batch (ai-run.server.ts) for every customer, and by rescoreCustomer
// for one, so both score from the same inputs and neither undoes the other.

export interface ScoreExtras {
  subscriptionChanges: SubscriptionChangeState | null;
  latestFailedCardFunding: string | null;
}

/** Per customer, for the account or for one customer of it. */
export async function loadScoreExtras(
  db: Db,
  accountId: string,
  nowMs: number,
  stripeCustomerId?: string,
): Promise<Map<string, ScoreExtras>> {
  const [changeRows, cardRows] = await Promise.all([
    db
      .select({
        stripeCustomerId: subscriptionChanges.stripeCustomerId,
        stripeSubscriptionId: subscriptionChanges.stripeSubscriptionId,
        kind: subscriptionChanges.kind,
        cancelAt: subscriptionChanges.cancelAt,
        resumesAt: subscriptionChanges.resumesAt,
        occurredAt: subscriptionChanges.occurredAt,
      })
      .from(subscriptionChanges)
      .where(and(eq(subscriptionChanges.accountId, accountId), stripeCustomerId ? eq(subscriptionChanges.stripeCustomerId, stripeCustomerId) : undefined))
      .orderBy(asc(subscriptionChanges.occurredAt), asc(subscriptionChanges.createdAt)),
    db
      .select({ stripeCustomerId: failedPayments.stripeCustomerId, cardFunding: failedPayments.cardFunding })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.accountId, accountId),
          isNull(failedPayments.deletedAt),
          isNotNull(failedPayments.cardFunding),
          stripeCustomerId ? eq(failedPayments.stripeCustomerId, stripeCustomerId) : undefined,
        ),
      )
      .orderBy(desc(failedPayments.detectedAt)),
  ]);

  const changesBy = new Map<string, SubscriptionChangeRow[]>();
  for (const { stripeCustomerId: id, ...row } of changeRows) {
    const list = changesBy.get(id) ?? [];
    list.push(row);
    changesBy.set(id, list);
  }
  const extras = new Map<string, ScoreExtras>();
  const entry = (id: string) => {
    let e = extras.get(id);
    if (!e) {
      e = { subscriptionChanges: null, latestFailedCardFunding: null };
      extras.set(id, e);
    }
    return e;
  };
  for (const [id, rows] of changesBy) entry(id).subscriptionChanges = summarizeSubscriptionChanges(rows, nowMs);
  // Newest first, so the first row seen per customer is the latest.
  for (const row of cardRows) {
    const e = entry(row.stripeCustomerId);
    if (e.latestFailedCardFunding === null) e.latestFailedCardFunding = row.cardFunding;
  }
  return extras;
}

/** The customer_context columns the score reads. */
export const scoreColumns = {
  subscriptionAgeDays: customerContext.subscriptionAgeDays,
  planChangeCount: customerContext.planChangeCount,
  seatChangeCount: customerContext.seatChangeCount,
  intervalSwitchCount: customerContext.intervalSwitchCount,
  paymentLatencyDriftDays: customerContext.paymentLatencyDriftDays,
  refundCount: customerContext.refundCount,
  disputeCount: customerContext.disputeCount,
  recoverySignals: customerContext.recoverySignals,
  engagementSignals: customerContext.engagementSignals,
};

type ScoreColumnRow = {
  subscriptionAgeDays: number | null;
  planChangeCount: number | null;
  seatChangeCount: number | null;
  intervalSwitchCount: number | null;
  paymentLatencyDriftDays: number | null;
  refundCount: number | null;
  disputeCount: number | null;
  recoverySignals: unknown;
  engagementSignals: unknown;
};

/** One customer's score input from its customer_context row and extras. */
export function healthScoreInput(row: ScoreColumnRow, extras: ScoreExtras | undefined, nowMs: number): HealthScoreInput {
  return {
    nowMs,
    subscriptionAgeDays: row.subscriptionAgeDays,
    planChangeCount: row.planChangeCount,
    seatChangeCount: row.seatChangeCount,
    intervalSwitchCount: row.intervalSwitchCount,
    paymentLatencyDriftDays: row.paymentLatencyDriftDays,
    refundCount: row.refundCount,
    disputeCount: row.disputeCount,
    recoverySignals: row.recoverySignals as RecoverySignals | null,
    engagementSignals: row.engagementSignals as EngagementSignals | null,
    subscriptionChanges: extras?.subscriptionChanges ?? null,
    latestFailedCardFunding: extras?.latestFailedCardFunding ?? null,
  };
}

/**
 * Re-scores one customer now, from the same inputs the nightly batch reads,
 * and writes the score and factors to customer_context: what the nightly batch
 * would write if it ran this minute. The alerts read health_score on the
 * recovery tick (alert-run.server.ts), so a scheduled cancellation reaches the
 * high-risk count and the critical customers check within minutes. Writes no
 * history, prediction or recommendation row: those stay one per night. Returns
 * the new score, or null when the customer has no customer_context row yet (the
 * next daily sync creates it, and the nightly batch scores it with the change).
 */
export async function rescoreCustomer(
  db: Db,
  accountId: string,
  stripeCustomerId: string,
  now: Date,
): Promise<number | null> {
  const [row] = await db
    .select({ id: customerContext.id, ...scoreColumns })
    .from(customerContext)
    .where(and(eq(customerContext.accountId, accountId), eq(customerContext.stripeCustomerId, stripeCustomerId)))
    .limit(1);
  if (!row) return null;
  const extras = await loadScoreExtras(db, accountId, now.getTime(), stripeCustomerId);
  const { score, factors } = computeHealthScore(healthScoreInput(row, extras.get(stripeCustomerId), now.getTime()));
  await db
    .update(customerContext)
    .set({ healthScore: score, healthFactors: factors, healthScoreCalculatedAt: now })
    .where(eq(customerContext.id, row.id));
  return score;
}
