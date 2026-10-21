import { and, desc, eq, isNull } from "drizzle-orm";
import {
  accountSubscriptions,
  accounts,
  alertHistory,
  alerts,
  customerContext,
  disputes,
  engagementEvents,
  failedPayments,
  healthScoreHistory,
  intelligenceReports,
  predictions,
  recoveredPayments,
  recoverySteps,
  type Db,
} from "~/db";
import { groupSumByCurrency } from "~/lib/billing/preview.server";
import {
  DAY_MS,
  FAILED_PAYMENT_STATUS_ACTIVE,
  INTELLIGENCE_PRODUCT,
  SUBSCRIPTION_STATUS_ACTIVE,
} from "~/lib/constants";
import type { CustomerActivity } from "./customer-detail";
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
        eq(accountSubscriptions.product, INTELLIGENCE_PRODUCT),
        eq(accountSubscriptions.status, SUBSCRIPTION_STATUS_ACTIVE),
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

/** Recova's customer page reads the last 30 readings
 *  (fetchHealthScoreHistory(accountId, ctx.id, 30), page.tsx at blob 8d31766d). */
const HEALTH_SCORE_HISTORY_LIMIT = 30;
const PREDICTION_HISTORY_LIMIT = 12;

export interface CustomerHealthDetail {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  customerSince: Date | null;
  currentPlanName: string | null;
  currentPlanTier: string | null;
  /** Null when the row has none, kept apart from an honest zero (a customer
   *  with no active subscription), as Recova keeps them apart. */
  mrrContributionCents: number | null;
  /** Null until something computes lifetime value; nothing does yet
   *  (signals.ts buildCustomerContextFields). */
  ltvCents: number | null;
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
      customerSince: customerContext.customerSince,
      currentPlanName: customerContext.currentPlanName,
      currentPlanTier: customerContext.currentPlanTier,
      mrrContributionCents: customerContext.mrrContributionCents,
      ltvCents: customerContext.ltvCents,
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
    customerSince: row.customerSince,
    currentPlanName: row.currentPlanName,
    currentPlanTier: row.currentPlanTier,
    mrrContributionCents: row.mrrContributionCents,
    ltvCents: row.ltvCents,
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

const ENGAGEMENT_WINDOW_DAYS = 30;

const latest = (dates: readonly (Date | null)[]): Date | null =>
  dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);

const byCurrency = (rows: readonly { currency: string; cents: number }[]) =>
  groupSumByCurrency([...rows]).sort((a, b) => a.currency.localeCompare(b.currency));

/**
 * What Foxhound has on record for one customer of one account: the customer
 * detail page's three signal cards (row S18, job J68). Read from Foxhound's own
 * tables rather than customer_context's signal JSON, because the nightly sync
 * writes only counts there (signals.ts), with no amounts, dates or 30-day
 * window, and the demo seeds a different shape. Every query carries both the
 * account and the Stripe customer id, so another account's rows under the same
 * Stripe id are never read.
 *
 * Failed payments and recoveries skip soft-deleted rows, as the payments list
 * does. Engagement follows the nightly sync's join (an event on a recovery step
 * of one of the customer's payments).
 *
 * lastActivityAt is the page's "Last seen": the latest dated row above. It is
 * not customer_context.last_seen_at, which the nightly sync sets to its own run
 * time for every customer (sync.server.ts buildCustomerContextUpsert), so on a
 * live account it says when Foxhound last synced, not when the customer was
 * last seen (J68 review, must-fix 1).
 */
