import type { DeclineCategory } from "~/lib/constants";
import { formatStepType } from "./labels";
import { isEmailStep, isRetryStep, RECOVERY_SCHEDULES } from "./schedule";

// Pure account-wide step-performance aggregation for /recovery/sequence
// (Foxhound's equivalent of legacy's sequence-utils.ts + SequenceView.tsx),
// rebuilt against Foxhound's REAL 6-category schedule (schedule.ts), not
// legacy's 4-category hardcoded step list. No DB access; takes whatever rows
// the caller already fetched (listExecutedRecoverySteps).

export interface StepPerformanceInput {
  stepType: string;
  result: string | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  creditedRecovery: boolean;
}

export interface StepPerformancePoint {
  stepType: string;
  label: string;
  sent: number;
  openRatePct: number;
  clickRatePct: number;
  recoveryRatePct: number;
}

export interface BestPerformingStep {
  label: string;
  clickRatePct: number;
}

export interface StepPerformanceSummary {
  totalSent: number;
  avgOpenRatePct: number;
  avgClickRatePct: number;
  bestStep: BestPerformingStep | null;
  chart: StepPerformancePoint[];
}

/** A step type must have been sent at least this many times before its click
 *  rate is considered for "best-performing step" - direct port of legacy's
 *  threshold, so 1-2 lucky sends can't win the headline. */
const MIN_SENT_FOR_BEST_STEP = 3;

// Where a step type sits in the pooled chart's order: its EARLIEST offset in
// any schedule. Ordering only, never shown as a timing. A step type alone does
// not name one offset, because categories schedule the same step at different
// hours (day 1 at 1 hour for expired, 2 for fraud, 24 for soft; network's
// retry_day2 and day 3 earlier than soft's), so every timing the page SHOWS is
// read from the section's own schedule (buildCategorySections).
const STEP_ORDER_HOURS: Record<string, number> = {};
for (const schedule of Object.values(RECOVERY_SCHEDULES)) {
  for (const step of schedule) {
    const seen = STEP_ORDER_HOURS[step.stepType];
    if (seen === undefined || step.offsetHours < seen) STEP_ORDER_HOURS[step.stepType] = step.offsetHours;
  }
}

/** "4" -> "4 hours after failure"; "24" -> "1 day after failure". Every real
 *  STEP_TIMING_* constant is either under 24 or an exact multiple of 24, so
 *  this never needs to round. */
export function formatStepTiming(hours: number): string {
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} after failure`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} after failure`;
}

/**
 * Account-wide email step performance, pooled across every decline category:
 * "Day 3 email" is one number regardless of which category triggered it, same
 * pooling legacy used. Retry steps are excluded, same reasoning as legacy -
 * click tracking only exists for an actual email; a retry's own success rate
 * is a different question, answered per-category by buildStepCard below.
 */
export function summarizeStepPerformance(steps: StepPerformanceInput[]): StepPerformanceSummary {
  const emailSteps = steps.filter((s) => isEmailStep(s.stepType));
  const totalSent = emailSteps.length;
  const totalOpened = emailSteps.filter((s) => s.openedAt).length;
  const totalClicked = emailSteps.filter((s) => s.clickedAt).length;
  const avgOpenRatePct = totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0;
  const avgClickRatePct = totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0;

  const byType = new Map<string, { sent: number; opened: number; clicked: number; recovered: number }>();
  for (const s of emailSteps) {
    const bucket = byType.get(s.stepType) ?? { sent: 0, opened: 0, clicked: 0, recovered: 0 };
    bucket.sent++;
    if (s.openedAt) bucket.opened++;
    if (s.clickedAt) bucket.clicked++;
    if (s.creditedRecovery) bucket.recovered++;
    byType.set(s.stepType, bucket);
  }

  const chart: StepPerformancePoint[] = [...byType.entries()]
    .map(([stepType, b]) => ({
      stepType,
      label: formatStepType(stepType),
      sent: b.sent,
      openRatePct: Math.round((b.opened / b.sent) * 100),
      clickRatePct: Math.round((b.clicked / b.sent) * 100),
      recoveryRatePct: Math.round((b.recovered / b.sent) * 100),
    }))
    .sort((a, b) => (STEP_ORDER_HOURS[a.stepType] ?? Infinity) - (STEP_ORDER_HOURS[b.stepType] ?? Infinity));

  let bestStep: BestPerformingStep | null = null;
  for (const point of chart) {
    if (point.sent < MIN_SENT_FOR_BEST_STEP) continue;
    if (!bestStep || point.clickRatePct > bestStep.clickRatePct) {
      bestStep = { label: point.label, clickRatePct: point.clickRatePct };
    }
  }

  return { totalSent, avgOpenRatePct, avgClickRatePct, bestStep, chart };
}

