import type { Db } from "~/db";
import { DECLINE_CATEGORIES, type DeclineCategory } from "~/lib/constants";
import { isCardExpiringSoon } from "~/lib/recovery/expiring-card";
import {
  countActiveWinbacks,
  countPreviousFailuresByCustomer,
  getConnectionSummary,
  getMostRecentRecoveryAt,
  listExecutedEmailSteps,
  listExpiringCardAlerts,
  listFailuresWithOutcome,
  listActiveFailedPayments,
  listRecentFailedPayments,
  listRecoveredWithFailureContext,
  listReactivatedWinbacks,
  listUpcomingSteps,
  type ConnectionSummary,
  type FailedPaymentRow,
  type UpcomingStepRow,
} from "~/lib/recovery/queries.server";
import type { CurrencyAmount } from "./stats.server";
import {
  bestCategory,
  categorySparklineWindow,
  classifyWebhookHealth,
  type CategorySparklinePoint,
  countByDay,
  countByDayAndCategory,
  cumulativeRecoveryRateDaily,
  type DailyRatePoint,
  formatRelativeTime,
  type RecoveryTimingBucket,
  recoveryTimingBuckets,
  resolveRangeCutoff,
  type RecoveryRange,
  SPARKLINE_TRAILING_DAYS,
  type WebhookHealth,
} from "./recovery-window";

// The Recovery dashboard windowed read model (TASK-foxhound-recovery-surface-
// parity.md Phase 1): Foxhound's equivalent of legacy's fetchDashboardData.
// ONE function, called with ONE range, computing the full picture for that
// range. The dual-range behavior (primary/secondary stat cards + timing chart
// always 30d, everything else following the selector) is NOT built into this
// function - it lives entirely in the CALLER (Phase 2's loader), which calls
// this twice (once for the selected range, once for a fixed '30d', reusing
// the single call when they're already equal, exactly like legacy's page.tsx)
// and picks fields from whichever result each panel needs. This function
// stays uniform on purpose: some of its fields are naturally range-invariant
// (current-state facts like activePaymentsCount, or the always-30d
// categorySparkline), and that falls out of what each field actually means,
// not a branch on which call this is.

const DAY_MS = 24 * 60 * 60 * 1000;
const UPCOMING_STEPS_WINDOW_MS = 48 * 60 * 60 * 1000;

function groupSumByCurrency(rows: { currency: string; amountCents: number }[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountCents);
  return [...totals.entries()].map(([currency, cents]) => ({ currency, cents }));
}

export interface RecoveryDashboardWindow {
  rangeLabel: string;
  rangeDays: number;

  // Stat cards, scoped to this call's range.
  totalFailedCount: number;
  recoveredCount: number;
  recoveryRatePct: number | null;
  recoveredRevenue: CurrencyAmount[];
  recoveryDaysCount: number;
  avgDaysToRecovery: number | null;
  recoveryTimingBuckets: RecoveryTimingBucket[];

  // Current-state facts: naturally range-invariant, "right now" not "in range".
  activePaymentsCount: number;
  atRiskRevenue: CurrencyAmount[];
  activeWinbacksCount: number;
  expiringCardsCount: number;
  connection: ConnectionSummary | null;
  webhookHealth: WebhookHealth | null;
  lastRecoveryAgo: string | null;
  upcomingSteps: UpcomingStepRow[];

  // Decline analysis, scoped to this call's range (categorySparkline is the
  // one exception: always a genuine trailing 30 days, see recovery-window.ts).
  categoryBreakdown: Partial<Record<DeclineCategory, number>>;
  categoryStats: Partial<Record<DeclineCategory, { total: number; recovered: number }>>;
  bestCategory: { cat: DeclineCategory; rate: number } | null;
  categorySparkline: Partial<Record<DeclineCategory, CategorySparklinePoint[]>>;
  recoveryRateDaily: DailyRatePoint[];

  // Email engagement: UNSCOPED by range (verified against legacy's actual
  // source, which carries no date filter on this query at all).
  emailCategoryPerformance: { category: DeclineCategory; openRatePct: number; clickRatePct: number; emailCount: number }[];
  totalEmailsSent: number;
  openRatePct: number;
  clickRatePct: number;

