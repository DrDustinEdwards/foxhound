import { and, desc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  accounts,
  alertHistory,
  alerts,
  customerContext,
  getDb,
  healthScoreHistory,
  intelligenceReports,
  type Db,
} from "~/db";
import { buildAiCallRow } from "~/lib/ai/cost";
import {
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_NARRATIVE_TOP_N,
  MODEL_INTELLIGENCE_NARRATIVE,
  PREDICTION_HORIZON_DAYS,
} from "~/lib/constants";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";

import {
  buildAlertHistoryInsert,
  buildAlertLastTriggeredUpdate,
  evaluateAlerts,
  type AlertConfig,
} from "./alerts";
import { generateIntelligenceNarrative, type AtRiskCustomerFact } from "./narrative";
import { buildPredictionFields, buildPredictionInsert } from "./predictions";
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
    };
  });
}

/** One customer's triple of writes: score update, history append, prediction log. */
function buildCustomerScoringWrites(
  db: Db,
  accountId: string,
  c: ScoredCustomer,
  now: Date,
): BatchItem<"sqlite">[] {
  return [
    db
      .update(customerContext)
      .set({ healthScore: c.score, healthFactors: c.factors, healthScoreCalculatedAt: now })
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
  ];
}

function buildScoringBatch(
  db: Db,
  accountId: string,
  scored: ScoredCustomer[],
  now: Date,
): BatchItem<"sqlite">[] {
  return scored.flatMap((c) => buildCustomerScoringWrites(db, accountId, c, now));
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
    const batch = buildScoringBatch(db, accountId, scored, now);
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

  const alertsFired = await evaluateAndRecordAlerts(db, accountId, metrics, now);

  const topAtRiskCustomers: AtRiskCustomerFact[] = atRisk.slice(0, INTELLIGENCE_NARRATIVE_TOP_N).map((c) => ({
    stripeCustomerId: c.stripeCustomerId,
    customerName: c.customerName,
    healthScore: c.score,
    mrrContributionCents: c.mrrContributionCents,
    currency,
    factorDetails: c.factors.map((f) => f.detail),
  }));

  let narrativeGenerated = false;
  let narrativeSkippedReason: string | null = null;
  try {
    const result = await generateIntelligenceNarrative(env, {
      accountName,
      currency,
      totalMrrCents: mrr.latest?.totalMrrCents ?? 0,
      newMrrCents: mrr.latest?.newMrrCents ?? 0,
      expansionMrrCents: mrr.latest?.expansionMrrCents ?? 0,
      contractionMrrCents: mrr.latest?.contractionMrrCents ?? 0,
      churnMrrCents: mrr.latest?.churnMrrCents ?? 0,
      reactivationMrrCents: mrr.latest?.reactivationMrrCents ?? 0,
      mrrAtRiskCents,
      atRiskCustomerCount: atRisk.length,
      topAtRiskCustomers,
    });

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
          source: "intelligence_narrative",
          model: MODEL_INTELLIGENCE_NARRATIVE,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          relatedId: null,
          createdAt: now,
        }),
      );
    }
    await db.batch([narrativeBatch[0], ...narrativeBatch.slice(1)]);
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

async function evaluateAndRecordAlerts(
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
    })
    .from(alerts)
    .where(and(eq(alerts.accountId, accountId), eq(alerts.enabled, true)));
  if (configs.length === 0) return 0;

  const history = await db
    .select({ alertId: alertHistory.alertId, actualValue: alertHistory.actualValue })
    .from(alertHistory)
    .where(inArray(alertHistory.alertId, configs.map((c) => c.id)))
    .orderBy(desc(alertHistory.firedAt));
  const previousActuals = new Map<string, number | null>();
  for (const row of history) {
    if (!previousActuals.has(row.alertId)) previousActuals.set(row.alertId, row.actualValue);
  }

  const firings = evaluateAlerts(configs, metrics, previousActuals);
  if (firings.length === 0) return 0;

  const batch: BatchItem<"sqlite">[] = firings.flatMap((f) => [
    buildAlertHistoryInsert(db, f, now),
    buildAlertLastTriggeredUpdate(db, f.alertId, now),
  ]);
  await db.batch([batch[0], ...batch.slice(1)]);
  return firings.length;
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
