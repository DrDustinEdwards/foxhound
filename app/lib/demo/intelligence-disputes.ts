import type { DisputeInsert } from "./disputes-seed";
import { seededInt } from "./customer-base";
import { DAY_MS } from "~/lib/constants";
import type { TrajectoryPoint } from "./intelligence-seed";

// Dispute-only customers (net-new: a demo business's disputes mostly belong to
// customers not otherwise in its 200-customer base. A disputed customer who IS
// in the base, Teamflow's Harborline Group, just gets its dispute_signals
// merged in.)

/**
 * The plan a net-new dispute-only customer is on, read off the disputed charge.
 * Teamflow's rule by default; Bolt Analytics sells Pro only.
 */
export interface DisputeOnlyPlan {
  tier: string;
  planName: string;
  mrrCents: number;
}

export function teamflowDisputeOnlyPlan(amountCents: number): DisputeOnlyPlan {
  return amountCents >= 30000
    ? { tier: "scale", planName: "Scale", mrrCents: 29900 }
    : { tier: "growth", planName: "Growth", mrrCents: 9900 };
}

export function boltDisputeOnlyPlan(): DisputeOnlyPlan {
  return { tier: "pro", planName: "Pro", mrrCents: 9900 };
}

interface DisputeAggregate {
  openDisputesCount: number;
  wonCount: number;
  lostCount: number;
  totalDisputedCents: number;
  lastDisputeAt: Date;
  lastOutcome: string | null;
  activeDisputeId: string | null;
}

export function aggregateDispute(d: DisputeInsert): DisputeAggregate {
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

export function disputeTrajectory(
  agg: DisputeAggregate,
  now: Date,
  seed: string,
): TrajectoryPoint[] {
  const baseline = 70 + seededInt(`${seed}:b`, 12);
  const won = agg.wonCount > 0;
  const lost = agg.lostCount > 0;
  const final = won
    ? Math.max(60, baseline - 5)
    : lost
      ? Math.max(30, baseline - 35)
      : Math.max(45, baseline - 18);
  const disputeAgeDays = Math.round((now.getTime() - agg.lastDisputeAt.getTime()) / DAY_MS);
  return [
    { daysAgo: Math.max(150, disputeAgeDays + 40), healthScore: baseline, reason: "baseline" },
    { daysAgo: Math.max(90, disputeAgeDays + 30), healthScore: baseline + 2, reason: "stable" },
    { daysAgo: Math.max(60, disputeAgeDays + 20), healthScore: baseline, reason: "stable" },
    {
      daysAgo: Math.max(40, disputeAgeDays + 10),
      healthScore: Math.max(40, baseline - 20),
      reason: "dispute_opened",
    },
    {
      daysAgo: Math.max(20, disputeAgeDays),
      healthScore: won ? baseline - 8 : lost ? baseline - 30 : baseline - 18,
      reason: won ? "dispute_won" : lost ? "dispute_lost" : "dispute_in_progress",
    },
    { daysAgo: 3, healthScore: final, reason: "present" },
  ];
}
