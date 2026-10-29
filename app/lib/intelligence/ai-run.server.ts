import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  accounts,
  customerContext,
  getDb,
  healthScoreHistory,
  intelligenceReports,
  type Db,
} from "~/db";
import {
  PREDICTION_HORIZON_DAYS,
} from "~/lib/constants";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";

import {
  narrativeFactsFor,
  writeIntelligenceNarrative,
  type NarrativeCustomer,
  type NarrativeResult,
} from "./narrative";
import { buildPredictionFields, buildPredictionInsert } from "./predictions";
import type { CustomerRecommendation } from "./recommend";
import { buildRecommendationLogInsert, recommendForAccount } from "./recommendations.server";
import { computeHealthScore, type HealthFactor } from "./risk";
import { healthScoreInput, loadScoreExtras, scoreColumns } from "./score-inputs.server";
import { accountProcessingEligible } from "./sync.server";

// The Intelligence nightly orchestration: scoring -> predictions -> narrative,
// for one account, then for every processing-eligible account
// (TASK-foxhound-intelligence-ai.md deliverable 5; the file keeps its name).
// Consumes the deterministic signals customer_context/mrr_snapshots already
// carry (app/lib/intelligence/{signals,mrr,sync.server}.ts); never recomputes
// them. Nothing here calls a model: the narrative is a template
// (narrative.ts), because Intelligence is free.

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
  const [rows, extras] = await Promise.all([
    db
      .select({
        id: customerContext.id,
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        mrrContributionCents: customerContext.mrrContributionCents,
        ...scoreColumns,
      })
      .from(customerContext)
      .where(eq(customerContext.accountId, accountId)),
    loadScoreExtras(db, accountId, nowMs),
  ]);

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
    const { score, factors } = computeHealthScore(
      healthScoreInput(row, extras.get(row.stripeCustomerId), nowMs),
    );
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
  /** Why the account's run failed, or null. */
  error: string | null;
}

export async function runIntelligenceAiForAccount(
  env: Env,
  accountId: string,
  nowMs: number,
): Promise<AccountAiRunResult> {
  const db = getDb(env);
  const now = new Date(nowMs);

  const [account, scored] = await Promise.all([
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    scoreAccountCustomers(db, accountId, nowMs),
  ]);
  const currency = account[0]?.currency ?? "usd";

  if (scored.length > 0) {
    const batch = buildScoringBatch(db, accountId, scored, now, currency);
    await db.batch([batch[0], ...batch.slice(1)]);
  }

  // Alerts are not evaluated here: Recova checks them after each recovery
  // run, and so does Foxhound (alert-run.server.ts, on the recovery tick).
  const mrr = await getMrrAnalytics(db, accountId, nowMs);

  const result = writeIntelligenceNarrative(
    narrativeFactsFor({ currency, mrrLatest: mrr.latest, scored }),
  );
  await writeNarrativeReport(db, { accountId, now, result, scored });

  return {
    accountId,
    customersScored: scored.length,
    error: null,
  };
}

/** The one writer of intelligence_reports: this month's report (upserted, so
 *  a regenerate replaces it) and each assessment on its own customer, in one
 *  batch. */
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
  await db.batch([narrativeBatch[0], ...narrativeBatch.slice(1)]);
}

/** The full nightly run: every processing-eligible account. Mirrors
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
        error: err instanceof Error ? err.message : "run failed",
      });
      console.error(`intelligence run failed for account ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return results;
}
