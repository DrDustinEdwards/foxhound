import { and, asc, desc, eq, gte, like, lt, or, sql } from "drizzle-orm";

import {
  accountSubscriptions,
  accounts,
  alertHistory,
  alerts,
  customerContext,
  healthScoreHistory,
  intelligenceReports,
  mrrSnapshots,
  predictions,
  type Db,
} from "~/db";
import {
  HEALTH_SCORE_AT_RISK_THRESHOLD,
  INTELLIGENCE_PRODUCT,
  SUBSCRIPTION_STATUS_ACTIVE,
} from "~/lib/constants";
import { healthScoreBand, WATCH_CEILING, type HealthScoreBand } from "./health-band";
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
      .where(eq(alerts.accountId, accountId))
      // Newest first, as Recova's alerts page orders them (J33). Unordered,
      // SQLite returned insertion order, so a new alert sank to the bottom.
      .orderBy(desc(alerts.createdAt)),
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

// ============================================================================
// Customer directory (TASK-foxhound-intelligence-customer-directory.md):
// every scored customer, not just the at-risk few the Overview page's table
// links to. Every filter and the sort live in SQL - never a client-side
// filter over the full account, however small the demo happens to be today.
// ============================================================================

export type CustomerDirectorySort = "health_asc" | "mrr_desc";

export interface CustomerDirectoryFilters {
  search: string | null;
  tier: string | null;
  healthBand: HealthScoreBand | null;
  sort: CustomerDirectorySort;
  page: number;
}

export interface CustomerDirectoryRow {
  stripeCustomerId: string;
  customerName: string | null;
  customerEmail: string | null;
  currentPlanTier: string | null;
  mrrContributionCents: number;
  currency: string;
  healthScore: number | null;
  lastSeenAt: Date | null;
  recoverySignals: unknown;
  disputeSignals: unknown;
}

export interface CustomerDirectoryResult {
  customers: CustomerDirectoryRow[];
  totalCount: number;
  totalMrrCents: number;
  page: number;
  totalPages: number;
}

const CUSTOMER_DIRECTORY_PAGE_SIZE = 50;

function healthBandCondition(band: HealthScoreBand | null) {
  if (band === "healthy") return gte(customerContext.healthScore, WATCH_CEILING);
  if (band === "watch") {
    return and(
      gte(customerContext.healthScore, HEALTH_SCORE_AT_RISK_THRESHOLD),
      lt(customerContext.healthScore, WATCH_CEILING),
    );
  }
  if (band === "at_risk") return lt(customerContext.healthScore, HEALTH_SCORE_AT_RISK_THRESHOLD);
  return undefined;
}

/** Every customer_context row for the account, filtered/sorted/paginated
 *  entirely in SQL. Sort "health_asc" (the default, and the real product
 *  behavior, not a demo affordance) puts the lowest scores - and therefore
 *  the customers most worth a look - first, with null (not yet scored)
 *  always last regardless of direction. */
