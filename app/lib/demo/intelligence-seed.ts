import type { alertHistory, alerts, customerContext, healthScoreHistory, mrrSnapshots } from "~/db";
import type { HealthFactor } from "~/lib/intelligence/risk";
import { buildMrrSnapshotFields, type CustomerMrrPoint } from "~/lib/intelligence/mrr";

import type { DisputeInsert } from "./disputes-seed";
import type { FailedPaymentInsert, RecoveredPaymentInsert } from "./recovery-seed";
import {
  monthlyMrrCents,
  planNameFor,
  seededInt,
  type DemoCustomer,
  type DemoEngagementOverride,
} from "./customer-base";
import { DAY_MS } from "~/lib/constants";

// Intelligence seed (TASK-foxhound-demo-data-engine.md Phase 3): customer_context
// + health_score_history + mrr_snapshots + the demo alert rules, built from the
// same customer roster, recovery rows, and dispute rows the other seed modules
// produced (never a second, independent narrative). mrr_snapshots reuses the
// REAL movement math (app/lib/intelligence/mrr.ts computeMrrMovements /
// buildMrrSnapshotFields) walked across 12 monthly points, driven by each
// customer's actual signup/churn date, so movements are derived, not invented.
// Pure: returns plain insert rows, no DB access.

const MONTH_COUNT = 12;

type CustomerContextInsert = typeof customerContext.$inferInsert;
type HealthScoreHistoryInsert = typeof healthScoreHistory.$inferInsert;
type MrrSnapshotInsert = typeof mrrSnapshots.$inferInsert;
type AlertInsert = typeof alerts.$inferInsert;
type AlertHistoryInsert = typeof alertHistory.$inferInsert;

export interface IntelligenceSeedResult {
  customerContext: CustomerContextInsert[];
  healthScoreHistory: HealthScoreHistoryInsert[];
  mrrSnapshots: MrrSnapshotInsert[];
  alerts: AlertInsert[];
  alertHistory: AlertHistoryInsert[];
}

interface TrajectoryPoint {
  daysAgo: number;
  healthScore: number;
  reason: string;
}

function deriveHealthFactors(trajectory: TrajectoryPoint[]): HealthFactor[] {
  if (trajectory.length === 0) return [];
  const first = trajectory[0];
  const last = trajectory[trajectory.length - 1];
  return [
    {
      signal: last.reason,
      deltaPoints: last.healthScore - first.healthScore,
      detail: `Health trended from ${first.healthScore} to ${last.healthScore} (${last.reason.replace(/_/g, " ")}).`,
    },
  ];
}

// ============================================================================
// Recovery + engagement signals (from the recovery seed's own output, so this
// never re-derives a competing view of the same rows)
// ============================================================================

interface RecoveryAggregate {
  failedPaymentCount: number;
  recoveredCount: number;
  recoveredAmountCents: number;
  lastFailedAt: Date | null;
  lastRecoveredAt: Date | null;
  activeRecoveryId: string | null;
  unrecoveredCount: number;
}

