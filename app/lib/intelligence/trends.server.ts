// Intelligence trend views: the MRR snapshot series, the health-score distribution over time and the churn view.

import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { customerContext, healthScoreHistory, mrrSnapshots, type Db } from "~/db";
import { DAY_MS, HEALTH_SCORE_AT_RISK_THRESHOLD } from "~/lib/constants";
import { sampleEveryNth } from "./dashboard";
import { healthScoreBand, type HealthScoreBand } from "./health-band";
import { healthBandCondition } from "./directory.server";

/** The last 90 days of DAILY snapshots (`intelligence-sync` runs daily). The series is every row; the NRR card
 *  samples it and the movement card sums it by week (dashboard.ts). */
const MRR_CHART_DAYS = 90;
export interface MrrSnapshotPoint {
  at: Date;
  totalMrrCents: number;
  activeCustomersCount: number;
  /** Net revenue retention as a percentage. null where no prior period exists (first sync), so it is not drawn as total churn. */
  nrrPct: number | null;
  newMrrCents: number;
  expansionMrrCents: number;
  reactivationMrrCents: number;
  contractionMrrCents: number;
  churnMrrCents: number;
  /** Plan name to MRR cents, as buildPlanBreakdown wrote it. */
  perPlanBreakdown: unknown;
  currency: string;
}

/** The dashboard's MRR snapshot series. */
export async function getMrrSnapshotSeries(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<MrrSnapshotPoint[]> {
  const cutoff = new Date(nowMs - MRR_CHART_DAYS * DAY_MS);

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

const HEALTH_DISTRIBUTION_DAYS = 90;
/** Every 7th day keeps the x axis readable across the window. */
const HEALTH_DISTRIBUTION_SAMPLE_STRIDE = 7;

export interface HealthDistributionDay {
  date: string;
  atRisk: number;
  watch: number;
  healthy: number;
}

/** Customer count per health band per UTC day, sampled, over the last 90 days. The bands are Foxhound's
 *  `healthScoreBand`, so a customer is never in a band the rest of the app does not put them in. */
export async function getHealthDistribution(
  db: Db,
  accountId: string,
  nowMs: number,
): Promise<HealthDistributionDay[]> {
  const cutoff = new Date(nowMs - HEALTH_DISTRIBUTION_DAYS * DAY_MS);

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
  return sampleEveryNth(days, HEALTH_DISTRIBUTION_SAMPLE_STRIDE);
}

const CHURN_TOP_HIGH_RISK_LIMIT = 20;

const CHURN_CHART_DAYS = 90;

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
  /** The sum across the three bands: the percentage denominator, excluding unscored customers so the shares sum to 100%. */
  scoredMrrCents: number;
  scoredCustomerCount: number;
  topHighRisk: ChurnHighRiskRow[];
  ratePoints: ChurnRatePoint[];
}

/** Per-band customer counts and MRR, aggregated in SQL rather than in JS. */
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

/** The churn-risk surface: MRR split across the three health bands, the highest-MRR at-risk customers, and the
 *  involuntary-vs-voluntary churn rate over 90 days. Bands come from healthScoreBand (40/70), the same
 *  thresholds as the overview's MRR-at-risk and the directory's band filter. */
export async function getChurnView(db: Db, accountId: string, nowMs: number): Promise<ChurnView> {
  const chartCutoff = new Date(nowMs - CHURN_CHART_DAYS * DAY_MS);

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
      .where(
        and(eq(mrrSnapshots.accountId, accountId), gte(mrrSnapshots.snapshotDate, chartCutoff)),
      )
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
      // The band predicate guarantees a non-null score; the column is nullable, so coalesce.
      healthScore: r.healthScore ?? 0,
      mrrContributionCents: r.mrrContributionCents ?? 0,
    })),
    // bps -> percent. A null rate stays null: "no rate yet" is not "0% churn".
    ratePoints: sampleEveryNth(snapshots).map((s) => ({
      at: s.snapshotDate,
      voluntaryPct: s.voluntaryChurnRateBps === null ? null : s.voluntaryChurnRateBps / 100,
      involuntaryPct: s.involuntaryChurnRateBps === null ? null : s.involuntaryChurnRateBps / 100,
    })),
  };
}