export async function listCustomerDirectory(
  db: Db,
  accountId: string,
  filters: CustomerDirectoryFilters,
): Promise<CustomerDirectoryResult> {
  const conditions = [eq(customerContext.accountId, accountId)];
  if (filters.search) {
    const term = `%${filters.search}%`;
    const searchCondition = or(like(customerContext.customerName, term), like(customerContext.customerEmail, term));
    if (searchCondition) conditions.push(searchCondition);
  }
  if (filters.tier) conditions.push(eq(customerContext.currentPlanTier, filters.tier));
  const bandCondition = healthBandCondition(filters.healthBand);
  if (bandCondition) conditions.push(bandCondition);
  const where = and(...conditions);

  const [{ n: totalCount }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(customerContext)
    .where(where);
  const [{ n: totalMrrCents }] = await db
    .select({ n: sql<number>`coalesce(sum(${customerContext.mrrContributionCents}), 0)` })
    .from(customerContext)
    .where(where);

  const totalPages = Math.max(1, Math.ceil(Number(totalCount) / CUSTOMER_DIRECTORY_PAGE_SIZE));
  const page = Math.min(Math.max(1, filters.page), totalPages);

  const nullsLast = sql`${customerContext.healthScore} IS NULL`;
  const orderBy =
    filters.sort === "mrr_desc"
      ? [desc(customerContext.mrrContributionCents)]
      : [nullsLast, asc(customerContext.healthScore)];

  const rows = await db
    .select({
      stripeCustomerId: customerContext.stripeCustomerId,
      customerName: customerContext.customerName,
      customerEmail: customerContext.customerEmail,
      currentPlanTier: customerContext.currentPlanTier,
      mrrContributionCents: customerContext.mrrContributionCents,
      currency: customerContext.currency,
      healthScore: customerContext.healthScore,
      lastSeenAt: customerContext.lastSeenAt,
      recoverySignals: customerContext.recoverySignals,
      disputeSignals: customerContext.disputeSignals,
    })
    .from(customerContext)
    .where(where)
    .orderBy(...orderBy)
    .limit(CUSTOMER_DIRECTORY_PAGE_SIZE)
    .offset((page - 1) * CUSTOMER_DIRECTORY_PAGE_SIZE);

  return {
    customers: rows.map((r) => ({
      ...r,
      mrrContributionCents: r.mrrContributionCents ?? 0,
      currency: r.currency ?? "usd",
    })),
    totalCount: Number(totalCount),
    totalMrrCents: Number(totalMrrCents),
    page,
    totalPages,
  };
}

/** The distinct plan tiers present on this account's customers, for the tier
 *  filter's options - never a hardcoded tier list, since current_plan_tier is
 *  a legacy-provenance free-text column (SCHEMA.md), not a fixed enum. */
export async function listCustomerTiers(db: Db, accountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ tier: customerContext.currentPlanTier })
    .from(customerContext)
    .where(eq(customerContext.accountId, accountId));
  return rows
    .map((r) => r.tier)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort();
}

// ============================================================================
// /intelligence/churn read model
// ============================================================================

/** How many high-risk customers the churn table lists. */
// ---- MRR snapshot series for the dashboard (S16, legacy's NRRChart) ----
// Ruling 399 entered NRRChart and MRRMovementChart on row S16 as legacy
// elements the 394 walk never saw, because legacy's demo twin does not render
// them. Both read the same mrr_snapshots rows legacy's dashboard selects at
// app/(app)/intelligence/dashboard/page.tsx.

/** Legacy's dashboard windows these charts at 90 days and samples every 7th
 *  row, because its snapshot job is daily. Foxhound's `intelligence-sync` is
 *  MONTHLY (app/lib/cron/registry.ts), so ninety days is three points and the
 *  weekly sampling has nothing to thin. Same window the churn chart already
 *  ships under 78/79, and the card copy says twelve months rather than
 *  repeating legacy's sentence about data we do not have. */
const MRR_CHART_MONTHS = 12;

export interface MrrSnapshotPoint {
  at: Date;
  /** Net revenue retention as a percentage. null where the snapshot recorded
   *  none: an account's first sync has no prior period to retain against, and
   *  legacy's `?? 0` would draw that as total churn. */
  nrrPct: number | null;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
}

/** The dashboard's MRR snapshot series. Caller must have already checked
 *  entitlement. */
export async function getMrrSnapshotSeries(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<MrrSnapshotPoint[]> {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - MRR_CHART_MONTHS);

  const rows = await db
    .select({
      snapshotDate: mrrSnapshots.snapshotDate,
      netRevenueRetentionBps: mrrSnapshots.netRevenueRetentionBps,
      newMrrCents: mrrSnapshots.newMrrCents,
      expansionMrrCents: mrrSnapshots.expansionMrrCents,
      reactivationMrrCents: mrrSnapshots.reactivationMrrCents,
      contractionMrrCents: mrrSnapshots.contractionMrrCents,
      churnMrrCents: mrrSnapshots.churnMrrCents,
    })
    .from(mrrSnapshots)
    .where(and(eq(mrrSnapshots.accountId, accountId), gte(mrrSnapshots.snapshotDate, cutoff)))
    .orderBy(asc(mrrSnapshots.snapshotDate));

  return rows.map((r) => ({
    at: r.snapshotDate,
    nrrPct: r.netRevenueRetentionBps === null ? null : r.netRevenueRetentionBps / 100,
    newMrrCents: r.newMrrCents,
    expansionMrrCents: r.expansionMrrCents,
    reactivationMrrCents: r.reactivationMrrCents,
    contractionMrrCents: r.contractionMrrCents,
    churnMrrCents: r.churnMrrCents,
  }));
}

