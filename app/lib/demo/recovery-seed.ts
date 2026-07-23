import type {
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import type { DeclineCategory } from "~/lib/constants";
import { classifyDecline } from "~/lib/recovery/decline";
import { isEmailStep, isRetryStep, planRecoverySteps, WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { isLastWinbackStep, nextWinbackStatus, planWinbackSteps, type WinbackStatus } from "~/lib/recovery/winback";

import {
  invoiceAmountCents,
  isDayWalkEligible,
  monthlyTotalCents,
  planNameFor,
  pick,
  seededFloat,
  seededInt,
  type DemoCustomer,
} from "./customer-base";

// Recovery seed (TASK-foxhound-demo-data-engine.md Phase 2): the day-walk
// failed-payment simulator + win-back + expiring-card alerts. Ported from
// legacy lib/demo-seeding/seed-failed-payments.ts, adapted to reuse Foxhound's
// REAL recovery engine (planRecoverySteps/RECOVERY_SCHEDULES, classifyDecline,
// findAttributionSignals/resolveAttribution) rather than re-deriving a parallel
// step schedule or attribution model. Pure: returns plain insert-row arrays,
// no DB access, no I/O; app/lib/demo/seed.ts turns these into db.insert(...)
// batches. Every row's shape is exactly what the REAL webhook/executor flow
// would have written, so /recovery's loaders (and attribution.ts's own
// findAttributionSignals) can't tell a seeded row from a live one.

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const WALK_DAYS = 90;

export type FailedPaymentInsert = typeof failedPayments.$inferInsert;
export type RecoveryStepInsert = typeof recoverySteps.$inferInsert;
export type RecoveredPaymentInsert = typeof recoveredPayments.$inferInsert;
export type ExpiringCardAlertInsert = typeof expiringCardAlerts.$inferInsert;
export type WinBackSequenceInsert = typeof winBackSequences.$inferInsert;
export type WinBackStepInsert = typeof winBackSteps.$inferInsert;

export interface RecoverySeedResult {
  failedPayments: FailedPaymentInsert[];
  recoverySteps: RecoveryStepInsert[];
  recoveredPayments: RecoveredPaymentInsert[];
  expiringCardAlerts: ExpiringCardAlertInsert[];
  winBackSequences: WinBackSequenceInsert[];
  winBackSteps: WinBackStepInsert[];
}

// ============================================================================
// Decline-code sampling (weighted, real Stripe codes -> classifyDecline so the
// seeded code/category pair can never drift out of sync with decline.ts)
// ============================================================================

const SOFT_CODES = ["insufficient_funds", "do_not_honor", "generic_decline"] as const;
const EXPIRED_CODES = ["expired_card"] as const;
const NETWORK_CODES = ["processing_error", "issuer_not_available", "try_again_later"] as const;
const FRAUD_CODES = ["fraudulent", "lost_card", "stolen_card"] as const;

function sampleDeclineCode(seed: string): string {
  const r = seededInt(`${seed}:cat`, 100);
  if (r < 50) return pick(`${seed}:code`, SOFT_CODES);
  if (r < 70) return pick(`${seed}:code`, EXPIRED_CODES);
  if (r < 90) return pick(`${seed}:code`, NETWORK_CODES);
  return pick(`${seed}:code`, FRAUD_CODES);
}

// ============================================================================
// Day-walk distribution (which day, how many failures, which customer)
// ============================================================================

function classifyDayIntensity(d: Date): "high" | "medium" | "low" {
  const dom = d.getUTCDate();
  if ((dom >= 1 && dom <= 5) || (dom >= 14 && dom <= 18)) return "high";
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return "low";
  return "medium";
}

// Scaled down from legacy (8/4/2) to keep the cold-seed path inside its
// latency budget at Teamflow's 200-customer scale (TASK-foxhound-demo-data-
// engine.md locked constraint #5).
function failuresForDay(intensity: "high" | "medium" | "low", seed: string): number {
  if (intensity === "high") return seededInt(`${seed}:n`, 4);
  if (intensity === "medium") return seededInt(`${seed}:n`, 2);
  return seededInt(`${seed}:n`, 1);
}

function anchorProximityWeight(c: DemoCustomer, day: Date): number {
  const dom = day.getUTCDate();
  const raw = Math.abs(dom - c.billingAnchorDay);
  const dist = Math.min(raw, 28 - raw);
  if (dist === 0) return 10;
  if (dist === 1) return 5;
  if (dist === 2) return 2;
  if (dist <= 4) return 0.5;
  return 0.05;
}

function pickCustomerForDay(
  eligible: DemoCustomer[],
  day: Date,
  seed: string,
  recentByCustomer: Map<string, Date[]>,
): DemoCustomer | null {
  const dayMs = day.getTime();
  const fiveDaysMs = 5 * DAY_MS;
  const weighted: Array<{ c: DemoCustomer; w: number }> = [];
  for (const c of eligible) {
    if (c.customerSince.getTime() > dayMs) continue;
    if (c.status === "churned" && c.churnedAt && c.churnedAt.getTime() <= dayMs) continue;
    const recents = recentByCustomer.get(c.stripeCustomerId) ?? [];
    if (recents.some((r) => Math.abs(r.getTime() - dayMs) < fiveDaysMs)) continue;
    let w = anchorProximityWeight(c, day);
    if (c.status === "at_risk") w *= 1.6;
    if (c.status === "paused") w *= 0.2;
    if (w <= 0) continue;
    weighted.push({ c, w });
  }
  if (weighted.length === 0) return null;
  const totalW = weighted.reduce((s, x) => s + x.w, 0);
  const target = seededFloat(`${seed}:pick`) * totalW;
  let acc = 0;
  for (const x of weighted) {
    acc += x.w;
    if (acc >= target) return x.c;
  }
  return weighted[weighted.length - 1].c;
}

function randomBusinessHour(day: Date, seed: string): Date {
  const d = new Date(day);
  d.setUTCHours(9 + seededInt(`${seed}:hr`, 9), seededInt(`${seed}:min`, 60), seededInt(`${seed}:sec`, 60), 0);
  return d;
}

// ============================================================================
// Outcome sampling: how a failure resolves, reusing the real schedule so the
// causing step is always a step the real engine would actually have run.
// ============================================================================

type ResolvedOutcome =
  | { kind: "recovered"; recoveredAt: Date; causeMode: "retry" | "click" | "baseline" }
  | { kind: "active" }
  | { kind: "failed_unrecovered" };

const RECOVERY_PROB: Record<DeclineCategory, number> = {
  soft: 0.5,
  network: 0.4,
  expired: 0.25,
  fraud: 0.05,
  revoked: 0.1,
  unknown: 0.15,
};

function sampleRecoveryDelayDays(category: DeclineCategory, seed: string): number {
  if (category === "soft" || category === "network") return 1 + seededInt(`${seed}:delay`, 3);
  if (category === "expired") return 7 + seededInt(`${seed}:delay`, 8);
  return 14 + seededInt(`${seed}:delay`, 17);
}

/** The last scheduled step's offset for a category, so a failure old enough
 *  to have exhausted its whole schedule (with no recovery) is terminal. */
function scheduleSpanHours(schedule: { offsetHours: number }[]): number {
  return schedule[schedule.length - 1]?.offsetHours ?? 0;
}

function resolveOutcome(
  category: DeclineCategory,
  detectedAt: Date,
  now: Date,
  schedule: { offsetHours: number }[],
  seed: string,
): ResolvedOutcome {
  const ageMs = now.getTime() - detectedAt.getTime();
  const willRecover = seededFloat(`${seed}:rec`) < RECOVERY_PROB[category];
  if (willRecover) {
    const delayDays = sampleRecoveryDelayDays(category, seed);
    const recoveredAt = new Date(detectedAt.getTime() + delayDays * DAY_MS);
    if (recoveredAt.getTime() <= now.getTime()) {
      const retryable = category === "soft" || category === "network";
      const r = seededInt(`${seed}:mode`, 100);
      const causeMode: "retry" | "click" | "baseline" = retryable
        ? r < 60
          ? "retry"
          : r < 85
            ? "click"
            : "baseline"
        : r < 70
          ? "click"
          : "baseline";
      return { kind: "recovered", recoveredAt, causeMode };
    }
    return { kind: "active" };
  }
  return ageMs > scheduleSpanHours(schedule) * HOUR_MS ? { kind: "failed_unrecovered" } : { kind: "active" };
}

// ============================================================================
// Per-failure row builder: turns one (customer, category, detectedAt, outcome)
// into a failedPayments row + its full recoverySteps timeline + an optional
// recoveredPayments row, via the REAL schedule + REAL attribution model.
// ============================================================================

interface BuiltFailure {
  failedPayment: FailedPaymentInsert;
  steps: RecoveryStepInsert[];
  recovered: RecoveredPaymentInsert | null;
}

function simulateOpenClick(seed: string): { openedAt: boolean; clickedAt: boolean } {
  const opened = seededInt(`${seed}:opened`, 100) < 30;
  const clicked = opened && seededInt(`${seed}:clicked`, 100) < 17;
  return { openedAt: opened, clickedAt: clicked };
}

function buildFailure(
  accountId: string,
  customer: DemoCustomer,
  category: DeclineCategory,
  declineCode: string,
  detectedAt: Date,
  now: Date,
  idSeq: number,
  isRenewalNoise: boolean,
  forcedOutcome?: ResolvedOutcome,
): BuiltFailure {
  const failedPaymentId = `dfp_${idSeq}`;
  const amountCents = invoiceAmountCents(customer);
  const schedule = planRecoverySteps({
    failedPaymentId,
    accountId,
    declineCategory: category,
    detectedAt,
  });
  const seed = `${customer.stripeCustomerId}:${detectedAt.getTime()}`;
  const outcome =
    forcedOutcome ??
    resolveOutcome(
      category,
      detectedAt,
      now,
      schedule.map((s) => ({ offsetHours: (s.scheduledAt.getTime() - detectedAt.getTime()) / HOUR_MS })),
      seed,
    );

  const steps: RecoveryStepInsert[] = [];
  let stepIdSeq = 0;
  const nextStepId = () => `dstep_${idSeq}_${stepIdSeq++}`;

  let status: "active" | "recovered" | "failed_unrecovered";
  let resolvedAt: Date | null = null;

  if (outcome.kind === "recovered") {
    status = "recovered";
    resolvedAt = outcome.recoveredAt;
    for (const planned of schedule) {
      const stepId = nextStepId();
      if (planned.scheduledAt.getTime() < outcome.recoveredAt.getTime()) {
        // Executed before recovery: an unsuccessful attempt.
        const stepSeed = `${seed}:${planned.stepNumber}`;
        if (isRetryStep(planned.stepType)) {
          steps.push({
            id: stepId,
            failedPaymentId,
            accountId,
            stepType: planned.stepType,
            stepNumber: planned.stepNumber,
            scheduledAt: planned.scheduledAt,
            executedAt: planned.scheduledAt,
            result: "retry_failed",
            attemptCount: 1,
          });
        } else {
          const { openedAt, clickedAt } = simulateOpenClick(stepSeed);
          steps.push({
            id: stepId,
            failedPaymentId,
            accountId,
            stepType: planned.stepType,
            stepNumber: planned.stepNumber,
            scheduledAt: planned.scheduledAt,
            executedAt: planned.scheduledAt,
            result: "email_sent",
            openedAt: openedAt ? new Date(planned.scheduledAt.getTime() + 2 * HOUR_MS) : null,
            clickedAt: clickedAt ? new Date(planned.scheduledAt.getTime() + 3 * HOUR_MS) : null,
            attemptCount: 1,
          });
        }
        continue;
      }
      // This is the causing step: recovery lands here, then the sequence stops.
      const isRetry = isRetryStep(planned.stepType);
      const isEmail = isEmailStep(planned.stepType);
      if (outcome.causeMode === "retry" && isRetry) {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: outcome.recoveredAt,
          result: "retry_succeeded",
          attemptCount: 1,
        });
      } else if (outcome.causeMode === "click" && isEmail) {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: outcome.recoveredAt,
          result: "email_sent",
          openedAt: new Date(outcome.recoveredAt.getTime() - HOUR_MS),
          clickedAt: new Date(outcome.recoveredAt.getTime() - 30 * 60_000),
          attemptCount: 1,
        });
      } else if (isRetry) {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: outcome.recoveredAt,
          result: "retry_failed",
          attemptCount: 1,
        });
      } else {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: outcome.recoveredAt,
          result: "email_sent",
          attemptCount: 1,
        });
      }
      break; // recovered: the sequence ends here, later steps never ran.
    }
  } else if (outcome.kind === "failed_unrecovered") {
    status = "failed_unrecovered";
    for (const planned of schedule) {
      const stepId = nextStepId();
      const stepSeed = `${seed}:${planned.stepNumber}`;
      if (isRetryStep(planned.stepType)) {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: planned.scheduledAt,
          result: "retry_failed",
          attemptCount: 1,
        });
      } else {
        const { openedAt, clickedAt } = simulateOpenClick(stepSeed);
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: planned.scheduledAt,
          result: "email_sent",
          openedAt: openedAt ? new Date(planned.scheduledAt.getTime() + 2 * HOUR_MS) : null,
          clickedAt: clickedAt ? new Date(planned.scheduledAt.getTime() + 3 * HOUR_MS) : null,
          attemptCount: 1,
        });
      }
    }
  } else {
    status = "active";
    for (const planned of schedule) {
      const stepId = nextStepId();
      if (planned.scheduledAt.getTime() > now.getTime()) {
        // Not due yet: exists (the real intake inserts the whole schedule up
        // front), unexecuted.
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
        });
        continue;
      }
      const stepSeed = `${seed}:${planned.stepNumber}`;
      if (isRetryStep(planned.stepType)) {
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: planned.scheduledAt,
          result: "retry_failed",
          attemptCount: 1,
        });
      } else {
        const { openedAt, clickedAt } = simulateOpenClick(stepSeed);
        steps.push({
          id: stepId,
          failedPaymentId,
          accountId,
          stepType: planned.stepType,
          stepNumber: planned.stepNumber,
          scheduledAt: planned.scheduledAt,
          executedAt: planned.scheduledAt,
          result: "email_sent",
          openedAt: openedAt ? new Date(planned.scheduledAt.getTime() + 2 * HOUR_MS) : null,
          clickedAt: clickedAt ? new Date(planned.scheduledAt.getTime() + 3 * HOUR_MS) : null,
          attemptCount: 1,
        });
      }
    }
  }

  const failedPayment: FailedPaymentInsert = {
    id: failedPaymentId,
    stripeEventId: `dfp_evt_${idSeq}`,
    stripeInvoiceId: `dfp_inv_${idSeq}`,
    stripeCustomerId: customer.stripeCustomerId,
    customerEmail: customer.customerEmail,
    customerName: customer.customerName,
    amountCents,
    currency: "usd",
    declineCode,
    declineCategory: category,
    planName: planNameFor(customer),
    customerSince: customer.customerSince,
    status,
    detectedAt,
    resolvedAt,
    accountId,
    isRenewalNoise,
    customerAgeDays: Math.max(1, Math.round((now.getTime() - customer.customerSince.getTime()) / DAY_MS)),
  };

  let recovered: RecoveredPaymentInsert | null = null;
  if (outcome.kind === "recovered") {
    const signals = findAttributionSignals(
      steps.map((s) => ({
        id: s.id as string,
        stepType: s.stepType,
        result: s.result ?? null,
        clickedAt: s.clickedAt ?? null,
      })),
    );
    const attribution = resolveAttribution(signals);
    const daysToRecover = Math.max(
      0,
      Math.round((outcome.recoveredAt.getTime() - detectedAt.getTime()) / DAY_MS),
    );
    recovered = {
      id: `drp_${idSeq}`,
      failedPaymentId,
      recoveredAt: outcome.recoveredAt,
      amountCents,
      currency: "usd",
      recoveryMethod: attribution.kind === "foxhound_retry" ? "foxhound_retry" : "email_click",
      accountId,
      recoveryStepType: steps[steps.length - 1]?.stepType ?? null,
      daysToRecover,
      attributionKind: attribution.kind,
      attributionRef: attribution.ref,
      attributedAt: attribution.kind === "stripe_baseline" ? null : outcome.recoveredAt,
    };
  }

  return { failedPayment, steps, recovered };
}

