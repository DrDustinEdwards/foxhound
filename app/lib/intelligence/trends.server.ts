// Intelligence trend views (views.server.ts split): the MRR snapshot series,
// the health-score distribution over time and the churn view.

import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { customerContext, healthScoreHistory, mrrSnapshots, type Db } from "~/db";
import { HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { healthScoreBand, type HealthScoreBand } from "./health-band";
import { healthBandCondition } from "./directory.server";

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
  /** The snapshot's MRR and active customers (Recova's MRRStatCards and
   *  MRRTrendChart read the same two columns). */
  totalMrrCents: number;
  activeCustomersCount: number;
  /** Net revenue retention as a percentage. null where the snapshot recorded
   *  none: an account's first sync has no prior period to retain against, and
   *  legacy's `?? 0` would draw that as total churn. */
  nrrPct: number | null;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  /** Plan name to MRR cents, as buildPlanBreakdown wrote it (Recova's
   *  PlanBreakdown reads the latest snapshot's). */
  perPlanBreakdown: unknown;
  currency: string;
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
      totalMrrCents: mrrSnapshots.totalMrrCents,
      activeCustomersCount: mrrSnapshots.activeCustomersCount,
      perPlanBreakdown: mrrSnapshots.perPlanBreakdown,
      currency: mrrSnapshots.currency,
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
    totalMrrCents: r.totalMrrCents,
    activeCustomersCount: r.activeCustomersCount,
    nrrPct: r.netRevenueRetentionBps === null ? null : r.netRevenueRetentionBps / 100,
    newMrrCents: r.newMrrCents,
    expansionMrrCents: r.expansionMrrCents,
    reactivationMrrCents: r.reactivationMrrCents,
    contractionMrrCents: r.contractionMrrCents,
    churnMrrCents: r.churnMrrCents,
    perPlanBreakdown: r.perPlanBreakdown,
    currency: r.currency,
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

interface ChurnBand {
  band: HealthScoreBand;
  customerCount: number;
  mrrCents: number;
}

interface ChurnHighRiskRow {
  stripeCustomerId: string;
  customerName: string | null;
  currentPlanName: string | null;
  healthScore: number;
  mrrContributionCents: number;
}

interface ChurnRatePoint {
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