// ---- Customer health distribution (S16, legacy's HealthDistributionChart) ----
// Ruling 399: legacy's REAL dashboard renders this chart, so Foxhound's
// score-distribution card is a PORT to align rather than an addition. Legacy:
// app/(app)/intelligence/dashboard/components/HealthDistributionChart.tsx, fed
// from app/(app)/intelligence/dashboard/page.tsx's health_score_history select
// over the last 90 days.

const HEALTH_DISTRIBUTION_DAYS = 90;
/** Legacy samples every 7th day so the x axis stays readable across the window. */
const HEALTH_DISTRIBUTION_SAMPLE_STRIDE = 7;

export interface HealthDistributionDay {
  /** UTC calendar day, YYYY-MM-DD. */
  date: string;
  atRisk: number;
  watch: number;
  healthy: number;
}

/**
 * Customer count per health band per UTC day, sampled, over the last 90 days.
 *
 * The window is legacy's 90 days and it is TRUE of Foxhound's own data here:
 * `intelligence-ai` is a DAILY cron (app/lib/cron/registry.ts), the same cadence
 * legacy's scorer runs at, so ninety days of history means ninety rows to bucket
 * rather than the monthly cadence that forced the churn chart's twelve-month
 * window under 78/79.
 *
 * The BANDS are Foxhound's, which is the 78/79 truth-over-treatment split the
 * S19 row already settled: legacy hardcodes 0-33 / 34-66 / 67-100 inside this
 * component, Foxhound scores against `healthScoreBand`, and rendering legacy's
 * cutoffs over Foxhound's scores would put a customer in a band the rest of the
 * app does not put them in.
 */