function aggregateRecovery(
  stripeCustomerId: string,
  failedPayments: FailedPaymentInsert[],
  recoveredPayments: RecoveredPaymentInsert[],
): RecoveryAggregate {
  const mine = failedPayments.filter((f) => f.stripeCustomerId === stripeCustomerId);
  const recoveredByFpId = new Map(recoveredPayments.map((r) => [r.failedPaymentId, r]));
  const recoveredMine = mine.filter((f) => recoveredByFpId.has(f.id as string));
  const recoveredAmountCents = recoveredMine.reduce(
    (s, f) => s + (recoveredByFpId.get(f.id as string)?.amountCents ?? 0),
    0,
  );
  const lastFailedAt = mine.map((f) => f.detectedAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastRecoveredAt =
    recoveredMine
      .map((f) => recoveredByFpId.get(f.id as string)!.recoveredAt)
      .sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const active = mine.find((f) => f.status === "active");
  return {
    failedPaymentCount: mine.length,
    recoveredCount: recoveredMine.length,
    recoveredAmountCents,
    lastFailedAt,
    lastRecoveredAt,
    activeRecoveryId: (active?.id as string) ?? null,
    unrecoveredCount: mine.filter((f) => f.status === "failed_unrecovered").length,
  };
}

function engagementSignalsFor(
  stripeCustomerId: string,
  override: DemoEngagementOverride | undefined,
  recovery: RecoveryAggregate,
  now: Date,
): Record<string, unknown> {
  if (override) {
    return {
      emailOpened30d: override.emailOpened30d ?? 0,
      emailClicked30d: override.emailClicked30d ?? 0,
      lastEmailOpenedAt:
        override.lastEmailOpenedAtDaysAgo == null ? null : new Date(now.getTime() - override.lastEmailOpenedAtDaysAgo * DAY_MS),
    };
  }
  const idxNum = parseInt(stripeCustomerId.replace(/[^0-9]/g, ""), 10) || 0;
  const opened30 = recovery.failedPaymentCount > 0 && idxNum % 10 < 3 ? 1 + (idxNum % 3) : 0;
  const clicked30 = opened30 > 0 && idxNum % 25 < 2 ? 1 : 0;
  return {
    emailOpened30d: opened30,
    emailClicked30d: clicked30,
    lastEmailOpenedAt:
      opened30 > 0 ? new Date(now.getTime() - (seededInt(`${stripeCustomerId}:eng`, 25) + 1) * DAY_MS) : null,
  };
}

// ============================================================================
// Health score + trajectory (scripted trajectory wins; anonymous customers get
// a heuristic trajectory driven by their own recovery outcome)
// ============================================================================

function heuristicTrajectory(recovery: RecoveryAggregate, seed: string): TrajectoryPoint[] {
  const baseline = 70 + seededInt(`${seed}:base`, 15);
  const hasUnrecovered = recovery.unrecoveredCount > 0;
  const hasActive = recovery.activeRecoveryId !== null;
  const hasRecovered = recovery.recoveredCount > 0;
  const dipped = Math.max(35, baseline - 25);
  const final = hasUnrecovered
    ? Math.max(40, baseline - 20)
    : hasActive
      ? Math.max(45, baseline - 15)
      : hasRecovered
        ? Math.max(60, baseline - 8)
        : baseline;
  return [
    { daysAgo: 180, healthScore: baseline, reason: "baseline" },
    { daysAgo: 120, healthScore: baseline, reason: "stable" },
    { daysAgo: 60, healthScore: baseline - 3, reason: "stable" },
    {
      daysAgo: 30,
      healthScore: recovery.failedPaymentCount > 0 ? dipped : baseline,
      reason: recovery.failedPaymentCount > 0 ? "failed_payment" : "stable",
    },
    {
      daysAgo: 15,
      healthScore: hasRecovered ? dipped + 10 : recovery.failedPaymentCount > 0 ? dipped - 3 : baseline,
      reason: hasRecovered ? "in_recovery" : recovery.failedPaymentCount > 0 ? "still_unrecovered" : "stable",
    },
    {
      daysAgo: 3,
      healthScore: final,
      reason: hasRecovered ? "recovery_succeeded" : hasActive ? "in_recovery" : hasUnrecovered ? "declining" : "stable",
    },
  ];
}

// ============================================================================
// Dispute-only customers (net-new: Foxhound's disputes belong to Teamflow
// customers not otherwise in the 200-customer base, except Harborline Group,
// which IS in the base and just gets its dispute_signals merged in)
// ============================================================================

const HARBORLINE_STRIPE_ID = "cus_teamflow_harborline_group";

interface DisputeAggregate {
  openDisputesCount: number;
  wonCount: number;
  lostCount: number;
  totalDisputedCents: number;
  lastDisputeAt: Date;
  lastOutcome: string | null;
  activeDisputeId: string | null;
}

function aggregateDispute(d: DisputeInsert): DisputeAggregate {
  const isOpen = d.outcome == null;
  return {
    openDisputesCount: isOpen ? 1 : 0,
    wonCount: d.outcome === "won" ? 1 : 0,
    lostCount: d.outcome === "lost" ? 1 : 0,
    totalDisputedCents: d.amountCents,
    lastDisputeAt: d.createdAt as Date,
    lastOutcome: d.outcome ?? null,
    activeDisputeId: isOpen ? (d.id as string) : null,
  };
}

function disputeTrajectory(agg: DisputeAggregate, now: Date, seed: string): TrajectoryPoint[] {
  const baseline = 70 + seededInt(`${seed}:b`, 12);
  const won = agg.wonCount > 0;
  const lost = agg.lostCount > 0;
  const final = won ? Math.max(60, baseline - 5) : lost ? Math.max(30, baseline - 35) : Math.max(45, baseline - 18);
  const disputeAgeDays = Math.round((now.getTime() - agg.lastDisputeAt.getTime()) / DAY_MS);
  return [
    { daysAgo: Math.max(150, disputeAgeDays + 40), healthScore: baseline, reason: "baseline" },
    { daysAgo: Math.max(90, disputeAgeDays + 30), healthScore: baseline + 2, reason: "stable" },
    { daysAgo: Math.max(60, disputeAgeDays + 20), healthScore: baseline, reason: "stable" },
    { daysAgo: Math.max(40, disputeAgeDays + 10), healthScore: Math.max(40, baseline - 20), reason: "dispute_opened" },
    {
      daysAgo: Math.max(20, disputeAgeDays),
      healthScore: won ? baseline - 8 : lost ? baseline - 30 : baseline - 18,
      reason: won ? "dispute_won" : lost ? "dispute_lost" : "dispute_in_progress",
    },
    { daysAgo: 3, healthScore: final, reason: "present" },
  ];
}

// ============================================================================
// mrr_snapshots: 12 monthly points, real movement math, driven by each
// customer's actual signup/churn date (no fabricated growth curve).
// ============================================================================

interface MrrRosterEntry {
  stripeCustomerId: string;
  planName: string;
  cohortKey: string;
  joinedAt: Date;
  churnedAt: Date | null;
  activeMonthlyMrrCents: number;
}

function cohortKeyFor(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function buildMrrRoster(customers: DemoCustomer[], disputeOnly: { id: string; planName: string; joinedAt: Date; mrrCents: number }[]): MrrRosterEntry[] {
  const fromBase: MrrRosterEntry[] = customers.map((c) => ({
    stripeCustomerId: c.stripeCustomerId,
    planName: planNameFor(c),
    cohortKey: cohortKeyFor(c.customerSince),
    joinedAt: c.customerSince,
    churnedAt: c.status === "churned" ? c.churnedAt : null,
    // Ignore the *current* churned/paused status for the historical-arc walk;
    // months before any churn date should still show the customer's normal
    // contribution (monthlyMrrCents zeroes churned customers unconditionally).
    activeMonthlyMrrCents: monthlyMrrCents({ ...c, status: "active" }),
  }));
  const fromDisputes: MrrRosterEntry[] = disputeOnly.map((d) => ({
    stripeCustomerId: d.id,
    planName: d.planName,
    cohortKey: cohortKeyFor(d.joinedAt),
    joinedAt: d.joinedAt,
    churnedAt: null,
    activeMonthlyMrrCents: d.mrrCents,
  }));
  return [...fromBase, ...fromDisputes];
}

function buildMonthlySnapshots(accountId: string, roster: MrrRosterEntry[], now: Date): MrrSnapshotInsert[] {
  const rows: MrrSnapshotInsert[] = [];
  let priorByCustomer: Map<string, number> | null = null;

  for (let m = MONTH_COUNT - 1; m >= 0; m--) {
    const snapshotDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, now.getUTCDate()));
    const current: CustomerMrrPoint[] = roster.map((r) => {
      const joined = r.joinedAt.getTime() <= snapshotDate.getTime();
      const churnedByNow = r.churnedAt !== null && r.churnedAt.getTime() <= snapshotDate.getTime();
      return {
        stripeCustomerId: r.stripeCustomerId,
        mrrCents: joined && !churnedByNow ? r.activeMonthlyMrrCents : 0,
        planName: r.planName,
        cohortKey: r.cohortKey,
        churnReason: churnedByNow ? "involuntary" : null,
      };
    });

    const fields = buildMrrSnapshotFields(priorByCustomer, current);
    rows.push({
      id: `dmrr_${m}`,
      accountId,
      snapshotDate,
      totalMrrCents: fields.totalMrrCents,
      newMrrCents: fields.newMrrCents,
      expansionMrrCents: fields.expansionMrrCents,
      contractionMrrCents: fields.contractionMrrCents,
      churnMrrCents: fields.churnMrrCents,
      reactivationMrrCents: fields.reactivationMrrCents,
      activeCustomersCount: fields.activeCustomersCount,
      newCustomersCount: fields.newCustomersCount,
      churnedCustomersCount: fields.churnedCustomersCount,
      perPlanBreakdown: fields.perPlanBreakdown,
      perCohortBreakdown: fields.perCohortBreakdown,
      perChannelBreakdown: fields.perChannelBreakdown,
      voluntaryChurnRateBps: fields.voluntaryChurnRateBps,
      involuntaryChurnRateBps: fields.involuntaryChurnRateBps,
      netRevenueRetentionBps: fields.netRevenueRetentionBps,
      grossRevenueRetentionBps: fields.grossRevenueRetentionBps,
      currency: "usd",
      createdAt: snapshotDate,
    });

    priorByCustomer = new Map(current.map((c) => [c.stripeCustomerId, c.mrrCents]));
  }

  return rows;
}

