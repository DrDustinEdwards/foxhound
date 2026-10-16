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

/** "1" -> "1 hour after failure"; "72" -> "72 hours after failure". Hours at
 *  every offset, as Recova's chips say them (SequenceView.tsx 5507b89f:
 *  "72 hours after failure", "168 hours after failure"). */
export function formatStepTiming(hours: number): string {
  return `${hours} hour${hours === 1 ? "" : "s"} after failure`;
}

/**
 * A step's name on this page, in Recova's words (SequenceView.tsx STEP_META and
 * lib/sequence-utils.ts stepLabelFor): "Day 3 email", "4hr retry", "48hr
 * retry", "Day 21 retry". An email is named by its step type. A retry is named
 * by its offset in the schedule it sits in, because Recova's "48hr retry" is a
 * statement of time and network's retry_day2 runs at 24 hours. A step with no
 * offset falls back to the shared label (formatStepType); none is invented.
 */
export function sequenceStepLabel(stepType: string, offsetHours: number | null): string {
  if (stepType === "email_revoked") return "Revocation email";
  const emailDay = /^email_day(\d+)$/.exec(stepType);
  if (emailDay) return `Day ${emailDay[1]} email`;
  if (isRetryStep(stepType) && offsetHours !== null) {
    return offsetHours <= 48 ? `${offsetHours}hr retry` : `Day ${Math.round(offsetHours / 24)} retry`;
  }
  return formatStepType(stepType);
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
      label: sequenceStepLabel(stepType, null),
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
  const label = sequenceStepLabel(stepType, offsetHours);
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
  // Recova's pick: the newest send that has a subject, else the newest send,
  // with that same send's body (SequenceView.tsx, `recent`).
  const newestFirst = [...rows].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
  const latest = newestFirst.find((r) => r.aiSubject) ?? newestFirst[0] ?? null;
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

