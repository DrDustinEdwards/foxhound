import type { BatchItem } from "drizzle-orm/batch";
import { and, eq, isNull } from "drizzle-orm";

import {
  customerContext,
  disputes,
  engagementEvents,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  type Db,
} from "~/db";
import type {
  CustomerContextFields,
  DisputeSignalRow,
  EngagementSignalRow,
  RecoverySignalRow,
} from "./signals";
import type { ScheduledChange } from "./subscription-terms";

// The sync's D1 side: Foxhound's own history read once per run, and the customer_context upsert (see sync.server.ts).

/** Foxhound's own recovery/dispute/engagement history, read once per run and grouped by stripeCustomerId
 *  in memory (avoids an N+1 query per customer). */
export async function fetchFoxhoundHistoryByCustomer(db: Db, accountId: string) {
  const [recoveryRows, disputeRows, engagementRows] = await Promise.all([
    db
      .select({
        stripeCustomerId: failedPayments.stripeCustomerId,
        status: failedPayments.status,
        daysToRecover: recoveredPayments.daysToRecover,
      })
      .from(failedPayments)
      .leftJoin(recoveredPayments, eq(recoveredPayments.failedPaymentId, failedPayments.id))
      .where(and(eq(failedPayments.accountId, accountId), isNull(failedPayments.deletedAt))),
    db
      .select({ stripeCustomerId: disputes.stripeCustomerId, state: disputes.state })
      .from(disputes)
      .where(eq(disputes.accountId, accountId)),
    db
      .select({
        stripeCustomerId: failedPayments.stripeCustomerId,
        eventType: engagementEvents.eventType,
        occurredAt: engagementEvents.occurredAt,
      })
      .from(engagementEvents)
      .innerJoin(recoverySteps, eq(recoverySteps.id, engagementEvents.recoveryStepId))
      .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
      .where(eq(engagementEvents.accountId, accountId)),
  ]);

  const byCustomer = <T>(): Map<string, T[]> => new Map<string, T[]>();
  const recovery = byCustomer<RecoverySignalRow>();
  for (const r of recoveryRows) {
    const list = recovery.get(r.stripeCustomerId) ?? [];
    list.push({ status: r.status, daysToRecover: r.daysToRecover });
    recovery.set(r.stripeCustomerId, list);
  }
  const dispute = byCustomer<DisputeSignalRow>();
  for (const d of disputeRows) {
    if (!d.stripeCustomerId) continue;
    const list = dispute.get(d.stripeCustomerId) ?? [];
    list.push({ state: d.state });
    dispute.set(d.stripeCustomerId, list);
  }
  const engagement = byCustomer<EngagementSignalRow>();
  for (const e of engagementRows) {
    const list = engagement.get(e.stripeCustomerId) ?? [];
    list.push({ eventType: e.eventType, occurredAt: e.occurredAt.getTime() });
    engagement.set(e.stripeCustomerId, list);
  }
  return { recovery, dispute, engagement };
}

export function buildCustomerContextUpsert(
  db: Db,
  input: {
    accountId: string;
    stripeCustomerId: string;
    customerEmail: string | null;
    customerName: string | null;
    customerSince: Date;
    now: Date;
    fields: CustomerContextFields;
    scheduledChange: ScheduledChange | null;
  },
): BatchItem<"sqlite"> {
  const { fields } = input;
  const shared = {
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    customerSince: input.customerSince,
    lastSeenAt: input.now,
    mrrContributionCents: fields.mrrContributionCents,
    activeSubscriptionsCount: fields.activeSubscriptionsCount,
    currentPlanName: fields.currentPlanName,
    recoverySignals: fields.recoverySignals,
    disputeSignals: fields.disputeSignals,
    engagementSignals: fields.engagementSignals,
    subscriptionAgeDays: fields.subscriptionAgeDays,
    planChangeCount: fields.planChangeCount,
    seatChangeCount: fields.seatChangeCount,
    intervalSwitchCount: fields.intervalSwitchCount,
    paymentLatencyDriftDays: fields.paymentLatencyDriftDays,
    refundCount: fields.refundCount,
    disputeCount: fields.disputeCount,
    scheduledChangeKind: input.scheduledChange?.kind ?? null,
    scheduledChangeAt: input.scheduledChange ? new Date(input.scheduledChange.atMs) : null,
    updatedAt: input.now,
  };
  // onConflictDoUpdate's `set` omits healthScore / healthFactors / aiAssessment / aiAssessmentGeneratedAt /
  // aiRecommendedActions / currentPlanTier so a re-run never clobbers what the AI half wrote; currency and
  // ltvCents are omitted because nothing sources them (see signals.ts buildCustomerContextFields).
  return db
    .insert(customerContext)
    .values({
      accountId: input.accountId,
      stripeCustomerId: input.stripeCustomerId,
      createdAt: input.now,
      ...shared,
    })
    .onConflictDoUpdate({
      target: [customerContext.accountId, customerContext.stripeCustomerId],
      set: shared,
    });
}
