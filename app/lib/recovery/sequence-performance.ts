import type { DeclineCategory } from "~/lib/constants";
import { formatStepType } from "./labels";
import { isEmailStep, isRetryStep, RECOVERY_SCHEDULES } from "./schedule";
import { plural } from "@drdustinedwards/site-helpers/text";
import { percent } from "capsomer/behavior/meter";

// No DB access; takes whatever rows the caller already fetched (listExecutedRecoverySteps).

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

interface BestPerformingStep {
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

const MIN_SENT_FOR_BEST_STEP = 3;

// Where a step type sits in the pooled chart's order: its EARLIEST offset in any schedule. Ordering
// only, never shown as a timing.
const STEP_ORDER_HOURS: Record<string, number> = {};
for (const schedule of Object.values(RECOVERY_SCHEDULES)) {
  for (const step of schedule) {
    const seen = STEP_ORDER_HOURS[step.stepType];
    if (seen === undefined || step.offsetHours < seen)
      STEP_ORDER_HOURS[step.stepType] = step.offsetHours;
  }
}

/** "1" -> "1 hour after failure"; "72" -> "72 hours after failure". */
export function formatStepTiming(hours: number): string {
  return `${plural(hours, "hour")} after failure`;
}

/**
 * An email is named by its step type. A step with no offset falls back to the shared label
 * (formatStepType); none is invented.
 */
export function sequenceStepLabel(stepType: string, offsetHours: number | null): string {
  if (stepType === "email_revoked") return "Revocation email";
  const emailDay = /^email_day(\d+)$/.exec(stepType);
  if (emailDay) return `Day ${emailDay[1]} email`;
  if (isRetryStep(stepType) && offsetHours !== null) {
    return offsetHours <= 48
      ? `${offsetHours}hr retry`
      : `Day ${Math.round(offsetHours / 24)} retry`;
  }
  return formatStepType(stepType);
}

export function summarizeStepPerformance(steps: StepPerformanceInput[]): StepPerformanceSummary {
  const emailSteps = steps.filter((s) => isEmailStep(s.stepType));
  const totalSent = emailSteps.length;
  const totalOpened = emailSteps.filter((s) => s.openedAt).length;
  const totalClicked = emailSteps.filter((s) => s.clickedAt).length;
  const avgOpenRatePct = percent(totalOpened, totalSent);
  const avgClickRatePct = percent(totalClicked, totalSent);

  const byType = new Map<
    string,
    { sent: number; opened: number; clicked: number; recovered: number }
  >();
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
      openRatePct: percent(b.opened, b.sent),
      clickRatePct: percent(b.clicked, b.sent),
      recoveryRatePct: percent(b.recovered, b.sent),
    }))
    .sort(
      (a, b) =>
        (STEP_ORDER_HOURS[a.stepType] ?? Infinity) - (STEP_ORDER_HOURS[b.stepType] ?? Infinity),
    );

  let bestStep: BestPerformingStep | null = null;
  for (const point of chart) {
    if (point.sent < MIN_SENT_FOR_BEST_STEP) continue;
    if (!bestStep || point.clickRatePct > bestStep.clickRatePct) {
      bestStep = { label: point.label, clickRatePct: point.clickRatePct };
    }
  }

  return { totalSent, avgOpenRatePct, avgClickRatePct, bestStep, chart };
}

interface EmailStepCard {
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

interface RetryStepCard {
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
 * One per-step card for a category section: a silent-retry card (no email stats, a
 * recovered-of-attempted ratio) when the step is a retry, otherwise an email card
 * (sent/opened/clicked, latest subject, sanitized body for the preview expander). `rows` must
 * already be filtered to this exact stepType.
 */
export function buildStepCard(
  stepType: string,
  rows: StepCardRow[],
  offsetHours: number | null,
): StepCard {
  const label = sequenceStepLabel(stepType, offsetHours);
  const timingLabel = offsetHours === null ? null : formatStepTiming(offsetHours);

  if (isRetryStep(stepType)) {
    // An expired card's guarded retry that was skipped made no charge
    // (card-change.ts), so it is not an attempt: counting it would show
    // charges that never happened and drag the rate down with them.
    const charged = rows.filter((r) => !r.result?.startsWith("retry_skipped_"));
    const attempted = charged.length;
    const recovered = charged.filter((r) => r.result === "retry_succeeded").length;
    return {
      kind: "retry",
      stepType,
      label,
      timingLabel,
      attempted,
      recovered,
      successRatePct: attempted > 0 ? percent(recovered, attempted) : null,
    };
  }

  const sent = rows.length;
  const opened = rows.filter((r) => r.openedAt).length;
  const clicked = rows.filter((r) => r.clickedAt).length;
  const newestFirst = [...rows].sort((a, b) => b.executedAt.getTime() - a.executedAt.getTime());
  const latest = newestFirst.find((r) => r.aiSubject) ?? newestFirst[0] ?? null;
  return {
    kind: "email",
    stepType,
    label,
    timingLabel,
    sent,
    openRatePct: sent > 0 ? percent(opened, sent) : null,
    clickRatePct: sent > 0 ? percent(clicked, sent) : null,
    latestSubject: latest?.aiSubject ?? null,
    latestBodyHtml: latest?.aiBodyHtml ?? null,
  };
}

export interface CategorySection {
  category: DeclineCategory;
  stepCards: StepCard[];
}

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
