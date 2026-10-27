import { and, count, desc, eq, gte, inArray, isNull, like } from "drizzle-orm";

import { accounts, customerContext, engagementEvents, failedPayments, recommendationLog, recoverySteps, type Db } from "~/db";
import { DAY_MS } from "~/lib/constants";

import {
  ACTIONABLE_RECOMMENDATIONS,
  recommendCustomer,
  type CustomerRecommendation,
  type RecommendedAction,
} from "./recommend";

// Recova's three recommendation inputs, read from Foxhound's own tables (J78),
// and the list /intelligence/recommendations shows.
//
// Engagement is Recova's: recovery emails sent in the last 30 days (Recova
// counted recovery_steps whose result starts "email_sent", bands.ts
// fetchEmailsSent30d), tracked opens in the same 30 days, and the last tracked
// open. Opens come from engagement_events, Foxhound's first-party tracking,
// which already drops bots, prefetch and HEAD requests. Recova's rules ignore
// clicks, so this does too. Recovery history is customer_context's
// recovery_signals, written by the Intelligence sync. Value is the customer's
// MRR against every customer on the account.
//
// One query per input for the whole account, grouped in memory, as the sync
// does, rather than Recova's two reads per customer.

const ENGAGEMENT_WINDOW_DAYS = 30;

/** Recova's rules_v1, named so a later rule change is told apart in the log. */
const RECOMMENDATION_SCORE_SOURCE = "recova_rules_v1";

export interface RecommendationSubject {
  stripeCustomerId: string;
  mrrContributionCents: number;
  recoverySignals: unknown;
}

interface EngagementTally {
  sent30d: number;
  opened30d: number;
  lastOpenAtMs: number | null;
}

async function loadEngagementTallies(db: Db, accountId: string, nowMs: number): Promise<Map<string, EngagementTally>> {
  const cutoff = new Date(nowMs - ENGAGEMENT_WINDOW_DAYS * DAY_MS);
  const [sends, opens] = await Promise.all([
    db
      .select({ stripeCustomerId: failedPayments.stripeCustomerId, sent: count() })
      .from(recoverySteps)
      .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
      .where(
        and(
          eq(recoverySteps.accountId, accountId),
          eq(failedPayments.accountId, accountId),
          isNull(recoverySteps.deletedAt),
          isNull(failedPayments.deletedAt),
          like(recoverySteps.result, "email_sent%"),
          gte(recoverySteps.executedAt, cutoff),
        ),
      )
      .groupBy(failedPayments.stripeCustomerId),
    db
      .select({ stripeCustomerId: failedPayments.stripeCustomerId, occurredAt: engagementEvents.occurredAt })
      .from(engagementEvents)
      .innerJoin(recoverySteps, eq(recoverySteps.id, engagementEvents.recoveryStepId))
      .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
      .where(
        and(
          eq(engagementEvents.accountId, accountId),
          eq(failedPayments.accountId, accountId),
          eq(engagementEvents.eventType, "open"),
        ),
      ),
  ]);

  const tallies = new Map<string, EngagementTally>();
  const tally = (id: string) => {
    let t = tallies.get(id);
    if (!t) {
      t = { sent30d: 0, opened30d: 0, lastOpenAtMs: null };
      tallies.set(id, t);
    }
    return t;
  };
  for (const s of sends) tally(s.stripeCustomerId).sent30d = s.sent;
  for (const o of opens) {
    const t = tally(o.stripeCustomerId);
    const at = o.occurredAt.getTime();
    if (at >= cutoff.getTime()) t.opened30d += 1;
    if (t.lastOpenAtMs === null || at > t.lastOpenAtMs) t.lastOpenAtMs = at;
  }
  return tallies;
}

function signalCount(signals: unknown, key: "failedPaymentCount" | "recoveredCount"): number {
  if (!signals || typeof signals !== "object") return 0;
  const v = (signals as Record<string, unknown>)[key];
  return typeof v === "number" ? v : 0;
}

/** Recova's rules for every given customer of one account. `subjects` must be
 *  every customer on the account, because the value band is a percentile
 *  across all of them. */