// ============================================================================
// Alerts (ported from legacy lib/demo-seeding/seed-alerts.ts: 3 rules + 1 fired
// history row, scoped to the single Teamflow demo account)
// ============================================================================

function buildAlerts(accountId: string, now: Date): { alerts: AlertInsert[]; history: AlertHistoryInsert[] } {
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);
  const alertRows: AlertInsert[] = [
    {
      id: "dalert_recovery_rate",
      accountId,
      metric: "recovery_rate_pct",
      thresholdValue: 25,
      direction: "below",
      channel: "email",
      label: "Low recovery rate warning",
      enabled: true,
      lastTriggeredAt: null,
      createdAt: now,
    },
    {
      id: "dalert_mrr_at_risk",
      accountId,
      metric: "mrr_at_risk_cents",
      thresholdValue: 200000,
      direction: "above",
      channel: "email",
      label: "High MRR at risk",
      enabled: true,
      lastTriggeredAt: threeDaysAgo,
      createdAt: now,
    },
    {
      id: "dalert_active_sequences",
      accountId,
      metric: "active_sequences",
      thresholdValue: 10,
      direction: "above",
      channel: "email",
      label: "Active sequence count",
      enabled: false,
      lastTriggeredAt: null,
      createdAt: now,
    },
  ];
  const historyRows: AlertHistoryInsert[] = [
    {
      id: "dalerthist_mrr_at_risk",
      alertId: "dalert_mrr_at_risk",
      accountId,
      metric: "mrr_at_risk_cents",
      thresholdValue: 200000,
      direction: "above",
      actualValue: 247300,
      channel: "email",
      firedAt: threeDaysAgo,
      notificationSent: true,
    },
  ];
  return { alerts: alertRows, history: historyRows };
}

