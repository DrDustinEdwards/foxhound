import type { FailedPaymentInsert, RecoveredPaymentInsert } from "./recovery-seed";
import { seededInt, type DemoEngagementOverride } from "./customer-base";
import { DAY_MS } from "~/lib/constants";
import type { TrajectoryPoint } from "./intelligence-seed";

// Recovery + engagement signals (from the recovery seed's own output, so this
// never re-derives a competing view of the same rows)

interface RecoveryAggregate {
  failedPaymentCount: number;
  recoveredCount: number;
  recoveredAmountCents: number;
  lastFailedAt: Date | null;
  lastRecoveredAt: Date | null;
  activeRecoveryId: string | null;
  unrecoveredCount: number;
}

export function aggregateRecovery(
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
  const lastFailedAt =
    mine.map((f) => f.detectedAt).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
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

export function engagementSignalsFor(
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
        override.lastEmailOpenedAtDaysAgo == null
          ? null
          : new Date(now.getTime() - override.lastEmailOpenedAtDaysAgo * DAY_MS),
    };
  }
  const idxNum = parseInt(stripeCustomerId.replace(/[^0-9]/g, ""), 10) || 0;
  const opened30 = recovery.failedPaymentCount > 0 && idxNum % 10 < 3 ? 1 + (idxNum % 3) : 0;
  const clicked30 = opened30 > 0 && idxNum % 25 < 2 ? 1 : 0;
  return {
    emailOpened30d: opened30,
    emailClicked30d: clicked30,
    lastEmailOpenedAt:
      opened30 > 0
        ? new Date(now.getTime() - (seededInt(`${stripeCustomerId}:eng`, 25) + 1) * DAY_MS)
        : null,
  };
}

// Health score + trajectory (scripted trajectory wins; anonymous customers get
// a heuristic trajectory driven by their own recovery outcome)

export function heuristicTrajectory(recovery: RecoveryAggregate, seed: string): TrajectoryPoint[] {
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
      healthScore: hasRecovered
        ? dipped + 10
        : recovery.failedPaymentCount > 0
          ? dipped - 3
          : baseline,
      reason: hasRecovered
        ? "in_recovery"
        : recovery.failedPaymentCount > 0
          ? "still_unrecovered"
          : "stable",
    },
    {
      daysAgo: 3,
      healthScore: final,
      reason: hasRecovered
        ? "recovery_succeeded"
        : hasActive
          ? "in_recovery"
          : hasUnrecovered
            ? "declining"
            : "stable",
    },
  ];
}
