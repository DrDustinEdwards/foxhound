import type { alertHistory, alerts, customerContext, healthScoreHistory, mrrSnapshots } from "~/db";
import type { HealthFactor } from "~/lib/intelligence/risk";
import type { DisputeInsert } from "./disputes-seed";
import type { FailedPaymentInsert, RecoveredPaymentInsert } from "./recovery-seed";
import { monthlyMrrCents, planNameFor, seededInt, type DemoCustomer } from "./customer-base";
import { DAY_MS } from "~/lib/constants";
import {
  aggregateRecovery,
  engagementSignalsFor,
  heuristicTrajectory,
} from "./intelligence-signals";
import {
  type DisputeOnlyPlan,
  aggregateDispute,
  disputeTrajectory,
  teamflowDisputeOnlyPlan,
} from "./intelligence-disputes";
import { buildMrrRoster, buildSnapshots } from "./intelligence-mrr";
import { buildAlerts } from "./intelligence-alerts";

// Intelligence seed: customer_context, health history, mrr_snapshots and demo alert rules, derived from the other seed modules' rows with the real movement math (computeMrrMovements / buildMrrSnapshotFields), never a second narrative. Pure.

type CustomerContextInsert = typeof customerContext.$inferInsert;
type HealthScoreHistoryInsert = typeof healthScoreHistory.$inferInsert;
export type MrrSnapshotInsert = typeof mrrSnapshots.$inferInsert;
export type AlertInsert = typeof alerts.$inferInsert;
export type AlertHistoryInsert = typeof alertHistory.$inferInsert;

export interface IntelligenceSeedResult {
  customerContext: CustomerContextInsert[];
  healthScoreHistory: HealthScoreHistoryInsert[];
  mrrSnapshots: MrrSnapshotInsert[];
  alerts: AlertInsert[];
  alertHistory: AlertHistoryInsert[];
}

export interface TrajectoryPoint {
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

export interface IntelligenceSeedInputs {
  accountId: string;
  now: Date;
  customers: DemoCustomer[];
  failedPayments: FailedPaymentInsert[];
  recoveredPayments: RecoveredPaymentInsert[];
  disputes: DisputeInsert[];
  /**
   * Starts the ids of the rows not keyed by a customer (snapshots, alerts), so
   * two demo businesses never share one. Teamflow's "d" by default.
   */
  idPrefix?: string;
  disputeOnlyPlan?: (amountCents: number) => DisputeOnlyPlan;
}

export function buildIntelligenceSeed(inputs: IntelligenceSeedInputs): IntelligenceSeedResult {
  const { accountId, now, customers, failedPayments, recoveredPayments, disputes } = inputs;
  const idPrefix = inputs.idPrefix ?? "d";
  const disputeOnlyPlan = inputs.disputeOnlyPlan ?? teamflowDisputeOnlyPlan;

  const customerContextRows: CustomerContextInsert[] = [];
  const healthHistoryRows: HealthScoreHistoryInsert[] = [];

  const baseIds = new Set(customers.map((c) => c.stripeCustomerId));
  const baseDisputes = new Map(
    disputes
      .filter((d) => baseIds.has(d.stripeCustomerId as string))
      .map((d) => [d.stripeCustomerId as string, d]),
  );

  for (const c of customers) {
    const recovery = aggregateRecovery(c.stripeCustomerId, failedPayments, recoveredPayments);
    const trajectory: TrajectoryPoint[] = c.scripted
      ? c.scripted.healthTrajectory.map((p) => ({
          daysAgo: p.daysAgo,
          healthScore: p.healthScore,
          reason: p.reason,
        }))
      : heuristicTrajectory(recovery, c.stripeCustomerId);
    const healthScore = trajectory[trajectory.length - 1]?.healthScore ?? 70;
    const healthFactors = deriveHealthFactors(trajectory);
    const engagementSignals = engagementSignalsFor(
      c.stripeCustomerId,
      c.scripted?.engagementOverride,
      recovery,
      now,
    );
    const baseDispute = baseDisputes.get(c.stripeCustomerId);
    const disputeSignals = baseDispute ? aggregateDispute(baseDispute) : {};
    const tenureMonths = Math.max(
      1,
      Math.round((now.getTime() - c.customerSince.getTime()) / (30 * DAY_MS)),
    );
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
      scheduledChangeKind: c.scheduledChange?.kind ?? null,
      scheduledChangeAt: c.scheduledChange
        ? new Date(now.getTime() + c.scheduledChange.daysFromNow * DAY_MS)
        : null,
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

  const disputeOnlyRoster: { id: string; planName: string; joinedAt: Date; mrrCents: number }[] =
    [];
  for (const d of disputes) {
    if (baseIds.has(d.stripeCustomerId as string)) continue;
    const seed = d.stripeCustomerId as string;
    const { tier, planName, mrrCents } = disputeOnlyPlan(d.amountCents);
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
      currentPlanName: planName,
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

    disputeOnlyRoster.push({ id: d.stripeCustomerId as string, planName, joinedAt, mrrCents });
  }

  const roster = buildMrrRoster(customers, disputeOnlyRoster);
  const mrrSnapshotRows = buildSnapshots(accountId, idPrefix, roster, now);
  const { alerts: alertRows, history: alertHistoryRows } = buildAlerts(accountId, idPrefix, now);

  return {
    customerContext: customerContextRows,
    healthScoreHistory: healthHistoryRows,
    mrrSnapshots: mrrSnapshotRows,
    alerts: alertRows,
    alertHistory: alertHistoryRows,
  };
}
