import { and, eq, gte, isNull, lte, ne, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  accounts,
  alertHistory,
  alerts,
  customerContext,
  disputes,
  failedPayments,
  getDb,
  healthScoreHistory,
  intelligenceReports,
  type Db,
} from "~/db";
import { buildAiCallRow } from "~/lib/ai/cost";
import {
  FAILED_PAYMENT_STATUS_ACTIVE,
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_NARRATIVE_TOP_N,
  MODEL_INTELLIGENCE_NARRATIVE,
  PREDICTION_HORIZON_DAYS,
} from "~/lib/constants";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";
import { RESOLVED_DISPUTE_STATES } from "~/lib/disputes/labels";

import {
  CRITICAL_CUSTOMERS_ALERT_LIVE,
  loadAlertTarget,
  notifyCriticalCustomers,
  notifyThresholdAlert,
  type CriticalNotifyOutcome,
} from "./alert-notify.server";
import {
  ALERT_COOLDOWN_WINDOW_MS,
  CRITICAL_CUSTOMERS_METRIC,
  CRITICAL_HEALTH_SCORE_MAX,
  buildAlertHistoryInsert,
  buildCriticalAlertHistoryInsert,
  buildAlertLastTriggeredUpdate,
  evaluateAlerts,
  type AlertConfig,
} from "./alerts";
import {
  generateIntelligenceNarrative,
  type AtRiskCustomerFact,
  type NarrativeFacts,
  type NarrativeResult,
} from "./narrative";
import { buildPredictionFields, buildPredictionInsert } from "./predictions";
import type { CustomerRecommendation } from "./recommend";
import { buildRecommendationLogInsert, recommendForAccount } from "./recommendations.server";
import { computeHealthScore, type HealthFactor } from "./risk";
import type { EngagementSignals, RecoverySignals } from "./signals";
import { accountProcessingEligible } from "./sync.server";

// The Intelligence AI half's nightly orchestration: scoring -> predictions ->
// alerts -> narrative, for one account, then for every processing-eligible
// account (TASK-foxhound-intelligence-ai.md deliverable 5). Consumes the
// deterministic signals customer_context/mrr_snapshots already carry
// (app/lib/intelligence/{signals,mrr,sync.server}.ts); never recomputes them.
//
// Score/predict/alert are deterministic and always commit. The narrative (the
// one paid AI call) is wrapped separately and fails safe: a missing/unfunded
// ANTHROPIC_API_KEY, or any model-call error, is caught here and reported as
// a skipped narrative, never as a failed run (the deterministic rows above
// already landed by then).

interface ScoredCustomer {
  customerContextId: string;
  stripeCustomerId: string;
  customerName: string | null;
  mrrContributionCents: number;
  score: number;
  factors: HealthFactor[];
  /** Recova's recommendation rules' result (J78). */
  recommendation: CustomerRecommendation;
}