// ============================================================================
// Main entry point
// ============================================================================

export interface IntelligenceSeedInputs {
  accountId: string;
  now: Date;
  customers: DemoCustomer[];
  failedPayments: FailedPaymentInsert[];
  recoveredPayments: RecoveredPaymentInsert[];
  disputes: DisputeInsert[];
}

export function buildIntelligenceSeed(inputs: IntelligenceSeedInputs): IntelligenceSeedResult {
  const { accountId, now, customers, failedPayments, recoveredPayments, disputes } = inputs;

  const customerContextRows: CustomerContextInsert[] = [];
  const healthHistoryRows: HealthScoreHistoryInsert[] = [];

  const harborlineDispute = disputes.find((d) => d.stripeCustomerId === HARBORLINE_STRIPE_ID) ?? null;

  for (const c of customers) {
    const recovery = aggregateRecovery(c.stripeCustomerId, failedPayments, recoveredPayments);
    const trajectory: TrajectoryPoint[] = c.scripted
      ? c.scripted.healthTrajectory.map((p) => ({ daysAgo: p.daysAgo, healthScore: p.healthScore, reason: p.reason }))
      : heuristicTrajectory(recovery, c.stripeCustomerId);
    const healthScore = trajectory[trajectory.length - 1]?.healthScore ?? 70;
    const healthFactors = deriveHealthFactors(trajectory);
    const engagementSignals = engagementSignalsFor(c.stripeCustomerId, c.scripted?.engagementOverride, recovery, now);
    const disputeSignals = c.stripeCustomerId === HARBORLINE_STRIPE_ID && harborlineDispute
      ? aggregateDispute(harborlineDispute)
      : {};
    const tenureMonths = Math.max(1, Math.round((now.getTime() - c.customerSince.getTime()) / (30 * DAY_MS)));
    const mrr = monthlyMrrCents(c);
    const ctxId = `dctx_${c.stripeCustomerId}`;

    customerContextRows.push({
      id: ctxId,
      accountId,
      stripeCustomerId: c.stripeCustomerId,
      customerEmail: c.customerEmail,
      customerName: c.customerName,
      customerSince: c.customerSince,
      lastSeenAt: recovery.activeRecoveryId
        ? new Date(now.getTime() - seededInt(`${c.stripeCustomerId}:ls`, 5) * DAY_MS)
        : recovery.recoveredCount > 0
          ? new Date(now.getTime() - (seededInt(`${c.stripeCustomerId}:ls`, 14) + 1) * DAY_MS)
          : new Date(now.getTime() - (seededInt(`${c.stripeCustomerId}:ls`, 30) + 5) * DAY_MS),
      mrrContributionCents: mrr,
      ltvCents: mrr * tenureMonths,
      currency: "usd",
      activeSubscriptionsCount: c.tier === "hobby" ? 0 : 1,
      currentPlanName: planNameFor(c),
      currentPlanTier: c.tier,
      recoverySignals: recovery,
      disputeSignals,
      engagementSignals,
      healthScore,
      healthScoreCalculatedAt: now,
      healthFactors,
      createdAt: c.customerSince,
      updatedAt: now,
    });

    for (const p of trajectory) {
      healthHistoryRows.push({
        id: `dhsh_${c.stripeCustomerId}_${p.daysAgo}`,
        accountId,
        customerContextId: ctxId,
        stripeCustomerId: c.stripeCustomerId,
        recordedAt: new Date(now.getTime() - p.daysAgo * DAY_MS),
        healthScore: p.healthScore,
        healthFactors: { reason: p.reason },
        scoreSource: "deterministic_v1",
      });
    }
  }

  // Net-new dispute-only customers (every seeded dispute except Harborline's,
  // which is already one of the 200 base customers above).
  const disputeOnlyRoster: { id: string; planName: string; joinedAt: Date; mrrCents: number }[] = [];
  for (const d of disputes) {
    if (d.stripeCustomerId === HARBORLINE_STRIPE_ID) continue;
    const seed = d.stripeCustomerId as string;
    const tier = d.amountCents >= 30000 ? "scale" : "growth";
    const mrrCents = tier === "scale" ? 29900 : 9900;
    const tenureMonths = 8 + seededInt(seed, 8);
    const joinedAt = new Date(now.getTime() - tenureMonths * 30 * DAY_MS);
    const ctxId = `dctx_${d.stripeCustomerId}`;
    const agg = aggregateDispute(d);
    const trajectory = disputeTrajectory(agg, now, seed);
    const healthScore = trajectory[trajectory.length - 1]?.healthScore ?? 70;

    customerContextRows.push({
      id: ctxId,
      accountId,
      stripeCustomerId: d.stripeCustomerId as string,
      customerEmail: d.customerEmail,
      customerName: d.customerName,
      customerSince: joinedAt,
      lastSeenAt: new Date(now.getTime() - (seededInt(`${seed}:ls`, 14) + 1) * DAY_MS),
      mrrContributionCents: mrrCents,
      ltvCents: mrrCents * tenureMonths,
      currency: "usd",
      activeSubscriptionsCount: 1,
      currentPlanName: tier === "scale" ? "Scale" : "Growth",
      currentPlanTier: tier,
      recoverySignals: {},
      disputeSignals: agg,
      engagementSignals: {
        emailOpened30d: 1 + seededInt(`${seed}:o`, 4),
        emailClicked30d: seededInt(`${seed}:c`, 2),
        lastEmailOpenedAt: new Date(now.getTime() - (seededInt(`${seed}:e`, 14) + 1) * DAY_MS),
      },
      healthScore,
      healthScoreCalculatedAt: now,
      healthFactors: deriveHealthFactors(trajectory),
      createdAt: joinedAt,
      updatedAt: now,
    });

    for (const p of trajectory) {
      healthHistoryRows.push({
        id: `dhsh_${d.stripeCustomerId}_${p.daysAgo}`,
        accountId,
        customerContextId: ctxId,
        stripeCustomerId: d.stripeCustomerId as string,
        recordedAt: new Date(now.getTime() - p.daysAgo * DAY_MS),
        healthScore: p.healthScore,
        healthFactors: { reason: p.reason },
        scoreSource: "deterministic_v1",
      });
    }

    disputeOnlyRoster.push({ id: d.stripeCustomerId as string, planName: tier === "scale" ? "Scale" : "Growth", joinedAt, mrrCents });
  }

  const roster = buildMrrRoster(customers, disputeOnlyRoster);
  const mrrSnapshotRows = buildMonthlySnapshots(accountId, roster, now);
  const { alerts: alertRows, history: alertHistoryRows } = buildAlerts(accountId, now);

  return {
    customerContext: customerContextRows,
    healthScoreHistory: healthHistoryRows,
    mrrSnapshots: mrrSnapshotRows,
    alerts: alertRows,
    alertHistory: alertHistoryRows,
  };
}
