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
import { startOfUtcMonthMs } from "~/lib/billing/preview.server";
import { PREDICTION_HORIZON_DAYS } from "~/lib/constants";
import { getMrrAnalytics } from "~/lib/dashboard/stats.server";

import {
  narrativeFactsFor,
  writeIntelligenceNarrative,
  type NarrativeCustomer,
  type NarrativeResult,
} from "./narrative";
import { buildPredictionFields, buildPredictionInsert, gradeDuePredictions } from "./predictions";
import type { CustomerRecommendation } from "./recommend";
import { recommendForAccount } from "./recommendations.server";
import { computeHealthScore, type HealthFactor } from "./risk";
import { healthScoreInput, loadScoreExtras, scoreColumns } from "./score-inputs.server";
import { accountProcessingEligible } from "./sync.server";
import { chunked } from "@dustinedwards/site-runtime/d1";
import { errorMessage } from "@dustinedwards/site-runtime/log";

// The Intelligence nightly orchestration: grading -> scoring -> predictions -> narrative, for one account, then every
// processing-eligible account. Consumes the deterministic signals customer_context/mrr_snapshots already carry
// (signals, mrr, sync.server); never recomputes them. Nothing here calls a model: the narrative is a template.

interface ScoredCustomer {
  customerContextId: string;
  stripeCustomerId: string;
  customerName: string | null;
  mrrContributionCents: number;
  score: number;
  factors: HealthFactor[];
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
      recommendation: recommendations.get(row.stripeCustomerId)!,
    };
  });
}

/** One customer's writes: score and recommended action, history append, and a churn prediction if they pay (only a
 *  payer can churn). None is a money write, and nothing on a money path reads recommended_action. */
function buildCustomerScoringWrites(
  db: Db,
  accountId: string,
  c: ScoredCustomer,
  now: Date,
): BatchItem<"sqlite">[] {
  const writes: BatchItem<"sqlite">[] = [
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
  ];
  if (c.mrrContributionCents > 0) {
    writes.push(
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
    );
  }
  return writes;
}

/** Customers whose scoring writes (up to three statements each) go into one D1 batch. */
const SCORING_CUSTOMERS_PER_BATCH = 25;

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
  error: string | null;
}

export async function runIntelligenceAiForAccount(
  env: Env,
  accountId: string,
  nowMs: number,
): Promise<AccountAiRunResult> {
  const db = getDb(env);
  const now = new Date(nowMs);

  await gradeDuePredictions(db, accountId, nowMs);

  const [account, scored] = await Promise.all([
    db
      .select({ currency: accounts.currency })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1),
    scoreAccountCustomers(db, accountId, nowMs),
  ]);
  const currency = account[0]?.currency ?? "usd";

  if (scored.length > 0) {
    // A customer's writes stay in one batch; the account's go in slices, not one call of thousands.
    for (const slice of chunked(scored, SCORING_CUSTOMERS_PER_BATCH)) {
      const batch = buildScoringBatch(db, accountId, slice, now);
      await db.batch([batch[0], ...batch.slice(1)]);
    }
  }

  // Alerts are not evaluated here; alert-run.server.ts runs them on the recovery tick.
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

/** The one writer of intelligence_reports: this month's report (upserted, so a regenerate replaces it) and each
 *  assessment on its own customer, in one batch. */
export async function writeNarrativeReport(
  db: Db,
  input: {
    accountId: string;
    now: Date;
    result: NarrativeResult;
    scored: readonly NarrativeCustomer[];
  },
): Promise<void> {
  const { accountId, now, result, scored } = input;
  const reportMonth = new Date(startOfUtcMonthMs(now.getTime()));
  const idByCustomer = new Map(scored.map((c) => [c.stripeCustomerId, c.customerContextId]));
  const narrativeBatch: BatchItem<"sqlite">[] = [
    db
      .insert(intelligenceReports)
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
      db
        .update(customerContext)
        .set({ aiAssessment: a.assessment, aiAssessmentGeneratedAt: now })
        .where(eq(customerContext.id, customerContextId)),
    );
  }
  await db.batch([narrativeBatch[0], ...narrativeBatch.slice(1)]);
}

/** The full nightly run: every processing-eligible account; one account's failure never aborts the rest. */
export async function runIntelligenceAiForAllAccounts(
  env: Env,
  nowMs: number,
): Promise<AccountAiRunResult[]> {
  const db = getDb(env);
  const eligible = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(accountProcessingEligible());

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
      console.error(`intelligence run failed for account ${id}:`, errorMessage(err));
    }
  }
  return results;
}
