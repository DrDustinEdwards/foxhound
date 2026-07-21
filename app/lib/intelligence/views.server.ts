import { and, desc, eq } from "drizzle-orm";

import {
  accountSubscriptions,
  accounts,
  alertHistory,
  alerts,
  customerContext,
  healthScoreHistory,
  intelligenceReports,
  predictions,
  type Db,
} from "~/db";
import { healthScoreBand } from "./health-band";
import type { HealthFactor } from "./risk";

// Read models for the paid Intelligence surfaces (TASK-foxhound-intelligence-ai.md
// deliverable 6). Every query is account-scoped. No entitlement check for the
// Intelligence paid subscription exists elsewhere in the app yet; this is that
// check, built honestly against account_subscriptions (product='intelligence',
// status='active'). If a real billing-driven write path for this row is added
// later, this read-side gate does not need to change.

/** True when the account currently has an active Intelligence subscription
 *  (admin-granted rows count too: PRICING.md, admin_granted never touches
 *  Stripe but is still a real entitlement). */
export async function isIntelligenceEntitled(db: Db, accountId: string): Promise<boolean> {
  const rows = await db
    .select({ id: accountSubscriptions.id })
    .from(accountSubscriptions)
    .where(
      and(
        eq(accountSubscriptions.accountId, accountId),
        eq(accountSubscriptions.product, "intelligence"),
        eq(accountSubscriptions.status, "active"),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

const OVERVIEW_CUSTOMER_LIMIT = 25;

export interface OverviewCustomerRow {
  stripeCustomerId: string;
  customerName: string | null;
  healthScore: number;
  mrrContributionCents: number;
}

export interface IntelligenceOverview {
  currency: string;
  scoredCustomerCount: number;
  scoreDistribution: { healthy: number; watch: number; atRisk: number };
  mrrAtRiskCents: number;
  atRiskCustomerCount: number;
  /** Worst-scoring customers first, bounded (DESIGN.md: "every customer
   *  scored, sorted by MRR-at-risk"; a full unbounded list is a later
   *  pagination pass, mirroring the bounded-scan convention elsewhere). */
  topAtRisk: OverviewCustomerRow[];
  narrative: string | null;
  narrativeGeneratedAt: Date | null;
}

/** The /intelligence overview: score distribution, MRR-at-risk exposure, and
 *  this month's narrative. Caller must have already checked entitlement. */
export async function getIntelligenceOverview(db: Db, accountId: string): Promise<IntelligenceOverview> {
  const [account, customers, latestReport] = await Promise.all([
    db.select({ currency: accounts.currency }).from(accounts).where(eq(accounts.id, accountId)).limit(1),
    db
      .select({
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        healthScore: customerContext.healthScore,
        mrrContributionCents: customerContext.mrrContributionCents,
      })
      .from(customerContext)
      .where(eq(customerContext.accountId, accountId)),
    db
      .select({ narrative: intelligenceReports.narrative, generatedAt: intelligenceReports.generatedAt })
      .from(intelligenceReports)
      .where(eq(intelligenceReports.accountId, accountId))
      .orderBy(desc(intelligenceReports.reportMonth))
      .limit(1),
  ]);

  const scored = customers.filter(
    (c): c is OverviewCustomerRow & { healthScore: number } => c.healthScore !== null,
  );
  const distribution = { healthy: 0, watch: 0, atRisk: 0 };
  let mrrAtRiskCents = 0;
  let atRiskCustomerCount = 0;
  for (const c of scored) {
    const band = healthScoreBand(c.healthScore);
    if (band === "at_risk") {
      distribution.atRisk += 1;
      mrrAtRiskCents += c.mrrContributionCents ?? 0;
      atRiskCustomerCount += 1;
    } else if (band === "watch") {
      distribution.watch += 1;
    } else {
      distribution.healthy += 1;
    }
  }

  const topAtRisk = scored
    .filter((c) => healthScoreBand(c.healthScore) === "at_risk")
    .sort((a, b) => a.healthScore - b.healthScore)
    .slice(0, OVERVIEW_CUSTOMER_LIMIT)
    .map((c) => ({
      stripeCustomerId: c.stripeCustomerId,
      customerName: c.customerName,
      healthScore: c.healthScore,
      mrrContributionCents: c.mrrContributionCents ?? 0,
    }));

  return {
    currency: account[0]?.currency ?? "usd",
    scoredCustomerCount: scored.length,
    scoreDistribution: distribution,
    mrrAtRiskCents,
    atRiskCustomerCount,
    topAtRisk,
    narrative: latestReport[0]?.narrative ?? null,
    narrativeGeneratedAt: latestReport[0]?.generatedAt ?? null,
  };
}

const HEALTH_SCORE_HISTORY_LIMIT = 24;
const PREDICTION_HISTORY_LIMIT = 12;

export interface CustomerHealthDetail {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  healthFactors: HealthFactor[];
  healthScoreCalculatedAt: Date | null;
  aiAssessment: string | null;
  aiAssessmentGeneratedAt: Date | null;
  history: { recordedAt: Date; healthScore: number; scoreSource: string }[];
  predictions: { predictedAt: Date; score: number; horizonDays: number; realizedOutcome: string | null }[];
}

/** Per-customer health detail, account-scoped by construction (the id +
 *  account_id predicate is one query, never a lookup-by-id followed by a
 *  separate ownership check): TASK-foxhound-intelligence-ai.md flags this
 *  route specifically for the account-scoping audit. Returns null when the
 *  customer does not belong to this account (or does not exist), for a clean
 *  404 at the route. */
export async function getCustomerHealthDetail(
  db: Db,
  accountId: string,
  stripeCustomerId: string,
): Promise<CustomerHealthDetail | null> {
  const rows = await db
    .select({
      id: customerContext.id,
      stripeCustomerId: customerContext.stripeCustomerId,
      customerName: customerContext.customerName,
      customerEmail: customerContext.customerEmail,
      mrrContributionCents: customerContext.mrrContributionCents,
      currency: accounts.currency,
      healthScore: customerContext.healthScore,
      healthFactors: customerContext.healthFactors,
      healthScoreCalculatedAt: customerContext.healthScoreCalculatedAt,
      aiAssessment: customerContext.aiAssessment,
      aiAssessmentGeneratedAt: customerContext.aiAssessmentGeneratedAt,
    })
    .from(customerContext)
    .innerJoin(accounts, eq(accounts.id, customerContext.accountId))
    .where(and(eq(customerContext.accountId, accountId), eq(customerContext.stripeCustomerId, stripeCustomerId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const [history, predictionRows] = await Promise.all([
    db
      .select({
        recordedAt: healthScoreHistory.recordedAt,
        healthScore: healthScoreHistory.healthScore,
        scoreSource: healthScoreHistory.scoreSource,
      })
      .from(healthScoreHistory)
      .where(eq(healthScoreHistory.customerContextId, row.id))
      .orderBy(desc(healthScoreHistory.recordedAt))
      .limit(HEALTH_SCORE_HISTORY_LIMIT),
    db
      .select({
        predictedAt: predictions.predictedAt,
        score: predictions.score,
        horizonDays: predictions.horizonDays,
        realizedOutcome: predictions.realizedOutcome,
      })
      .from(predictions)
      .where(and(eq(predictions.accountId, accountId), eq(predictions.stripeCustomerId, stripeCustomerId)))
      .orderBy(desc(predictions.predictedAt))
      .limit(PREDICTION_HISTORY_LIMIT),
  ]);

  return {
    stripeCustomerId: row.stripeCustomerId,
    customerName: row.customerName,
    customerEmail: row.customerEmail,
    mrrContributionCents: row.mrrContributionCents ?? 0,
    currency: row.currency ?? "usd",
    healthScore: row.healthScore,
    healthFactors: (row.healthFactors as HealthFactor[] | null) ?? [],
    healthScoreCalculatedAt: row.healthScoreCalculatedAt,
    aiAssessment: row.aiAssessment,
    aiAssessmentGeneratedAt: row.aiAssessmentGeneratedAt,
    history,
    predictions: predictionRows,
  };
}

export interface AlertView {
  id: string;
  metric: string;
  thresholdValue: number;
  direction: string;
  channel: string;
  label: string | null;
  enabled: boolean;
  lastTriggeredAt: Date | null;
}

export interface AlertFiringView {
  id: string;
  metric: string;
  actualValue: number;
  thresholdValue: number;
  direction: string;
  firedAt: Date;
  notificationSent: boolean;
}

const ALERT_HISTORY_LIMIT = 50;

/** Configured alerts + recent fire history, account-scoped. */
export async function getAlertsView(
  db: Db,
  accountId: string,
): Promise<{ alerts: AlertView[]; history: AlertFiringView[] }> {
  const [alertRows, historyRows] = await Promise.all([
    db
      .select({
        id: alerts.id,
        metric: alerts.metric,
        thresholdValue: alerts.thresholdValue,
        direction: alerts.direction,
        channel: alerts.channel,
        label: alerts.label,
        enabled: alerts.enabled,
        lastTriggeredAt: alerts.lastTriggeredAt,
      })
      .from(alerts)
      .where(eq(alerts.accountId, accountId)),
    db
      .select({
        id: alertHistory.id,
        metric: alertHistory.metric,
        actualValue: alertHistory.actualValue,
        thresholdValue: alertHistory.thresholdValue,
        direction: alertHistory.direction,
        firedAt: alertHistory.firedAt,
        notificationSent: alertHistory.notificationSent,
      })
      .from(alertHistory)
      .where(eq(alertHistory.accountId, accountId))
      .orderBy(desc(alertHistory.firedAt))
      .limit(ALERT_HISTORY_LIMIT),
  ]);
  return { alerts: alertRows, history: historyRows };
}

export interface ReportArchiveRow {
  id: string;
  reportMonth: Date;
  narrative: string;
  generatedAt: Date;
}

const REPORTS_ARCHIVE_LIMIT = 24;

/** The narrative archive, most recent report month first. Account-scoped. */
export async function getReportsArchive(db: Db, accountId: string): Promise<ReportArchiveRow[]> {
  return db
    .select({
      id: intelligenceReports.id,
      reportMonth: intelligenceReports.reportMonth,
      narrative: intelligenceReports.narrative,
      generatedAt: intelligenceReports.generatedAt,
    })
    .from(intelligenceReports)
    .where(eq(intelligenceReports.accountId, accountId))
    .orderBy(desc(intelligenceReports.reportMonth))
    .limit(REPORTS_ARCHIVE_LIMIT);
}
