import { findAttributionSignals, resolveAttribution } from "~/lib/recovery/attribution";
import { DAY_MS, HOUR_MS } from "~/lib/constants";
import type { DeclineCategory } from "~/lib/constants";
import { isEmailStep, isRetryStep, planRecoverySteps } from "~/lib/recovery/schedule";
import { demoEmailCopyFor } from "./email-copy";
import { invoiceAmountCents, planNameFor, seededInt, type DemoCustomer } from "./customer-base";
import type {
  FailedPaymentInsert,
  RecoveredPaymentInsert,
  RecoveryStepInsert,
  SeedBusiness,
} from "./recovery-seed";
import { type ResolvedOutcome, resolveOutcome } from "./recovery-sampling";

// Per-failure row builder: turns one (customer, category, detectedAt, outcome)
// into a failedPayments row + its full recoverySteps timeline + an optional
// recoveredPayments row, via the REAL schedule + REAL attribution model.

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

function demoStripeFeeCents(amountCents: number): number {
  return Math.round(amountCents * 0.029) + 30;
}

export function buildFailure(
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
      schedule.map((s) => ({
        offsetHours: (s.scheduledAt.getTime() - detectedAt.getTime()) / HOUR_MS,
      })),
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
  // A step that ran on schedule and did not recover the payment: a failed
  // retry, or an email the customer may have opened or clicked.
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
      steps.push(
        planned.scheduledAt.getTime() > now.getTime()
          ? stepFor(planned)
          : ranWithoutRecovery(planned),
      );
    }
  }

  // Attach the pre-written subject/body to every email step in one pass rather
  // than at each push site above, so a new branch cannot silently ship a
  // body-less email step. Unexecuted future steps get copy too: the real intake
  // writes the whole schedule up front, and a merchant previewing a pending
  // step should still see what is queued to go out.
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
    customerAgeDays: Math.max(
      1,
      Math.round((now.getTime() - customer.customerSince.getTime()) / DAY_MS),
    ),
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
      // attribution.ref IS the credited recovery_steps.id for every
      // non-baseline kind (attribution.ts: "all three refs point at
      // recovery_steps.id") - the real webhook path (record-recovery.ts) copies
      // the same value here, so the seed must too, or every step-performance
      // read (recovered_by_step_id) sees an attributed recovery with no step
      // credited.
      recoveredByStepId: attribution.kind === "stripe_baseline" ? null : attribution.ref,
      attributedAt: attribution.kind === "stripe_baseline" ? null : outcome.recoveredAt,
      // Stripe's standard US card fee, 2.9% + 30 cents, as the webhook would
      // read it off the charge's balance transaction.
      stripeBalanceTransactionId: `${p}txn_${idSeq}`,
      stripeFeeCents: demoStripeFeeCents(amountCents),
      netAmountCents: amountCents - demoStripeFeeCents(amountCents),
      netCurrency: "usd",
    };
  }

  return { failedPayment, steps, recovered };
}
