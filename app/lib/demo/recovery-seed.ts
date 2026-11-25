import type {
  expiringCardAlerts,
  failedPayments,
  recoveredPayments,
  recoverySteps,
  winBackSequences,
  winBackSteps,
} from "~/db";
import { DAY_MS, DECLINE_CATEGORIES } from "~/lib/constants";
import { classifyDecline } from "~/lib/recovery/decline";
import { TEAMFLOW_DEMO, type DemoBusiness } from "./constants";
import { isDayWalkEligible, daysAgo, type DemoCustomer } from "./customer-base";
import {
  type ResolvedOutcome,
  classifyDayIntensity,
  failuresForDay,
  pickCustomerForDay,
  randomBusinessHour,
  sampleDeclineCode,
  sampleDeclineCodeForCategory,
} from "./recovery-sampling";
import { buildFailure } from "./recovery-failure";
import { buildExpiringCardAlerts, buildWinback } from "./recovery-winback";

// Recovery seed: the day-walk
// failed-payment simulator + win-back + expiring-card alerts. Pure: returns
// plain insert-row arrays, no DB access, no I/O; app/lib/demo/seed.ts turns
// these into db.insert(...) batches.

const WALK_DAYS = 90;

/**
 * The business a seed is for: its account, the merchant name its emails sign
 * with, the prefix that keeps its row ids apart from the other business's, and
 * a salt for the day-walk's rolls so the two businesses do not fail on the same
 * days. Teamflow's salt is empty, so its data is what it always was.
 */
export interface SeedBusiness {
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

  // Scripted narrative failures, placed exactly per their event list.
  for (const c of customers) {
    if (!c.scripted) continue;
    for (const ev of c.scripted.failedPaymentEvents) {
      idSeq++;
      const detectedAt = daysAgo(now, ev.detectedDaysAgo);
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
                causeMode:
                  ev.declineCategory === "soft" || ev.declineCategory === "network"
                    ? "retry"
                    : "click",
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
    const day = daysAgo(now, dayAgoVal);
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
      const built = buildFailure(
        biz,
        customer,
        category,
        declineCode,
        detectedAt,
        now,
        idSeq,
        false,
      );
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
  // 30-day sweep found `revoked` absent on 11 of 30.
  const placedCategories = new Set(failedPayments.map((f) => f.declineCategory));
  let topUpIndex = 0;
  for (const category of DECLINE_CATEGORIES) {
    if (placedCategories.has(category)) continue;
    // Spread the top-ups across distinct days so two missing categories never
    // land on the same date, and keep them old enough that the sequence has
    // actually executed rather than sitting entirely in the future.
    const dayAgoVal = Math.min(WALK_DAYS, 10 + topUpIndex * 3);
    topUpIndex++;
    const day = daysAgo(now, dayAgoVal);
    const pickSeed = `${biz.walkSalt}walk:topup:${category}`;
    const customer = pickCustomerForDay(eligible, day, pickSeed, recentByCustomer) ?? eligible[0];
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

  const { sequences: winBackSequenceRows, steps: winBackStepRows } = buildWinback(
    biz,
    customers,
    now,
  );
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
