import type {
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import { DAY_MS, DECLINE_CATEGORIES, HOUR_MS } from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { classifyDecline } from "~/lib/recovery/decline";
import { isEmailStep, isRetryStep, planRecoverySteps, WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import { isLastWinbackStep, nextWinbackStatus, planWinbackSteps, type WinbackStatus } from "~/lib/recovery/winback";

import { TEAMFLOW_DEMO, type DemoBusiness } from "./constants";
import { demoEmailCopyFor, demoWinBackCopyFor } from "./email-copy";
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

const WALK_DAYS = 90;

/** The business a seed is for: its account, the merchant name its emails sign
 *  with, the prefix that keeps its row ids apart from the other business's,
 *  and a salt for the day-walk's rolls so the two businesses do not fail on
 *  the same days. Teamflow's salt is empty, so its data is what it always was. */
interface SeedBusiness {
  accountId: string;
  merchantName: string;
  idPrefix: string;
  walkSalt: string;
}

function seedBusinessFor(business: DemoBusiness): SeedBusiness {
  return {
    accountId: business.accountId,
    merchantName: business.name,
    idPrefix: business.idPrefix,
    walkSalt: business.idPrefix === TEAMFLOW_DEMO.idPrefix ? "" : business.idPrefix,
  };
}

export type FailedPaymentInsert = typeof failedPayments.$inferInsert;
type RecoveryStepInsert = typeof recoverySteps.$inferInsert;
export type RecoveredPaymentInsert = typeof recoveredPayments.$inferInsert;
type ExpiringCardAlertInsert = typeof expiringCardAlerts.$inferInsert;
type WinBackSequenceInsert = typeof winBackSequences.$inferInsert;
type WinBackStepInsert = typeof winBackSteps.$inferInsert;

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
// seeded code/category pair can never drift out of sync with decline.ts).
// Every code list here is a subset of decline.ts's own set for that category,
// so classifyDecline(code) always lands back on the category it was sampled
// for - both here (the weighted day-walk roll) and via sampleDeclineCodeFor-
// Category (the scripted narrative's category is already fixed by the event,
// so the code must be sampled FROM that category, never independently).
// ============================================================================

const SOFT_CODES = ["insufficient_funds", "do_not_honor", "generic_decline"] as const;
const EXPIRED_CODES = ["expired_card"] as const;
const NETWORK_CODES = ["processing_error", "issuer_not_available", "try_again_later"] as const;
const FRAUD_CODES = ["fraudulent", "lost_card", "stolen_card"] as const;
const REVOKED_CODES = ["revocation_of_authorization"] as const;
// Not present in any of decline.ts's category sets, so classifyDecline fails
// closed to "unknown" - this is the only way to seed an "unknown" row without
// lying about a code that actually belongs to a known category.
const UNKNOWN_CODES = ["unrecognized_decline"] as const;

const CODES_BY_CATEGORY: Record<DeclineCategory, readonly string[]> = {
  soft: SOFT_CODES,
  network: NETWORK_CODES,
  expired: EXPIRED_CODES,
  fraud: FRAUD_CODES,
  revoked: REVOKED_CODES,
  unknown: UNKNOWN_CODES,
};

function sampleDeclineCodeForCategory(seed: string, category: DeclineCategory): string {
  return pick(`${seed}:code`, CODES_BY_CATEGORY[category]);
}

// The category mix for a day-walk failure. Legacy rolled only four categories
// (50 soft / 20 expired / 20 network / 10 fraud) because those were the only
// four it had. Foxhound's engine classifies six, and RECOVERY_SCHEDULES,
// DECLINE_CATEGORY_LABELS, and /recovery/sequence all ship a section for each,
// so leaving revoked and unknown at zero left two panels reading "No data yet"
// on every demo visit: the fail-closed classifier and the revoked hard-stop, two
// deliberate engine behaviors, had no visible evidence anywhere.
//
// Both stay rare, because they are rare in reality: a withdrawn authorization
// and a decline code Stripe does not document are each a few percent of
// failures, not a fifth. At the day-walk's volume that is a handful of rows,
// which is enough to populate the section honestly without distorting the
// headline category mix.
const CATEGORY_WEIGHTS: { category: DeclineCategory; upTo: number }[] = [
  { category: "soft", upTo: 46 },
  { category: "expired", upTo: 64 },
  { category: "network", upTo: 82 },
  { category: "fraud", upTo: 92 },
  { category: "revoked", upTo: 96 },
  { category: "unknown", upTo: 100 },
];

function sampleDeclineCode(seed: string): string {
  const r = seededInt(`${seed}:cat`, 100);
  const hit = CATEGORY_WEIGHTS.find((w) => r < w.upTo) ?? CATEGORY_WEIGHTS[0];
  return sampleDeclineCodeForCategory(seed, hit.category);
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
  biz: SeedBusiness,
  customer: DemoCustomer,
  category: DeclineCategory,
  declineCode: string,
  detectedAt: Date,
  now: Date,
  idSeq: number,
  isRenewalNoise: boolean,
  forcedOutcome?: ResolvedOutcome,
): BuiltFailure {
  const { accountId, idPrefix: p } = biz;
  const failedPaymentId = `${p}fp_${idSeq}`;
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
  type Planned = (typeof schedule)[number];
  const stepFor = (planned: Planned): RecoveryStepInsert => ({
    id: `${p}step_${idSeq}_${stepIdSeq++}`,
    failedPaymentId,
    accountId,
    stepType: planned.stepType,
    stepNumber: planned.stepNumber,
    scheduledAt: planned.scheduledAt,
  });
  // A step that ran on schedule and did not recover the payment: a failed retry, or
  // an email the customer may have opened or clicked.
  const ranWithoutRecovery = (planned: Planned): RecoveryStepInsert => {
    const ran = { ...stepFor(planned), executedAt: planned.scheduledAt, attemptCount: 1 };
    if (isRetryStep(planned.stepType)) return { ...ran, result: "retry_failed" };
    const { openedAt, clickedAt } = simulateOpenClick(`${seed}:${planned.stepNumber}`);
    return {
      ...ran,
      result: "email_sent",
      openedAt: openedAt ? new Date(planned.scheduledAt.getTime() + 2 * HOUR_MS) : null,
      clickedAt: clickedAt ? new Date(planned.scheduledAt.getTime() + 3 * HOUR_MS) : null,
    };
  };

  let status: "active" | "recovered" | "failed_unrecovered";
  let resolvedAt: Date | null = null;

  if (outcome.kind === "recovered") {
    status = "recovered";
    resolvedAt = outcome.recoveredAt;
    for (const planned of schedule) {
      if (planned.scheduledAt.getTime() < outcome.recoveredAt.getTime()) {
        // Executed before recovery: an unsuccessful attempt.
        steps.push(ranWithoutRecovery(planned));
        continue;
      }
      // This is the causing step: recovery lands here, then the sequence stops.
      const ran = { ...stepFor(planned), executedAt: outcome.recoveredAt, attemptCount: 1 };
      const isRetry = isRetryStep(planned.stepType);
      if (outcome.causeMode === "retry" && isRetry) {
        steps.push({ ...ran, result: "retry_succeeded" });
      } else if (outcome.causeMode === "click" && isEmailStep(planned.stepType)) {
        steps.push({
          ...ran,
          result: "email_sent",
          openedAt: new Date(outcome.recoveredAt.getTime() - HOUR_MS),
          clickedAt: new Date(outcome.recoveredAt.getTime() - 30 * 60_000),
        });
      } else {
        steps.push({ ...ran, result: isRetry ? "retry_failed" : "email_sent" });
      }
      break; // recovered: the sequence ends here, later steps never ran.
    }
  } else if (outcome.kind === "failed_unrecovered") {
    status = "failed_unrecovered";
    for (const planned of schedule) steps.push(ranWithoutRecovery(planned));
  } else {
    status = "active";
    for (const planned of schedule) {
      // Not due yet: exists (the real intake inserts the whole schedule up
      // front), unexecuted.
      steps.push(planned.scheduledAt.getTime() > now.getTime() ? stepFor(planned) : ranWithoutRecovery(planned));
    }
  }

  // Attach the pre-written subject/body to every email step in one pass rather
  // than at each push site above, so a new branch cannot silently
  // ship a body-less email step. Unexecuted future steps get copy too: the real
  // intake writes the whole schedule up front, and a merchant previewing a
  // pending step should still see what is queued to go out.
  const emailContext = {
    customerName: customer.customerName,
    amountCents,
    currency: "usd",
    planName: planNameFor(customer),
    merchantName: biz.merchantName,
  };
  for (const step of steps) {
    if (!isEmailStep(step.stepType)) continue;
    const copy = demoEmailCopyFor(category, step.stepType, emailContext);
    if (!copy) continue;
    step.aiSubject = copy.subject;
    step.aiBodyHtml = copy.bodyHtml;
  }

  const failedPayment: FailedPaymentInsert = {
    id: failedPaymentId,
    stripeEventId: `${p}fp_evt_${idSeq}`,
    stripeInvoiceId: `${p}fp_inv_${idSeq}`,
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
      outcome.recoveredAt,
    );
    const attribution = resolveAttribution(signals);
    const daysToRecover = Math.max(
      0,
      Math.round((outcome.recoveredAt.getTime() - detectedAt.getTime()) / DAY_MS),
    );
    recovered = {
      id: `${p}rp_${idSeq}`,
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
      // attribution.ref IS the credited recovery_steps.id for every non-baseline
      // kind (attribution.ts: "all three refs point at recovery_steps.id") - the
      // real webhook path (record-recovery.ts) copies the same value here, so the
      // seed must too, or every step-performance read (recovered_by_step_id) sees
      // an attributed recovery with no step credited.
      recoveredByStepId: attribution.kind === "stripe_baseline" ? null : attribution.ref,
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
  biz: SeedBusiness,
  customers: DemoCustomer[],
  now: Date,
): { sequences: WinBackSequenceInsert[]; steps: WinBackStepInsert[] } {
  const eligible = customers
    .filter((c) => c.scripted === null && c.tier !== "hobby" && c.status === "churned" && c.churnedAt !== null)
    .map((c) => ({ c, daysAgoChurned: Math.max(1, Math.floor((now.getTime() - c.churnedAt!.getTime()) / DAY_MS)) }))
    .sort((a, b) => a.daysAgoChurned - b.daysAgoChurned)
    .slice(0, WINBACK_CANDIDATE_LIMIT);

  const { accountId, idPrefix: p } = biz;
  const sequences: WinBackSequenceInsert[] = [];
  const steps: WinBackStepInsert[] = [];

  eligible.forEach((entry, i) => {
    const { c, daysAgoChurned } = entry;
    const seqId = `${p}wb_${i}`;
    const canceledAt = c.churnedAt!;
    const planned = planWinbackSteps({ winBackSequenceId: seqId, accountId, canceledAt });
    const seed = `${c.stripeCustomerId}:wb`;
    // Reactivation only rolls for a candidate whose full schedule COULD have
    // already run its course; a customer who churned within the schedule's
    // own span always reads as a genuinely in-flight "active" sequence, never
    // a coin-flip win. Without this gate, the demo could show zero active
    // win-backs on a given day purely by chance, even with a currently-
    // churning customer in the pool (the surface Recovery's overview card
    // points to would then look empty despite the feature working).
    const scheduleSpanDays = WIN_BACK_SCHEDULE[WIN_BACK_SCHEDULE.length - 1].offsetHours / 24;
    const willReactivate = daysAgoChurned >= scheduleSpanDays && seededInt(`${seed}:react`, 3) === 0;
    const reactivateAfterStep = willReactivate ? 1 + seededInt(`${seed}:step`, planned.length) : null;

    let status: WinbackStatus = "active";
    let resolvedAt: Date | null = null;
    let reactivatedAt: Date | null = null;
    let reactivatedByStepId: string | null = null;

    const winBackContext = {
      customerName: c.customerName,
      amountCents: monthlyTotalCents(c),
      currency: "usd",
      planName: planNameFor(c),
      merchantName: biz.merchantName,
    };

    planned.forEach((step) => {
      const stepId = `${p}wbstep_${i}_${step.stepNumber}`;
      const due = step.scheduledAt.getTime() <= now.getTime();
      const isReactivatingStep = reactivateAfterStep === step.stepNumber && due;
      const copy = demoWinBackCopyFor(step.stepNumber, winBackContext);
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
          aiSubject: copy?.subject ?? null,
          aiBodyHtml: copy?.bodyHtml ?? null,
        });
      } else {
        steps.push({
          id: stepId,
          winBackSequenceId: seqId,
          accountId,
          stepNumber: step.stepNumber,
          scheduledAt: step.scheduledAt,
          attemptCount: 0,
          aiSubject: copy?.subject ?? null,
          aiBodyHtml: copy?.bodyHtml ?? null,
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
      stripeSubscriptionId: `${p}wb_sub_${i}`,
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
  biz: SeedBusiness,
  customers: DemoCustomer[],
  now: Date,
): ExpiringCardAlertInsert[] {
  const { accountId, idPrefix: p } = biz;
  // A free (Hobby) customer has no card on file to expire.
  const pool = customers
    .filter((c) => c.scripted === null && c.status === "active" && c.tier !== "hobby")
    .slice(0, EXPIRING_ALERT_COUNT);
  return pool.map((c, i) => {
    const seed = `${c.stripeCustomerId}:card`;
    const monthsAhead = seededInt(`${seed}:m`, 3); // 0, 1, or 2 months out
    const target = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + monthsAhead, 1));
    const alreadyAlerted = seededInt(`${seed}:sent`, 3) === 0;
    return {
      id: `${p}card_${i}`,
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
export function buildRecoverySeed(
  accountId: string,
  customers: DemoCustomer[],
  now: Date,
  business: DemoBusiness = TEAMFLOW_DEMO,
): RecoverySeedResult {
  const biz = { ...seedBusinessFor(business), accountId };
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
      const declineCode = sampleDeclineCodeForCategory(seed, ev.declineCategory);
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
        biz,
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
    const dailySeed = `${biz.walkSalt}walk:day:${dayAgoVal}`;
    const numFailures = failuresForDay(intensity, dailySeed);
    for (let j = 0; j < numFailures; j++) {
      const pickSeed = `${dailySeed}:${j}`;
      const customer = pickCustomerForDay(eligible, day, pickSeed, recentByCustomer);
      if (!customer) continue;
      const declineCode = sampleDeclineCode(pickSeed);
      const category = classifyDecline(declineCode);
      const detectedAt = randomBusinessHour(day, pickSeed);
      idSeq++;
      const built = buildFailure(biz, customer, category, declineCode, detectedAt, now, idSeq, false);
      failedPayments.push(built.failedPayment);
      recoverySteps.push(...built.steps);
      if (built.recovered) recoveredPayments.push(built.recovered);
      const arr = recentByCustomer.get(customer.stripeCustomerId) ?? [];
      arr.push(detectedAt);
      recentByCustomer.set(customer.stripeCustomerId, arr);
    }
  }

  // Coverage top-up. The weighted roll leaves a rare category (revoked and
  // unknown sit at 4% each) with zero rows on a meaningful fraction of dates: a
  // 30-day sweep found `revoked` absent on 11 of 30. A category with zero rows
  // renders its whole /recovery/sequence section as "No data yet", so on those
  // days the fail-closed classifier and the revoked hard-stop have no visible
  // evidence anywhere in the demo. Demo coverage of a shipped panel should not
  // be left to a dice roll, so place one failure for any category the walk
  // missed. Same reasoning as the guaranteed currently-active win-back.
  //
  // Deliberately AFTER the walk and additive: it does not perturb the walk's own
  // distribution, and on a date where the roll already covered everything this
  // loop places nothing at all.
  const placedCategories = new Set(failedPayments.map((f) => f.declineCategory));
  let topUpIndex = 0;
  for (const category of DECLINE_CATEGORIES) {
    if (placedCategories.has(category)) continue;
    // Spread the top-ups across distinct days so two missing categories never
    // land on the same date, and keep them old enough that the sequence has
    // actually executed rather than sitting entirely in the future.
    const dayAgoVal = Math.min(WALK_DAYS, 10 + topUpIndex * 3);
    topUpIndex++;
    const day = daysAgo(dayAgoVal);
    const pickSeed = `${biz.walkSalt}walk:topup:${category}`;
    const customer =
      pickCustomerForDay(eligible, day, pickSeed, recentByCustomer) ?? eligible[0];
    if (!customer) continue;
    const declineCode = sampleDeclineCodeForCategory(pickSeed, category);
    const detectedAt = randomBusinessHour(day, pickSeed);
    idSeq++;
    const built = buildFailure(biz, customer, category, declineCode, detectedAt, now, idSeq, false);
    failedPayments.push(built.failedPayment);
    recoverySteps.push(...built.steps);
    if (built.recovered) recoveredPayments.push(built.recovered);
    const arr = recentByCustomer.get(customer.stripeCustomerId) ?? [];
    arr.push(detectedAt);
    recentByCustomer.set(customer.stripeCustomerId, arr);
  }

  const { sequences: winBackSequenceRows, steps: winBackStepRows } = buildWinback(biz, customers, now);
  const expiringCardAlertRows = buildExpiringCardAlerts(biz, customers, now);

  return {
    failedPayments,
    recoverySteps,
    recoveredPayments,
    expiringCardAlerts: expiringCardAlertRows,
    winBackSequences: winBackSequenceRows,
    winBackSteps: winBackStepRows,
  };
}
