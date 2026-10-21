import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { id, ts, bool, json } from "./columns";
import { accounts } from "./tenancy";

// ============================================================================
// Intelligence
// ============================================================================

export const customerContext = sqliteTable(
  "customer_context",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    customerEmail: text("customer_email"),
    customerName: text("customer_name"),
    customerSince: ts("customer_since"),
    lastSeenAt: ts("last_seen_at"),
    mrrContributionCents: integer("mrr_contribution_cents"),
    ltvCents: integer("ltv_cents"),
    // currency for mrr_contribution_cents / ltv_cents
    currency: text("currency"),
    activeSubscriptionsCount: integer("active_subscriptions_count"),
    currentPlanName: text("current_plan_name"),
    currentPlanTier: text("current_plan_tier"),
    recoverySignals: json("recovery_signals"),
    disputeSignals: json("dispute_signals"),
    engagementSignals: json("engagement_signals"),
    healthScore: integer("health_score"),
    healthScoreCalculatedAt: ts("health_score_calculated_at"),
    healthFactors: json("health_factors"),
    aiAssessment: text("ai_assessment"),
    aiAssessmentGeneratedAt: ts("ai_assessment_generated_at"),
    aiRecommendedActions: json("ai_recommended_actions"),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
    // Structured billing-behavior signals (SCHEMA.md; names are Phase-2 judgment,
    // Phase 4 owns population). Nullable so every customer row can exist pre-scoring.
    subscriptionAgeDays: integer("subscription_age_days"),
    planChangeCount: integer("plan_change_count"),
    seatChangeCount: integer("seat_change_count"),
    intervalSwitchCount: integer("interval_switch_count"),
    paymentLatencyDriftDays: integer("payment_latency_drift_days"),
    refundCount: integer("refund_count"),
    disputeCount: integer("dispute_count"),
  },
  (t) => [
    index("customer_context_account_idx").on(t.accountId),
    uniqueIndex("customer_context_account_customer_uq").on(t.accountId, t.stripeCustomerId),
  ],
);

export const healthScoreHistory = sqliteTable(
  "health_score_history",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    customerContextId: text("customer_context_id").notNull().references(() => customerContext.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    recordedAt: ts("recorded_at").notNull(),
    healthScore: integer("health_score").notNull(),
    healthFactors: json("health_factors").notNull(),
    scoreSource: text("score_source").notNull(),
  },
  (t) => [
    index("health_score_history_account_idx").on(t.accountId),
    index("health_score_history_customer_idx").on(t.customerContextId),
  ],
);

export const predictions = sqliteTable(
  "predictions",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    stripeCustomerId: text("stripe_customer_id").notNull(),
    score: integer("score").notNull(),
    // hash of the evidence bands that produced the score
    bandEvidenceHash: text("band_evidence_hash"),
    horizonDays: integer("horizon_days").notNull(),
    predictedAt: ts("predicted_at").notNull(),
    // realized-outcome slot for backtesting (nullable until graded)
    realizedOutcome: text("realized_outcome"),
    gradedAt: ts("graded_at"),
  },
  (t) => [
    index("predictions_account_idx").on(t.accountId),
    index("predictions_customer_idx").on(t.stripeCustomerId),
  ],
);

export const mrrSnapshots = sqliteTable(
  "mrr_snapshots",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    snapshotDate: ts("snapshot_date").notNull(),
    totalMrrCents: integer("total_mrr_cents").notNull(),
    newMrrCents: integer("new_mrr_cents").notNull(),
    expansionMrrCents: integer("expansion_mrr_cents").notNull(),
    contractionMrrCents: integer("contraction_mrr_cents").notNull(),
    churnMrrCents: integer("churn_mrr_cents").notNull(),
    reactivationMrrCents: integer("reactivation_mrr_cents").notNull(),
    activeCustomersCount: integer("active_customers_count").notNull(),
    newCustomersCount: integer("new_customers_count").notNull(),
    churnedCustomersCount: integer("churned_customers_count").notNull(),
    perPlanBreakdown: json("per_plan_breakdown").notNull(),
    perCohortBreakdown: json("per_cohort_breakdown").notNull(),
    perChannelBreakdown: json("per_channel_breakdown").notNull(),
    voluntaryChurnRateBps: integer("voluntary_churn_rate_bps"),
    involuntaryChurnRateBps: integer("involuntary_churn_rate_bps"),
    netRevenueRetentionBps: integer("net_revenue_retention_bps"),
    grossRevenueRetentionBps: integer("gross_revenue_retention_bps"),
    currency: text("currency").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("mrr_snapshots_account_idx").on(t.accountId)],
);