// ============================================================================
// Win-back
// ============================================================================

const WINBACK_CANDIDATE_LIMIT = 8;

function buildWinback(
  accountId: string,
  customers: DemoCustomer[],
  now: Date,
): { sequences: WinBackSequenceInsert[]; steps: WinBackStepInsert[] } {
  const eligible = customers
    .filter((c) => c.scripted === null && c.tier !== "hobby" && c.status === "churned" && c.churnedAt !== null)
    .map((c) => ({ c, daysAgoChurned: Math.max(1, Math.floor((now.getTime() - c.churnedAt!.getTime()) / DAY_MS)) }))
    .sort((a, b) => a.daysAgoChurned - b.daysAgoChurned)
    .slice(0, WINBACK_CANDIDATE_LIMIT);

  const sequences: WinBackSequenceInsert[] = [];
  const steps: WinBackStepInsert[] = [];

  eligible.forEach((entry, i) => {
    const { c, daysAgoChurned } = entry;
    const seqId = `dwb_${i}`;
    const canceledAt = c.churnedAt!;
    const planned = planWinbackSteps({ winBackSequenceId: seqId, accountId, canceledAt });
    const seed = `${c.stripeCustomerId}:wb`;
    // Reactivate a third of the recent-enough candidates partway through their
    // sequence; the rest stay active or run out (exhausted), matching the
    // terminal-state machine's real transitions.
    const willReactivate = daysAgoChurned >= WIN_BACK_SCHEDULE[0].offsetHours / 24 && seededInt(`${seed}:react`, 3) === 0;
    const reactivateAfterStep = willReactivate ? 1 + seededInt(`${seed}:step`, planned.length) : null;

    let status: WinbackStatus = "active";
    let resolvedAt: Date | null = null;
    let reactivatedAt: Date | null = null;
    let reactivatedByStepId: string | null = null;

    planned.forEach((step) => {
      const stepId = `dwbstep_${i}_${step.stepNumber}`;
      const due = step.scheduledAt.getTime() <= now.getTime();
      const isReactivatingStep = reactivateAfterStep === step.stepNumber && due;
      if (due) {
        steps.push({
          id: stepId,
          winBackSequenceId: seqId,
          accountId,
          stepNumber: step.stepNumber,
          scheduledAt: step.scheduledAt,
          executedAt: step.scheduledAt,
          result: "email_sent",
          attemptCount: 1,
        });
      } else {
        steps.push({
          id: stepId,
          winBackSequenceId: seqId,
          accountId,
          stepNumber: step.stepNumber,
          scheduledAt: step.scheduledAt,
          attemptCount: 0,
        });
      }
      if (isReactivatingStep) {
        reactivatedAt = step.scheduledAt;
        reactivatedByStepId = stepId;
        resolvedAt = step.scheduledAt;
        status = "reactivated";
      } else if (due && status === "active") {
        status = nextWinbackStatus({
          reactivated: false,
          resolvedElsewhere: false,
          isLastStep: isLastWinbackStep(step.stepNumber),
        });
        if (status === "exhausted") resolvedAt = step.scheduledAt;
      }
    });

    sequences.push({
      id: seqId,
      stripeCustomerId: c.stripeCustomerId,
      stripeSubscriptionId: `dwb_sub_${i}`,
      customerEmail: c.customerEmail,
      customerName: c.customerName,
      planName: planNameFor(c),
      amountCents: monthlyTotalCents(c),
      currency: "usd",
      cancelReason: "voluntary_cancellation",
      status,
      createdAt: canceledAt,
      resolvedAt,
      reactivatedAt,
      reactivatedByStepId,
      accountId,
    });
  });

  return { sequences, steps };
}