export async function getCustomerActivity(
  db: Db,
  accountId: string,
  stripeCustomerId: string,
  nowMs: number,
): Promise<CustomerActivity> {
  const [failedRows, recoveredRows, disputeRows, engagementRows] = await Promise.all([
    db
      .select({ status: failedPayments.status, detectedAt: failedPayments.detectedAt })
      .from(failedPayments)
      .where(
        and(
          eq(failedPayments.accountId, accountId),
          eq(failedPayments.stripeCustomerId, stripeCustomerId),
          isNull(failedPayments.deletedAt),
        ),
      ),
    db
      .select({
        cents: recoveredPayments.amountCents,
        currency: recoveredPayments.currency,
        recoveredAt: recoveredPayments.recoveredAt,
      })
      .from(recoveredPayments)
      .innerJoin(failedPayments, eq(failedPayments.id, recoveredPayments.failedPaymentId))
      .where(
        and(
          eq(recoveredPayments.accountId, accountId),
          eq(failedPayments.accountId, accountId),
          eq(failedPayments.stripeCustomerId, stripeCustomerId),
          isNull(failedPayments.deletedAt),
          isNull(recoveredPayments.deletedAt),
        ),
      ),
    db
      .select({
        state: disputes.state,
        cents: disputes.amountCents,
        currency: disputes.currency,
        createdAt: disputes.createdAt,
        resolvedAt: disputes.resolvedAt,
      })
      .from(disputes)
      .where(and(eq(disputes.accountId, accountId), eq(disputes.stripeCustomerId, stripeCustomerId))),
    db
      .select({ eventType: engagementEvents.eventType, occurredAt: engagementEvents.occurredAt })
      .from(engagementEvents)
      .innerJoin(recoverySteps, eq(recoverySteps.id, engagementEvents.recoveryStepId))
      .innerJoin(failedPayments, eq(failedPayments.id, recoverySteps.failedPaymentId))
      .where(
        and(
          eq(engagementEvents.accountId, accountId),
          eq(failedPayments.accountId, accountId),
          eq(failedPayments.stripeCustomerId, stripeCustomerId),
        ),
      ),
  ]);

  const resolved = disputeRows
    .filter((d) => d.state === "resolved_won" || d.state === "resolved_lost")
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).getTime() - (a.resolvedAt ?? a.createdAt).getTime());
  const lastOutcome = resolved[0]?.state ?? null;

  const windowStart = nowMs - ENGAGEMENT_WINDOW_DAYS * DAY_MS;
  const recent = engagementRows.filter((e) => e.occurredAt.getTime() >= windowStart);
  const opens = engagementRows.filter((e) => e.eventType === "open");

  return {
    recovery: {
      failedPaymentCount: failedRows.length,
      recoveredCount: recoveredRows.length,
      recoveredAmounts: byCurrency(recoveredRows),
      lastFailedAt: latest(failedRows.map((f) => f.detectedAt)),
      lastRecoveredAt: latest(recoveredRows.map((r) => r.recoveredAt)),
      activeRecovery: failedRows.some((f) => f.status === FAILED_PAYMENT_STATUS_ACTIVE),
    },
    disputes: {
      count: disputeRows.length,
      openCount: disputeRows.length - resolved.length,
      wonCount: resolved.filter((d) => d.state === "resolved_won").length,
      lostCount: resolved.filter((d) => d.state === "resolved_lost").length,
      totalDisputed: byCurrency(disputeRows),
      lastDisputeAt: latest(disputeRows.map((d) => d.createdAt)),
      lastOutcome: lastOutcome as CustomerActivity["disputes"]["lastOutcome"],
    },
    engagement: {
      everEngaged: engagementRows.length > 0,
      opens30d: recent.filter((e) => e.eventType === "open").length,
      clicks30d: recent.filter((e) => e.eventType === "click").length,
      lastOpenAt: latest(opens.map((e) => e.occurredAt)),
    },
    lastActivityAt: latest([
      ...failedRows.map((f) => f.detectedAt),
      ...recoveredRows.map((r) => r.recoveredAt),
      ...disputeRows.map((d) => d.createdAt),
      ...engagementRows.map((e) => e.occurredAt),
    ]),
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
      .where(eq(alerts.accountId, accountId))
      // Newest first, as Recova's alerts page orders them (J33). Unordered,
      // SQLite returned insertion order, so a new alert sank to the bottom.
      // The id breaks a tie on the same millisecond (seeds, batch inserts).
      .orderBy(desc(alerts.createdAt), desc(alerts.id)),
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