export const intelligenceReports = sqliteTable(
  "intelligence_reports",
  {
    id: id(),
    accountId: text("account_id").references(() => accounts.id),
    reportMonth: ts("report_month").notNull(),
    narrative: text("narrative").notNull(),
    generatedAt: ts("generated_at").notNull(),
  },
  (t) => [
    index("intelligence_reports_account_idx").on(t.accountId),
    // PRICING.md's "nightly AI analyst narrative" refreshes the SAME monthly
    // report every night (upsert), it does not accumulate a new archival row
    // per night: one row per account per report_month, kept current.
    uniqueIndex("intelligence_reports_account_month_uq").on(t.accountId, t.reportMonth),
  ],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    metric: text("metric").notNull(),
    thresholdValue: real("threshold_value").notNull(),
    direction: text("direction").notNull(),
    channel: text("channel").notNull(),
    label: text("label"),
    enabled: bool("enabled").notNull().default(true),
    lastTriggeredAt: ts("last_triggered_at"),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [index("alerts_account_idx").on(t.accountId)],
);

export const alertHistory = sqliteTable(
  "alert_history",
  {
    id: id(),
    // NULL on the critical customers firing (E22), which has no alert row
    // behind it, as Recova writes it (lib/alert-evaluation.ts, blob 0e28ecbf).
    alertId: text("alert_id").references(() => alerts.id),
    accountId: text("account_id").notNull().references(() => accounts.id),
    metric: text("metric").notNull(),
    thresholdValue: real("threshold_value").notNull(),
    direction: text("direction").notNull(),
    actualValue: real("actual_value").notNull(),
    channel: text("channel").notNull(),
    firedAt: ts("fired_at").notNull(),
    notificationSent: bool("notification_sent").notNull().default(false),
  },
  (t) => [
    index("alert_history_account_idx").on(t.accountId),
    index("alert_history_alert_idx").on(t.alertId),
  ],
);

export const intelligenceNotificationPreferences = sqliteTable(
  "intelligence_notification_preferences",
  {
    id: id(),
    accountId: text("account_id").notNull().references(() => accounts.id),
    // soft ref to Better Auth user.id (Phase 3)
    userId: text("user_id").notNull(),
    weeklyNarrativeEmail: bool("weekly_narrative_email").notNull().default(true),
    weeklyNarrativeSlack: bool("weekly_narrative_slack").notNull().default(false),
    healthAlertEmail: bool("health_alert_email").notNull().default(true),
    healthAlertSlack: bool("health_alert_slack").notNull().default(false),
    healthAlertThreshold: integer("health_alert_threshold").notNull().default(50),
    expansionAlertEmail: bool("expansion_alert_email").notNull().default(true),
    expansionAlertSlack: bool("expansion_alert_slack").notNull().default(false),
    competitorAlertEmail: bool("competitor_alert_email").notNull().default(false),
    competitorAlertSlack: bool("competitor_alert_slack").notNull().default(false),
    anomalyAlertEmail: bool("anomaly_alert_email").notNull().default(true),
    anomalyAlertSlack: bool("anomaly_alert_slack").notNull().default(false),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [index("intelligence_notif_prefs_account_idx").on(t.accountId)],
);

// global (not tenant-scoped): seeds the no-auth estimator
export const benchmarkData = sqliteTable("benchmark_data", {
  id: id(),
  computedAt: ts("computed_at").notNull(),
  cohortDimension: text("cohort_dimension").notNull(),
  cohortValue: text("cohort_value").notNull(),
  sampleSize: integer("sample_size").notNull(),
  metricName: text("metric_name").notNull(),
  p10: real("p10"),
  p25: real("p25"),
  p50: real("p50"),
  p75: real("p75"),
  p90: real("p90"),
  mean: real("mean"),
  currency: text("currency"),
});