export async function recommendForAccount(
  db: Db,
  accountId: string,
  subjects: readonly RecommendationSubject[],
  nowMs: number,
): Promise<Map<string, CustomerRecommendation>> {
  const tallies = await loadEngagementTallies(db, accountId, nowMs);
  const accountMrrAscending = subjects.map((s) => s.mrrContributionCents).sort((a, b) => a - b);
  const out = new Map<string, CustomerRecommendation>();
  for (const s of subjects) {
    const t = tallies.get(s.stripeCustomerId) ?? { sent30d: 0, opened30d: 0, lastOpenAtMs: null };
    out.set(
      s.stripeCustomerId,
      recommendCustomer({
        engagement: { ...t, nowMs },
        failedPaymentCount: signalCount(s.recoverySignals, "failedPaymentCount"),
        recoveredCount: signalCount(s.recoverySignals, "recoveredCount"),
        mrrContributionCents: s.mrrContributionCents,
        accountMrrAscending,
      }),
    );
  }
  return out;
}

/** The recommendation_log insert for one customer's run. Operational, not a
 *  money write; the outcome slot is left null for a later grading pass. */
export function buildRecommendationLogInsert(
  db: Db,
  input: { accountId: string; stripeCustomerId: string; result: CustomerRecommendation; currency: string; now: Date },
) {
  const { result } = input;
  return db.insert(recommendationLog).values({
    accountId: input.accountId,
    stripeCustomerId: input.stripeCustomerId,
    recommendedAt: input.now,
    action: result.recommendation.action,
    confidence: result.recommendation.confidence,
    rationale: result.recommendation.rationale,
    engagementBand: result.engagement.band,
    recoveryBand: result.history.band,
    valueBand: result.value.band,
    evidence: {
      engagement: { confidence: result.engagement.confidence, ...result.engagement.evidence },
      recoveryHistory: { confidence: result.history.confidence, ...result.history.evidence },
      customerValue: { confidence: result.value.confidence, ...result.value.evidence },
    },
    annualizedMrrAtRiskCents: result.recommendation.annualizedMrrAtRiskCents,
    currency: result.recommendation.annualizedMrrAtRiskCents === null ? null : input.currency,
    scoreSource: RECOMMENDATION_SCORE_SOURCE,
  });
}

// ---- the page's read ----------------------------------------------------------------

export const RECOMMENDATIONS_PAGE_SIZE = 50;

export interface RecommendationRow {
  stripeCustomerId: string;
  customerName: string | null;
  planName: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  recommendedAction: RecommendedAction;
}

/** Recova's fetchActionableRecommendations (customer-context-ssr.ts, blob
 *  a499c285): the account's customers whose action asks for attention, highest
 *  MRR first, a page of 50, with the total. */
export async function listActionableRecommendations(
  db: Db,
  accountId: string,
  page: number,
): Promise<{ rows: RecommendationRow[]; totalCount: number }> {
  const where = and(
    eq(customerContext.accountId, accountId),
    inArray(customerContext.recommendedAction, [...ACTIONABLE_RECOMMENDATIONS]),
  );
  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(customerContext).where(where),
    db
      .select({
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        planName: customerContext.currentPlanName,
        mrrContributionCents: customerContext.mrrContributionCents,
        currency: customerContext.currency,
        accountCurrency: accounts.currency,
        healthScore: customerContext.healthScore,
        recommendedAction: customerContext.recommendedAction,
      })
      .from(customerContext)
      .innerJoin(accounts, eq(accounts.id, customerContext.accountId))
      .where(where)
      // Recova's order('mrr_contribution_cents', { ascending: false, nullsFirst: false })
      .orderBy(isNull(customerContext.mrrContributionCents), desc(customerContext.mrrContributionCents))
      .limit(RECOMMENDATIONS_PAGE_SIZE)
      .offset((page - 1) * RECOMMENDATIONS_PAGE_SIZE),
  ]);
  return {
    totalCount: total?.n ?? 0,
    rows: rows.map(({ accountCurrency, ...r }) => ({
      ...r,
      mrrContributionCents: r.mrrContributionCents ?? 0,
      // The sync leaves customer_context.currency null and reports MRR in the
      // account's currency (signals.ts), so that is the fallback.
      currency: r.currency ?? accountCurrency ?? "usd",
      recommendedAction: r.recommendedAction as RecommendedAction,
    })),
  };
}