// ============================================================================
// Expiring-card alerts
// ============================================================================

const CARD_BRANDS = ["Visa", "Mastercard", "Amex"] as const;
const EXPIRING_ALERT_COUNT = 10;

function buildExpiringCardAlerts(
  accountId: string,
  customers: DemoCustomer[],
  now: Date,
): ExpiringCardAlertInsert[] {
  const pool = customers.filter((c) => c.scripted === null && c.status === "active").slice(0, EXPIRING_ALERT_COUNT);
  return pool.map((c, i) => {
    const seed = `${c.stripeCustomerId}:card`;
    const monthsAhead = seededInt(`${seed}:m`, 3); // 0, 1, or 2 months out
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
    const alreadyAlerted = seededInt(`${seed}:sent`, 3) === 0;
    return {
      id: `dcard_${i}`,
      stripeCustomerId: c.stripeCustomerId,
      customerEmail: c.customerEmail,
      customerName: c.customerName,
      cardBrand: pick(`${seed}:brand`, CARD_BRANDS),
      cardLast4: String(1000 + seededInt(`${seed}:last4`, 9000)),
      expiresMonth: target.getUTCMonth() + 1,
      expiresYear: target.getUTCFullYear(),
      alertSentAt: alreadyAlerted ? new Date(now.getTime() - 3 * DAY_MS) : null,
      createdAt: new Date(now.getTime() - seededInt(`${seed}:age`, 10) * DAY_MS),
      accountId,
    };
  });
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Build the full recovery portfolio for one account: scripted narrative
 * failures placed exactly per their schedule, a day-walk of random failures
 * over the last WALK_DAYS days across every day-walk-eligible customer,
 * win-back sequences for a handful of recent churns, and a spread of
 * expiring-card alerts. Pure: returns plain insert rows.
 */
export function buildRecoverySeed(accountId: string, customers: DemoCustomer[], now: Date): RecoverySeedResult {
  const failedPayments: FailedPaymentInsert[] = [];
  const recoverySteps: RecoveryStepInsert[] = [];
  const recoveredPayments: RecoveredPaymentInsert[] = [];
  let idSeq = 0;

  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY_MS);

  // Scripted narrative failures, placed exactly per their event list.
  for (const c of customers) {
    if (!c.scripted) continue;
    for (const ev of c.scripted.failedPaymentEvents) {
      idSeq++;
      const detectedAt = daysAgo(ev.detectedDaysAgo);
      const seed = `${c.stripeCustomerId}:${ev.detectedDaysAgo}`;
      const declineCode = sampleDeclineCode(seed);
      const forcedOutcome: ResolvedOutcome =
        ev.outcome === "active"
          ? { kind: "active" }
          : ev.outcome === "failed_unrecovered"
            ? { kind: "failed_unrecovered" }
            : {
                kind: "recovered",
                recoveredAt: new Date(detectedAt.getTime() + (ev.daysToRecover ?? 0) * DAY_MS),
                causeMode: ev.declineCategory === "soft" || ev.declineCategory === "network" ? "retry" : "click",
              };
      const built = buildFailure(
        accountId,
        c,
        ev.declineCategory,
        declineCode,
        detectedAt,
        now,
        idSeq,
        ev.isRenewalNoise ?? false,
        forcedOutcome,
      );
      failedPayments.push(built.failedPayment);
      recoverySteps.push(...built.steps);
      if (built.recovered) recoveredPayments.push(built.recovered);
    }
  }

  // Day-walk over every eligible customer.
  const eligible = customers.filter(isDayWalkEligible);
  const recentByCustomer = new Map<string, Date[]>();
  for (let dayAgoVal = WALK_DAYS; dayAgoVal >= 0; dayAgoVal--) {
    const day = daysAgo(dayAgoVal);
    const intensity = classifyDayIntensity(day);
    const dailySeed = `walk:day:${dayAgoVal}`;
    const numFailures = failuresForDay(intensity, dailySeed);
    for (let j = 0; j < numFailures; j++) {
      const pickSeed = `${dailySeed}:${j}`;
      const customer = pickCustomerForDay(eligible, day, pickSeed, recentByCustomer);
      if (!customer) continue;
      const declineCode = sampleDeclineCode(pickSeed);
      const category = classifyDecline(declineCode);
      const detectedAt = randomBusinessHour(day, pickSeed);
      idSeq++;
      const built = buildFailure(accountId, customer, category, declineCode, detectedAt, now, idSeq, false);
      failedPayments.push(built.failedPayment);
      recoverySteps.push(...built.steps);
      if (built.recovered) recoveredPayments.push(built.recovered);
      const arr = recentByCustomer.get(customer.stripeCustomerId) ?? [];
      arr.push(detectedAt);
      recentByCustomer.set(customer.stripeCustomerId, arr);
    }
  }

  const { sequences: winBackSequenceRows, steps: winBackStepRows } = buildWinback(accountId, customers, now);
  const expiringCardAlertRows = buildExpiringCardAlerts(accountId, customers, now);

  return {
    failedPayments,
    recoverySteps,
    recoveredPayments,
    expiringCardAlerts: expiringCardAlertRows,
    winBackSequences: winBackSequenceRows,
    winBackSteps: winBackStepRows,
  };
}