export interface EmailStepCard {
  kind: "email";
  stepType: string;
  label: string;
  timingLabel: string | null;
  sent: number;
  openRatePct: number | null;
  clickRatePct: number | null;
  latestSubject: string | null;
  /** Already-sanitized HTML (see email-preview.server.ts), or null when the
   *  most recent send has no stored body. */
  latestBodyHtml: string | null;
}

export interface RetryStepCard {
  kind: "retry";
  stepType: string;
  label: string;
  timingLabel: string | null;
  attempted: number;
  recovered: number;
  successRatePct: number | null;
}

export type StepCard = EmailStepCard | RetryStepCard;

export interface StepCardRow {
  executedAt: Date;
  result: string | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  aiSubject: string | null;
  /** Pre-sanitized by the caller (email-preview.server.ts); this module never
   *  touches raw AI HTML. */
  aiBodyHtml: string | null;
}

/**
 * One per-step card for a category section: a silent-retry card (no email
 * stats, a recovered-of-attempted ratio) when the step is a retry, otherwise
 * an email card (sent/opened/clicked, latest subject, sanitized body for the
 * preview expander). `rows` must already be filtered to this exact stepType.
 * `offsetHours` is this step's offset in THIS category's schedule, or null for
 * a step no schedule defines (no timing is invented).
 */
export function buildStepCard(stepType: string, rows: StepCardRow[], offsetHours: number | null): StepCard {
  const label = formatStepType(stepType);
  const timingLabel = offsetHours === null ? null : formatStepTiming(offsetHours);

  if (isRetryStep(stepType)) {
    const attempted = rows.length;
    const recovered = rows.filter((r) => r.result === "retry_succeeded").length;
    return {
      kind: "retry",
      stepType,
      label,
      timingLabel,
      attempted,
      recovered,
      successRatePct: attempted > 0 ? Math.round((recovered / attempted) * 100) : null,
    };
  }

  const sent = rows.length;
  const opened = rows.filter((r) => r.openedAt).length;
  const clicked = rows.filter((r) => r.clickedAt).length;
  const latest = [...rows].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime())[0] ?? null;
  return {
    kind: "email",
    stepType,
    label,
    timingLabel,
    sent,
    openRatePct: sent > 0 ? Math.round((opened / sent) * 100) : null,
    clickRatePct: sent > 0 ? Math.round((clicked / sent) * 100) : null,
    latestSubject: latest?.aiSubject ?? null,
    latestBodyHtml: latest?.aiBodyHtml ?? null,
  };
}

export interface CategorySection {
  category: DeclineCategory;
  stepCards: StepCard[];
}

/** One section per real Foxhound decline category, steps in real schedule
 *  order (schedule.ts), never legacy's 4-category subset. */
export function buildCategorySections(
  categories: readonly DeclineCategory[],
  steps: (StepCardRow & { declineCategory: DeclineCategory; stepType: string })[],
): CategorySection[] {
  return categories.map((category) => {
    const schedule = RECOVERY_SCHEDULES[category];
    const categorySteps = steps.filter((s) => s.declineCategory === category);
    const stepCards = schedule.map((scheduledStep) =>
      buildStepCard(
        scheduledStep.stepType,
        categorySteps.filter((s) => s.stepType === scheduledStep.stepType),
        scheduledStep.offsetHours,
      ),
    );
    return { category, stepCards };
  });
}
