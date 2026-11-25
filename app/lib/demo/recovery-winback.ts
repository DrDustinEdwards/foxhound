import { DAY_MS } from "~/lib/constants";
import { WIN_BACK_SCHEDULE } from "~/lib/recovery/schedule";
import {
  isLastWinbackStep,
  nextWinbackStatus,
  planWinbackSteps,
  type WinbackStatus,
} from "~/lib/recovery/winback";
import { demoWinBackCopyFor } from "./email-copy";
import {
  monthlyTotalCents,
  planNameFor,
  pick,
  seededInt,
  type DemoCustomer,
} from "./customer-base";
import type {
  ExpiringCardAlertInsert,
  SeedBusiness,
  WinBackSequenceInsert,
  WinBackStepInsert,
} from "./recovery-seed";

const WINBACK_CANDIDATE_LIMIT = 8;

export function buildWinback(
  biz: SeedBusiness,
  customers: DemoCustomer[],
  now: Date,
): { sequences: WinBackSequenceInsert[]; steps: WinBackStepInsert[] } {
  const eligible = customers
    .filter(
      (c) =>
        c.scripted === null && c.tier !== "hobby" && c.status === "churned" && c.churnedAt !== null,
    )
    .map((c) => ({
      c,
      daysAgoChurned: Math.max(1, Math.floor((now.getTime() - c.churnedAt!.getTime()) / DAY_MS)),
    }))
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
    // already run its course; a customer who churned within the schedule's own
    // span always reads as a genuinely in-flight "active" sequence, never a
    // coin-flip win. Without this gate, the demo could show zero active
    // win-backs on a given day purely by chance, even with a currently-
    // churning customer in the pool (the surface Recovery's overview card
    // points to would then look empty despite the feature working).
    const scheduleSpanDays = WIN_BACK_SCHEDULE[WIN_BACK_SCHEDULE.length - 1].offsetHours / 24;
    const willReactivate =
      daysAgoChurned >= scheduleSpanDays && seededInt(`${seed}:react`, 3) === 0;
    const reactivateAfterStep = willReactivate
      ? 1 + seededInt(`${seed}:step`, planned.length)
      : null;

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

const CARD_BRANDS = ["Visa", "Mastercard", "Amex"] as const;
const EXPIRING_ALERT_COUNT = 10;

export function buildExpiringCardAlerts(
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