export async function getHealthDistribution(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<HealthDistributionDay[]> {
  const cutoff = new Date(nowMs);
  cutoff.setUTCDate(cutoff.getUTCDate() - HEALTH_DISTRIBUTION_DAYS);

  const rows = await db
    .select({
      recordedAt: healthScoreHistory.recordedAt,
      healthScore: healthScoreHistory.healthScore,
    })
    .from(healthScoreHistory)
    .where(
      and(eq(healthScoreHistory.accountId, accountId), gte(healthScoreHistory.recordedAt, cutoff)),
    )
    .orderBy(asc(healthScoreHistory.recordedAt));

  const byDay = new Map<string, HealthDistributionDay>();
  for (const row of rows) {
    const date = row.recordedAt.toISOString().split("T")[0];
    let day = byDay.get(date);
    if (!day) {
      day = { date, atRisk: 0, watch: 0, healthy: 0 };
      byDay.set(date, day);
    }
    const band = healthScoreBand(row.healthScore);
    if (band === "at_risk") day.atRisk += 1;
    else if (band === "watch") day.watch += 1;
    else day.healthy += 1;
  }

  const days = Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
  return days.filter(
    (_, i) => i % HEALTH_DISTRIBUTION_SAMPLE_STRIDE === 0 || i === days.length - 1,
  );
}

const CHURN_TOP_HIGH_RISK_LIMIT = 20;

// How far back the churn-rate chart looks. Legacy used 90 days and then kept
// every 7th row, because its snapshots were DAILY. Foxhound's MRR snapshot cron
// is monthly, so a 90-day window would plot three points and index-based
// downsampling would be meaningless. Twelve months of monthly snapshots is the
// same intent (the recent trend) at this cadence, and needs no downsampling.
const CHURN_CHART_MONTHS = 12;

export interface ChurnBand {
  band: HealthScoreBand;
  customerCount: number;
  mrrCents: number;
}

export interface ChurnHighRiskRow {
  stripeCustomerId: string;
  customerName: string | null;
  currentPlanName: string | null;
  healthScore: number;
  mrrContributionCents: number;
}

export interface ChurnRatePoint {
  at: Date;
  voluntaryPct: number | null;
  involuntaryPct: number | null;
}

export interface ChurnView {
  bands: ChurnBand[];
  /** The sum across the three bands. This is the percentage denominator, and it
   *  deliberately excludes unscored customers: the band numerators only count
   *  scored ones, so dividing by every customer's MRR made the three shares
   *  silently fail to sum to 100% with nothing on screen explaining why. */
  scoredMrrCents: number;
  scoredCustomerCount: number;
  topHighRisk: ChurnHighRiskRow[];
  ratePoints: ChurnRatePoint[];
}

/** Per-band customer counts and MRR, aggregated in SQL rather than by scanning
 *  every customer_context row into memory and reducing in JS. */
async function getChurnBands(db: Db, accountId: string): Promise<ChurnBand[]> {
  const bands: HealthScoreBand[] = ["at_risk", "watch", "healthy"];
  const rows = await Promise.all(
    bands.map(async (band) => {
      const [row] = await db
        .select({
          customerCount: sql<number>`count(*)`,
          mrrCents: sql<number>`coalesce(sum(${customerContext.mrrContributionCents}), 0)`,
        })
        .from(customerContext)
        .where(and(eq(customerContext.accountId, accountId), healthBandCondition(band)));
      return {
        band,
        customerCount: Number(row?.customerCount ?? 0),
        mrrCents: Number(row?.mrrCents ?? 0),
      };
    }),
  );
  return rows;
}

/**
 * The churn-risk surface: MRR split across the three health bands, the
 * highest-MRR at-risk customers, and the involuntary-vs-voluntary churn rate
 * over the last 90 days.
 *
 * Bands come from healthScoreBand (40/70), the same thresholds driving the
 * overview's MRR-at-risk and the customer directory's band filter. Legacy split
 * this page at 33/66 while its own text tones used 40/70, so the same customer
 * could read "at risk" in one place and "medium" here.
 */
export async function getChurnView(db: Db, accountId: string, nowMs: number): Promise<ChurnView> {
  const cutoff = new Date(nowMs);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - CHURN_CHART_MONTHS);
  const chartCutoff = cutoff;

  const [bands, topHighRisk, snapshots] = await Promise.all([
    getChurnBands(db, accountId),
    db
      .select({
        stripeCustomerId: customerContext.stripeCustomerId,
        customerName: customerContext.customerName,
        currentPlanName: customerContext.currentPlanName,
        healthScore: customerContext.healthScore,
        mrrContributionCents: customerContext.mrrContributionCents,
      })
      .from(customerContext)
      .where(
        and(
          eq(customerContext.accountId, accountId),
          lt(customerContext.healthScore, HEALTH_SCORE_AT_RISK_THRESHOLD),
        ),
      )
      .orderBy(desc(customerContext.mrrContributionCents))
      .limit(CHURN_TOP_HIGH_RISK_LIMIT),
    db
      .select({
        snapshotDate: mrrSnapshots.snapshotDate,
        voluntaryChurnRateBps: mrrSnapshots.voluntaryChurnRateBps,
        involuntaryChurnRateBps: mrrSnapshots.involuntaryChurnRateBps,
      })
      .from(mrrSnapshots)
      .where(and(eq(mrrSnapshots.accountId, accountId), gte(mrrSnapshots.snapshotDate, chartCutoff)))
      .orderBy(asc(mrrSnapshots.snapshotDate)),
  ]);

  return {
    bands,
    scoredMrrCents: bands.reduce((sum, b) => sum + b.mrrCents, 0),
    scoredCustomerCount: bands.reduce((sum, b) => sum + b.customerCount, 0),
    topHighRisk: topHighRisk.map((r) => ({
      stripeCustomerId: r.stripeCustomerId,
      customerName: r.customerName,
      currentPlanName: r.currentPlanName,
      // The band predicate guarantees a non-null score; the column is nullable
      // so the type needs the coalesce.
      healthScore: r.healthScore ?? 0,
      mrrContributionCents: r.mrrContributionCents ?? 0,
    })),
    // bps -> percent. A null rate is preserved as null, not coerced to 0: an
    // account's first sync has no prior state to diff against, and "no rate
    // yet" is not "0% churn".
    ratePoints: snapshots.map((s) => ({
      at: s.snapshotDate,
      voluntaryPct: s.voluntaryChurnRateBps === null ? null : s.voluntaryChurnRateBps / 100,
      involuntaryPct: s.involuntaryChurnRateBps === null ? null : s.involuntaryChurnRateBps / 100,
    })),
  };
}