async function scoreAccountCustomers(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<ScoredCustomer[]> {
  const rows = await db
    .select({
      id: customerContext.id,
      stripeCustomerId: customerContext.stripeCustomerId,
      customerName: customerContext.customerName,
      mrrContributionCents: customerContext.mrrContributionCents,
      subscriptionAgeDays: customerContext.subscriptionAgeDays,
      planChangeCount: customerContext.planChangeCount,
      seatChangeCount: customerContext.seatChangeCount,
      intervalSwitchCount: customerContext.intervalSwitchCount,
      paymentLatencyDriftDays: customerContext.paymentLatencyDriftDays,
      refundCount: customerContext.refundCount,
      disputeCount: customerContext.disputeCount,
      recoverySignals: customerContext.recoverySignals,
      engagementSignals: customerContext.engagementSignals,
    })
    .from(customerContext)
    .where(eq(customerContext.accountId, accountId));

  const recommendations = await recommendForAccount(
    db,
    accountId,
    rows.map((row) => ({
      stripeCustomerId: row.stripeCustomerId,
      mrrContributionCents: row.mrrContributionCents ?? 0,
      recoverySignals: row.recoverySignals,
    })),
    nowMs,
  );

  return rows.map((row) => {
    const { score, factors } = computeHealthScore({
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
    });
    return {
      customerContextId: row.id,
      stripeCustomerId: row.stripeCustomerId,
      customerName: row.customerName,
      mrrContributionCents: row.mrrContributionCents ?? 0,
      score,
      factors,
      // recommendForAccount returns one entry per row it was given.
      recommendation: recommendations.get(row.stripeCustomerId)!,
    };
  });
}

/** One customer's writes: score and recommended action, history append,
 *  prediction log, recommendation log. None is a money write, and nothing on a
 *  money path reads recommended_action. */
function buildCustomerScoringWrites(
  db: Db,
  accountId: string,
  c: ScoredCustomer,
  now: Date,
  currency: string,
): BatchItem<"sqlite">[] {
  return [
    db
      .update(customerContext)
      .set({
        healthScore: c.score,
        healthFactors: c.factors,
        healthScoreCalculatedAt: now,
        recommendedAction: c.recommendation.recommendation.action,
      })
      .where(eq(customerContext.id, c.customerContextId)),
    db.insert(healthScoreHistory).values({
      accountId,
      customerContextId: c.customerContextId,
      stripeCustomerId: c.stripeCustomerId,
      recordedAt: now,
      healthScore: c.score,
      healthFactors: c.factors,
      scoreSource: "deterministic_v1",
    }),
    buildPredictionInsert(
      db,
      buildPredictionFields({
        accountId,
        stripeCustomerId: c.stripeCustomerId,
        score: c.score,
        factors: c.factors,
        horizonDays: PREDICTION_HORIZON_DAYS,
        predictedAt: now,
      }),
    ),
    buildRecommendationLogInsert(db, {
      accountId,
      stripeCustomerId: c.stripeCustomerId,
      result: c.recommendation,
      currency,
      now,
    }),
  ];
}

function buildScoringBatch(
  db: Db,
  accountId: string,
  scored: ScoredCustomer[],
  now: Date,
  currency: string,
): BatchItem<"sqlite">[] {
  return scored.flatMap((c) => buildCustomerScoringWrites(db, accountId, c, now, currency));
}

export interface AccountAiRunResult {
  accountId: string;
  customersScored: number;
  alertsFired: number;
  narrativeGenerated: boolean;
  narrativeSkippedReason: string | null;
}

export async function runIntelligenceAiForAccount(
  env: Env,
  accountId: string,
  nowMs: number,
): Promise<AccountAiRunResult> {
  const db = getDb(env);
  const now = new Date(nowMs);

  const [account, scored] = await Promise.all([
    db.select({ name: accounts.name, currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    scoreAccountCustomers(db, accountId, nowMs),
  ]);
  const currency = account[0]?.currency ?? "usd";
  const accountName = account[0]?.name ?? "the business";

  if (scored.length > 0) {
    const batch = buildScoringBatch(db, accountId, scored, now, currency);
    await db.batch([batch[0], ...batch.slice(1)]);
  }

  const atRisk = scored
    .filter((c) => c.score < HEALTH_SCORE_AT_RISK_THRESHOLD)
    .sort((a, b) => a.score - b.score);
  const mrrAtRiskCents = atRisk.reduce((sum, c) => sum + c.mrrContributionCents, 0);
  const healthScoreAvg =
    scored.length > 0 ? scored.reduce((sum, c) => sum + c.score, 0) / scored.length : undefined;

  const mrr = await getMrrAnalytics(db, accountId);
  const metrics: Record<string, number> = {};
  if (healthScoreAvg !== undefined) metrics.health_score_avg = healthScoreAvg;
  metrics.mrr_at_risk_cents = mrrAtRiskCents;
  if (mrr.latest) {
    metrics.mrr_churn_cents = mrr.latest.churnMrrCents;
    metrics.mrr_contraction_cents = mrr.latest.contractionMrrCents;
  }

  const alertsFired = await evaluateAndRecordAlerts(env, db, accountId, metrics, now);
  // E22, Recova's always-on critical customers check, after the configured
  // alerts as Recova runs it, now that its button has a page (RULES.md 2.7).
  if (CRITICAL_CUSTOMERS_ALERT_LIVE) await runCriticalCustomersCheck(env, db, accountId, now);

  let narrativeGenerated = false;
  let narrativeSkippedReason: string | null = null;
  try {
    const result = await generateIntelligenceNarrative(
      env,
      narrativeFactsFor({ accountName, currency, mrrLatest: mrr.latest, scored }),
    );
    await writeNarrativeReport(db, { accountId, now, result, scored });
    narrativeGenerated = result.usage !== null;
  } catch (err) {
    narrativeSkippedReason = err instanceof Error ? err.message : "narrative generation failed";
  }

  return {
    accountId,
    customersScored: scored.length,
    alertsFired,
    narrativeGenerated,
    narrativeSkippedReason,
  };
}

/** The ai_calls source the narrative logs under, nightly or on request. */
const NARRATIVE_AI_SOURCE = "intelligence_narrative";

/** A scored customer as the narrative needs it: from tonight's scoring run,
 *  or from the scores customer_context holds when a merchant asks for a
 *  report during the day (report-generate.server.ts). */
export interface NarrativeCustomer {
  customerContextId: string;
  stripeCustomerId: string;
  customerName: string | null;
  mrrContributionCents: number;
  score: number;
  factors: readonly { detail: string }[];
}

/** The narrative's facts: the latest MRR snapshot's movements and the at-risk
 *  customers, lowest score first, capped at INTELLIGENCE_NARRATIVE_TOP_N. One
 *  computation for both the nightly run and the dashboard's button. */
export function narrativeFactsFor(input: {
  accountName: string;
  currency: string;
  mrrLatest: {
    totalMrrCents: number;
    newMrrCents: number;
    expansionMrrCents: number;
    contractionMrrCents: number;
    churnMrrCents: number;
    reactivationMrrCents: number;
  } | null;
  scored: readonly NarrativeCustomer[];
}): NarrativeFacts {
  const { accountName, currency, mrrLatest, scored } = input;
  const atRisk = scored
    .filter((c) => c.score < HEALTH_SCORE_AT_RISK_THRESHOLD)
    .sort((a, b) => a.score - b.score);
  const topAtRiskCustomers: AtRiskCustomerFact[] = atRisk.slice(0, INTELLIGENCE_NARRATIVE_TOP_N).map((c) => ({
    stripeCustomerId: c.stripeCustomerId,
    customerName: c.customerName,
    healthScore: c.score,
    mrrContributionCents: c.mrrContributionCents,
    currency,
    factorDetails: c.factors.map((f) => f.detail),
  }));
  return {
    accountName,
    currency,
    totalMrrCents: mrrLatest?.totalMrrCents ?? 0,
    newMrrCents: mrrLatest?.newMrrCents ?? 0,
    expansionMrrCents: mrrLatest?.expansionMrrCents ?? 0,
    contractionMrrCents: mrrLatest?.contractionMrrCents ?? 0,
    churnMrrCents: mrrLatest?.churnMrrCents ?? 0,
    reactivationMrrCents: mrrLatest?.reactivationMrrCents ?? 0,
    mrrAtRiskCents: atRisk.reduce((sum, c) => sum + c.mrrContributionCents, 0),
    atRiskCustomerCount: atRisk.length,
    topAtRiskCustomers,
  };
}

/** The one writer of intelligence_reports: this month's report (upserted, so
 *  a regenerate replaces it), each assessment on its own customer, and the AI
 *  call's cost row, in one batch. */
export async function writeNarrativeReport(
  db: Db,
  input: { accountId: string; now: Date; result: NarrativeResult; scored: readonly NarrativeCustomer[] },
): Promise<void> {
  const { accountId, now, result, scored } = input;
  const reportMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const idByCustomer = new Map(scored.map((c) => [c.stripeCustomerId, c.customerContextId]));
  const narrativeBatch: BatchItem<"sqlite">[] = [
    db.insert(intelligenceReports)
      .values({ accountId, reportMonth, narrative: result.narrative, generatedAt: now })
      .onConflictDoUpdate({
        target: [intelligenceReports.accountId, intelligenceReports.reportMonth],
        set: { narrative: result.narrative, generatedAt: now },
      }),
  ];
  for (const a of result.customerAssessments) {
    const customerContextId = idByCustomer.get(a.stripeCustomerId);
    if (!customerContextId) continue; // structural guard: never write an id we did not send
    narrativeBatch.push(
      db.update(customerContext)
        .set({ aiAssessment: a.assessment, aiAssessmentGeneratedAt: now })
        .where(eq(customerContext.id, customerContextId)),
    );
  }
  if (result.usage) {
    narrativeBatch.push(
      buildAiCallRow(db, {
        accountId,
        source: NARRATIVE_AI_SOURCE,
        model: MODEL_INTELLIGENCE_NARRATIVE,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        relatedId: null,
        createdAt: now,
      }),
    );
  }
  await db.batch([narrativeBatch[0], ...narrativeBatch.slice(1)]);
}

/**
 * Evaluate the account's enabled alerts and, for each that fires, notify and
 * then record, in Recova's order (lib/alert-evaluation.ts, blob 0e28ecbf):
 * the email or Slack post first, then the alert_history row with whether it
 * went, then last_triggered_at, which starts the 24 hour cooldown. Returns the
 * number of alerts that fired. A notification never throws (alert-notify), so
 * one failed send never stops the next alert or the run.
 */
export async function evaluateAndRecordAlerts(
  env: Env,
  db: Db,
  accountId: string,
  metrics: Record<string, number>,
  now: Date,
): Promise<number> {
  const configs: AlertConfig[] = await db
    .select({
      id: alerts.id,
      accountId: alerts.accountId,
      metric: alerts.metric,
      thresholdValue: alerts.thresholdValue,
      direction: alerts.direction,
      channel: alerts.channel,
      lastTriggeredAt: alerts.lastTriggeredAt,
    })
    .from(alerts)
    .where(and(eq(alerts.accountId, accountId), eq(alerts.enabled, true)));
  if (configs.length === 0) return 0;

  const firings = evaluateAlerts(configs, metrics, now.getTime());
  if (firings.length === 0) return 0;

  const target = await loadAlertTarget(db, accountId);
  for (const f of firings) {
    const outcome = await notifyThresholdAlert(env, target, f, now);
    await db.batch([
      buildAlertHistoryInsert(db, f, now, outcome.sent),
      buildAlertLastTriggeredUpdate(db, f.alertId, now),
    ]);
  }
  return firings.length;
}

export type CriticalCustomersOutcome =
  | { kind: "skipped"; reason: "cooldown" | "none_critical" }
  | {
      kind: "fired";
      count: number;
      channel: "email" | "slack" | "none";
      notificationSent: boolean;
      detail: CriticalNotifyOutcome["detail"];
    }
  | { kind: "error"; message: string };

/**
 * The customers that are critical now: an active, undeleted failed payment, a
 * customer_context health score of 33 or less, and an open dispute, for the
 * same Stripe customer on the same account. One query with joins rather than
 * Recova's three reads with growing id lists, because D1 caps bound
 * parameters (RULES.md 3.11).
 *
 * "OPEN" IS FOXHOUND'S. Recova reads disputes.status in (needs_response,
 * under_review); Foxhound stores Stripe's status at intake and never updates
 * it, and keeps the dispute's life in `state`, so open is a state not yet
 * resolved, the same predicate the digest counts (RULES.md 3.20). The dispute's
 * customer is stripe_customer_id, which Foxhound writes at intake; Recova's
 * customer_id is a provenance column here.
 */
async function findCriticalCustomerIds(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ stripeCustomerId: failedPayments.stripeCustomerId })
    .from(failedPayments)
    .innerJoin(
      customerContext,
      and(
        eq(customerContext.accountId, failedPayments.accountId),
        eq(customerContext.stripeCustomerId, failedPayments.stripeCustomerId),
      ),
    )
    .innerJoin(
      disputes,
      and(eq(disputes.accountId, failedPayments.accountId), eq(disputes.stripeCustomerId, failedPayments.stripeCustomerId)),
    )
    .where(
      and(
        eq(failedPayments.accountId, accountId),
        eq(failedPayments.status, FAILED_PAYMENT_STATUS_ACTIVE),
        isNull(failedPayments.deletedAt),
        // Recova drops the empty string its webhook writes for a missing customer.
        ne(failedPayments.stripeCustomerId, ""),
        lte(customerContext.healthScore, CRITICAL_HEALTH_SCORE_MAX),
        notInArray(disputes.state, [...RESOLVED_DISPUTE_STATES]),
      ),
    );
  return rows.map((r) => r.stripeCustomerId);
}

/**
 * Recova's cross-product critical customer check (E22), for one account, in
 * Recova's order: the cooldown on the account's last cross_product_critical
 * row, the customers, the notification (notifyCriticalCustomers: email first,
 * Slack without an address), then one alert_history row with whether it went.
 * The row is written here, not in the notification module (RULES.md 3.2), as
 * evaluateAndRecordAlerts does for E21. Never throws.
 */
export async function runCriticalCustomersCheck(
  env: Env,
  db: Db,
  accountId: string,
  now: Date,
): Promise<CriticalCustomersOutcome> {
  try {
    const [recent] = await db
      .select({ id: alertHistory.id })
      .from(alertHistory)
      .where(
        and(
          eq(alertHistory.accountId, accountId),
          eq(alertHistory.metric, CRITICAL_CUSTOMERS_METRIC),
          gte(alertHistory.firedAt, new Date(now.getTime() - ALERT_COOLDOWN_WINDOW_MS)),
        ),
      )
      .limit(1);
    if (recent) return { kind: "skipped", reason: "cooldown" };

    const critical = await findCriticalCustomerIds(db, accountId);
    if (critical.length === 0) return { kind: "skipped", reason: "none_critical" };
    const count = critical.length;

    const sent = await notifyCriticalCustomers(env, db, accountId, count, now);
    await buildCriticalAlertHistoryInsert(db, {
      accountId,
      count,
      channel: sent.channel,
      notificationSent: sent.notificationSent,
      firedAt: now,
    });
    return { kind: "fired", count, ...sent };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`critical customers alert failed for account ${accountId}:`, message);
    return { kind: "error", message };
  }
}

/** The full nightly AI run: every processing-eligible account. Mirrors
 *  runIntelligenceSyncForAllAccounts's per-account try/catch-continue (one
 *  account's failure never aborts the rest). */
export async function runIntelligenceAiForAllAccounts(
  env: Env,
  nowMs: number,
): Promise<AccountAiRunResult[]> {
  const db = getDb(env);
  const eligible = await db.select({ id: accounts.id }).from(accounts).where(accountProcessingEligible());

  const results: AccountAiRunResult[] = [];
  for (const { id } of eligible) {
    try {
      results.push(await runIntelligenceAiForAccount(env, id, nowMs));
    } catch (err) {
      results.push({
        accountId: id,
        customersScored: 0,
        alertsFired: 0,
        narrativeGenerated: false,
        narrativeSkippedReason: err instanceof Error ? err.message : "run failed",
      });
      console.error(`intelligence AI run failed for account ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