  // Win-back reactivation, scoped to this call's range.
  reactivatedCount: number;
  reactivatedRevenue: CurrencyAmount[];

  // Recent-activity preview, scoped to this call's range.
  recentPayments: FailedPaymentRow[];
  previousFailureCounts: Record<string, number>;
  recoveredPayments: { recoveredAt: Date; amountCents: number; currency: string }[];
}

export async function getRecoveryDashboardWindow(
  db: Db,
  accountId: string,
  range: RecoveryRange,
  nowMs: number,
): Promise<RecoveryDashboardWindow> {
  const { cutoffMs, rangeDays, rangeLabel } = resolveRangeCutoff(range, nowMs);
  const sparklineCutoffMs = nowMs - SPARKLINE_TRAILING_DAYS * DAY_MS;

  const [
    failuresWithOutcome,
    sparklineFailures,
    recovered,
    activePayments,
    emailSteps,
    reactivated,
    activeWinbacksCount,
    expiringCards,
    connection,
    lastRecoveryAt,
    upcomingSteps,
    recentPayments,
  ] = await Promise.all([
    listFailuresWithOutcome(db, accountId, cutoffMs),
    listFailuresWithOutcome(db, accountId, sparklineCutoffMs),
    listRecoveredWithFailureContext(db, accountId, cutoffMs),
    listActiveFailedPayments(db, accountId),
    listExecutedEmailSteps(db, accountId),
    listReactivatedWinbacks(db, accountId, cutoffMs),
    countActiveWinbacks(db, accountId),
    listExpiringCardAlerts(db, accountId),
    getConnectionSummary(db, accountId),
    getMostRecentRecoveryAt(db, accountId),
    listUpcomingSteps(db, accountId, nowMs, UPCOMING_STEPS_WINDOW_MS),
    listRecentFailedPayments(db, accountId, cutoffMs),
  ]);

  const previousFailureCounts = await countPreviousFailuresByCustomer(
    db,
    accountId,
    [...new Set(recentPayments.map((p) => p.stripeCustomerId))],
  );

  // ---- Category breakdown / stats: ONE cohort (failures detected in this
  // window, per listFailuresWithOutcome), never legacy's mismatch of a
  // detected_at-anchored total against a separately recovered_at-anchored
  // recovered count. ----
  const categoryBreakdown: Partial<Record<DeclineCategory, number>> = {};
  const categoryStats: Partial<Record<DeclineCategory, { total: number; recovered: number }>> = {};
  let recoveredInCohortCount = 0;
  for (const row of failuresWithOutcome) {
    categoryBreakdown[row.declineCategory] = (categoryBreakdown[row.declineCategory] ?? 0) + 1;
    const stat = categoryStats[row.declineCategory] ?? { total: 0, recovered: 0 };
    stat.total++;
    if (row.recoveredAt) {
      stat.recovered++;
      recoveredInCohortCount++;
    }
    categoryStats[row.declineCategory] = stat;
  }

  // ---- Recovery days / timing / avg: EVENT-anchored (recovered, from
  // listRecoveredWithFailureContext), not the detected-at cohort above. This
  // is a distribution over recoveries that happened in this window and how
  // long each took - a question about the recovery events themselves, same
  // as recoveredRevenue, not about the cohort of failures that started the
  // window (which is what totalFailedCount/recoveredCount/categoryStats are
  // for). Legacy anchors this the same way, off its one recovered_at-anchored
  // query; the rate/count/category-stats side is the only part that needed
  // to move onto a single detected-at cohort. ----
  const recoveryDays = recovered
    .map((r) => (r.recoveredAt.getTime() - r.detectedAt.getTime()) / DAY_MS)
    .filter((d) => d >= 0);
  const avgDaysToRecovery =
    recoveryDays.length > 0 ? Math.round((recoveryDays.reduce((a, b) => a + b, 0) / recoveryDays.length) * 10) / 10 : null;

  // ---- Daily recovery-rate trend: failedByDay from the detected-at cohort,
  // recoveredByDay from the cash-flow (recovered_at-anchored) population -
  // deliberately different questions, per the cumulative-rate design (see
  // recovery-window.ts's own comment on why this is cumulative, not same-day). ----
  const failedByDay = countByDay(failuresWithOutcome.map((r) => r.detectedAt));
  const recoveredByDay = countByDay(recovered.map((r) => r.recoveredAt));
  const recoveryRateDaily = cumulativeRecoveryRateDaily(failedByDay, recoveredByDay, rangeDays, nowMs);

  // ---- Category sparkline: ALWAYS trailing 30 days, independent of `range` ----
  const sparklineByCatByDay = countByDayAndCategory(sparklineFailures);
  const categorySparkline = categorySparklineWindow(sparklineByCatByDay, nowMs);

  // ---- Email engagement (unscoped by range) ----
  const emailBuckets: Partial<Record<DeclineCategory, { sent: number; opened: number; clicked: number }>> = {};
  for (const step of emailSteps) {
    const bucket = emailBuckets[step.declineCategory] ?? { sent: 0, opened: 0, clicked: 0 };
    bucket.sent++;
    if (step.openedAt) bucket.opened++;
    if (step.clickedAt) bucket.clicked++;
    emailBuckets[step.declineCategory] = bucket;
  }
  const emailCategoryPerformance = DECLINE_CATEGORIES.filter((c) => emailBuckets[c]).map((category) => {
    const b = emailBuckets[category]!;
    return {
      category,
      openRatePct: Math.round((b.opened / b.sent) * 100),
      clickRatePct: Math.round((b.clicked / b.sent) * 100),
      emailCount: b.sent,
    };
  });
  const totalEmailsSent = emailSteps.length;
  const totalOpened = emailSteps.filter((s) => s.openedAt).length;
  const totalClicked = emailSteps.filter((s) => s.clickedAt).length;
  const openRatePct = totalEmailsSent > 0 ? Math.round((totalOpened / totalEmailsSent) * 100) : 0;
  const clickRatePct = totalEmailsSent > 0 ? Math.round((totalClicked / totalEmailsSent) * 100) : 0;

  // ---- Current-state facts (range-invariant) ----
  const activePaymentsCount = activePayments.length;
  const atRiskRevenue = groupSumByCurrency(activePayments);
  const expiringCardsCount = expiringCards.filter((c) =>
    isCardExpiringSoon(c.expiresYear, c.expiresMonth, new Date(nowMs)),
  ).length;
  const webhookHealth = connection ? classifyWebhookHealth(connection.lastWebhookAt, nowMs) : null;
  const lastRecoveryAgo = formatRelativeTime(lastRecoveryAt, nowMs);

  return {
    rangeLabel,
    rangeDays,
    totalFailedCount: failuresWithOutcome.length,
    recoveredCount: recoveredInCohortCount,
    recoveryRatePct:
      failuresWithOutcome.length > 0 ? Math.round((recoveredInCohortCount / failuresWithOutcome.length) * 100) : null,
    recoveredRevenue: groupSumByCurrency(recovered),
    recoveryDaysCount: recoveryDays.length,
    avgDaysToRecovery,
    recoveryTimingBuckets: recoveryTimingBuckets(recoveryDays),
    activePaymentsCount,
    atRiskRevenue,
    activeWinbacksCount,
    expiringCardsCount,
    connection,
    webhookHealth,
    lastRecoveryAgo,
    upcomingSteps,
    categoryBreakdown,
    categoryStats,
    bestCategory: bestCategory(categoryStats),
    categorySparkline,
    recoveryRateDaily,
    emailCategoryPerformance,
    totalEmailsSent,
    openRatePct,
    clickRatePct,
    reactivatedCount: reactivated.length,
    reactivatedRevenue: groupSumByCurrency(
      reactivated
        .filter((r): r is { amountCents: number; currency: string } => r.amountCents != null && r.currency != null)
        .map((r) => ({ amountCents: r.amountCents, currency: r.currency })),
    ),
    recentPayments,
    previousFailureCounts,
    recoveredPayments: recovered.map((r) => ({
      recoveredAt: r.recoveredAt,
      amountCents: r.amountCents,
      currency: r.currency,
    })),
  };
}
