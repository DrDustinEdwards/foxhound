import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type Stripe from "stripe";
import { describe, expect, it } from "vitest";

import { MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY } from "~/lib/constants";
import {
  buildCardUpdaterAdvisory,
  extractDeclineCode,
  monthlyPlanCents,
  runAudit,
  type AuditInputs,
  type ScopeOutcome,
} from "~/lib/audit/engine";

// SESSION 68, PHASE (a): the pure audit engine.
//
// THE SPEC IS parity/ENGINE-AUDIT.md's walk, and every predicate below is
// legacy's own, read from `lib/audit-engine.ts` blob `040912f8`. Where Foxhound
// diverges there is a ruling and the plant says which.
//
// PLANTS SIT AT THE PREDICATE EDGES, not on a happy path. A fixture fed one
// clean input proves the function and not the property, so every scope carries
// the case just inside and just outside its rule.

const RAN_AT = new Date("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;
const secondsAt = (msAgo: number) => Math.floor((RAN_AT.getTime() - msAgo) / 1000);

const ok = <T>(data: T[]): ScopeOutcome<T[]> => ({ ok: true, data });
const failed = (reason: string): ScopeOutcome<never[]> => ({ ok: false, reason });

function reads(over: Partial<AuditInputs> = {}): AuditInputs {
  return {
    uncollectibleInvoices: ok<Stripe.Invoice>([]),
    openInvoices: ok<Stripe.Invoice>([]),
    subscriptions: ok<Stripe.Subscription>([]),
    disputes: ok<Stripe.Dispute>([]),
    cardUpdaterEvents: ok<Stripe.Event>([]),
    ...over,
  };
}

function audit(over: Partial<AuditInputs> = {}, lookbackDays = 90) {
  return runAudit({
    stripeAccountId: "acct_walked",
    lookbackDays,
    ranAt: RAN_AT,
    reads: reads(over),
  });
}

/** A fixture invoice. Typed loosely on purpose: Stripe's `LastFinalizationError`
 *  requires a `type` these fixtures do not need, and widening the fixture is
 *  honest where widening the ENGINE's own types would not be. */
const invoice = (o: Record<string, unknown>) =>
  ({ amount_due: 0, currency: "usd", ...o }) as unknown as Stripe.Invoice;

const subscription = (o: Record<string, unknown>) =>
  ({ status: "active", currency: "usd", ...o }) as unknown as Stripe.Subscription;

const price = (unitAmount: number, interval: string, intervalCount = 1) => ({
  items: { data: [{ price: { unit_amount: unitAmount, recurring: { interval, interval_count: intervalCount } } }] },
});

const card = (expMonth: number, expYear: number) => ({
  default_payment_method: { card: { exp_month: expMonth, exp_year: expYear } },
});

const dispute = (o: Record<string, unknown>) =>
  ({ amount: 0, currency: "usd", ...o }) as unknown as Stripe.Dispute;

/** Narrow a scope to its data, failing the test with the reason if it did not. */
function data<T>(scope: ScopeOutcome<T>): T {
  if (!scope.ok) throw new Error(`scope failed: ${scope.reason}`);
  return scope.data;
}

describe("SCOPE 1: failed invoices", () => {
  it("takes every uncollectible, and ONLY the open invoices whose due date has passed", () => {
    // The edge both ways: one open invoice a day overdue and one due tomorrow.
    const result = audit({
      uncollectibleInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 1_000 })]),
      openInvoices: ok<Stripe.Invoice>([
        invoice({ amount_due: 2_000, due_date: secondsAt(DAY) }),
        invoice({ amount_due: 4_000, due_date: secondsAt(-DAY) }),
      ]),
    });
    expect(data(result.failedInvoices).count).toBe(2);
    expect(data(result.failedInvoices).totalCents).toBe(3_000);
  });

  it("an open invoice with NO due date is not overdue, which a truthy check would get wrong", () => {
    const result = audit({
      openInvoices: ok<Stripe.Invoice>([invoice({ amount_due: 9_000, due_date: null })]),
    });
    expect(data(result.failedInvoices).count).toBe(0);
  });

  it("the decline-code fallback chain runs in legacy's order", () => {
    expect(extractDeclineCode(invoice({ last_finalization_error: { decline_code: "a" }, last_payment_error: { code: "b" } }))).toBe("a");
    expect(extractDeclineCode(invoice({ last_payment_error: { code: "b" }, charge: { failure_code: "c" } }))).toBe("b");
    expect(extractDeclineCode(invoice({ charge: { failure_code: "c" } }))).toBe("c");
    // A charge that is still an id string carries no failure code.
    expect(extractDeclineCode(invoice({ charge: "ch_1" }))).toBeNull();
  });
});

describe("SCOPE 2: expiring cards", () => {
  it("counts this month and next month, and NOT the month after", () => {
    // August 2026. September is next month and counts; October does not.
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(1_000, "month") }),
        subscription({ customer: "cus_b", ...card(9, 2026), ...price(2_000, "month") }),
        subscription({ customer: "cus_c", ...card(10, 2026), ...price(4_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(2);
    expect(data(result.expiringCards).mrrAtRiskCents).toBe(3_000);
  });

  it("AN ALREADY-EXPIRED CARD COUNTS, which is the opposite of the expiring-card cron", () => {
    // Both are right. The cron skips them because an alert about a card that has
    // already failed is late; the audit counts them because a
    // diagnostic of what is wrong now must include them.
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_old", ...card(1, 2024), ...price(5_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(1);
  });

  it("dedupes by customer, so two subscriptions on one card count once", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(1_000, "month") }),
        subscription({ customer: "cus_a", ...card(8, 2026), ...price(9_000, "month") }),
      ]),
    });
    expect(data(result.expiringCards).count).toBe(1);
    // The FIRST subscription's amount, because the second never reaches the sum.
    expect(data(result.expiringCards).mrrAtRiskCents).toBe(1_000);
  });

  it("the timeline is FOUR months wide and collapses the past into this month", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ customer: "cus_past", ...card(2, 2024), ...price(100, "month") }),
        subscription({ customer: "cus_now", ...card(8, 2026), ...price(100, "month") }),
        subscription({ customer: "cus_3", ...card(11, 2026), ...price(100, "month") }),
        subscription({ customer: "cus_4", ...card(12, 2026), ...price(100, "month") }),
      ]),
    });
    const months = data(result.expiringCards).expiresByMonth;
    // Past and current collapse together; November is the last bucket inside the
    // four-month window and December falls outside it.
    expect(months["2026-08"]).toBe(2);
    expect(months["2026-11"]).toBe(1);
    expect(months["2026-12"]).toBeUndefined();
  });

  it("normalizes every recurring interval to monthly cents", () => {
    expect(monthlyPlanCents(subscription(price(1_200_00, "year")) as Stripe.Subscription)).toBe(10_000);
    expect(monthlyPlanCents(subscription(price(100, "day")) as Stripe.Subscription)).toBe(3_000);
    expect(monthlyPlanCents(subscription(price(100, "week")) as Stripe.Subscription)).toBe(400);
    expect(monthlyPlanCents(subscription(price(500, "month", 2)) as Stripe.Subscription)).toBe(250);
  });
});

describe("SCOPE 3: past-due subscriptions", () => {
  it("counts past_due only, at the RAW unit amount with no monthly normalization", () => {
    // Legacy's own choice and its own comment: this is the next cycle's value,
    // so a render calls it subscription value and never MRR. A yearly plan of
    // 1200.00 contributes 1200.00 here and 100.00 to MRR.
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "past_due", customer: "cus_a", ...price(1_200_00, "year") }),
        subscription({ status: "active", customer: "cus_b", ...price(1_200_00, "year") }),
      ]),
    });
    expect(data(result.pastDueSubscriptions)).toMatchObject({ count: 1, totalCents: 1_200_00 });
    expect(data(result.health).mrrCents).toBe(10_000);
  });
});

describe("SCOPE 4: the Card Updater advisory", () => {
  it("fires only when zero events AND the declines clear the threshold", () => {
    expect(buildCardUpdaterAdvisory(1, 99)).toBeNull();
    expect(buildCardUpdaterAdvisory(0, MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY - 1)).toBeNull();
    expect(buildCardUpdaterAdvisory(0, MIN_EXPIRED_DECLINES_FOR_CAU_ADVISORY)).toContain(
      "Stripe Account Updater is not firing",
    );
  });

  it("COUNTS ITS DENOMINATOR INSIDE THE 30-DAY WINDOW, not the 90-day lookback", () => {
    // The asymmetry legacy documents: Stripe retains events for 30 days, so a
    // 90-day decline count against a 30-day event count would inflate the
    // trigger. One decline is 10 days old and three are 60 days old.
    const expired = { last_finalization_error: { decline_code: "expired_card" } };
    const result = audit({
      uncollectibleInvoices: ok<Stripe.Invoice>([
        invoice({ amount_due: 1, created: secondsAt(10 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(60 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(61 * DAY), ...expired }),
        invoice({ amount_due: 1, created: secondsAt(62 * DAY), ...expired }),
      ]),
    });
    expect(data(result.cardUpdater).expiredCardDeclinesInWindow).toBe(1);
    expect(data(result.cardUpdater).windowDays).toBe(30);
    // One decline is below the threshold, so no advisory even though the count
    // over the full lookback would have cleared it.
    expect(data(result.cardUpdater).advisory).toBeNull();
  });
});

describe("SCOPE 5: disputes", () => {
  it("open is needs_response or under_review, and accepted is LOST WITH ZERO SUBMISSIONS", () => {
    // The submission count is what separates a dispute somebody fought and lost
    // from one nobody answered, and only the second is a process failure.
    const result = audit({
      disputes: ok<Stripe.Dispute>([
        dispute({ status: "needs_response", amount: 100 }),
        dispute({ status: "under_review", amount: 200 }),
        dispute({ status: "lost", amount: 400, evidence_details: { submission_count: 0 } }),
        dispute({ status: "lost", amount: 800, evidence_details: { submission_count: 1 } }),
        dispute({ status: "won", amount: 1_600 }),
      ]),
    });
    const scope = data(result.disputes);
    expect(scope.open).toMatchObject({ count: 2, totalCents: 300 });
    expect(scope.acceptedWithoutFighting).toMatchObject({ count: 1, totalCents: 400 });
    expect(scope.historical).toEqual({ won: 1, lost: 2 });
  });
});

describe("SCOPE 6: health", () => {
  it("MRR from active subs, ARR twelve times it, and churn in basis points", () => {
    const result = audit({
      subscriptions: ok<Stripe.Subscription>([
        subscription({ status: "active", customer: "a", ...price(10_000, "month") }),
        subscription({ status: "past_due", customer: "b", ...price(10_000, "month") }),
        subscription({
          status: "canceled",
          customer: "c",
          canceled_at: secondsAt(10 * DAY),
          cancellation_details: { reason: "cancellation_requested" },
          ...price(10_000, "month"),
        }),
        subscription({
          status: "canceled",
          customer: "d",
          canceled_at: secondsAt(10 * DAY),
          cancellation_details: { reason: "payment_failed" },
          ...price(10_000, "month"),
        }),
      ]),
    });
    const scope = data(result.health);
    expect(scope.mrrCents).toBe(10_000);
    expect(scope.arrCents).toBe(120_000);
    expect(scope.activeSubscriptionsCount).toBe(1);
    // A PAYMENT-FAILED CANCELLATION IS NOT VOLUNTARY CHURN. One of the two
    // cancellations counts, over a denominator of all four subscriptions.
    expect(scope.voluntaryChurnRateBps).toBe(2_500);
    expect(scope.involuntaryChurnRateBps).toBe(2_500);
  });

  it("a cancellation OUTSIDE the lookback is not churn in this window", () => {
    const result = audit(
      {
        subscriptions: ok<Stripe.Subscription>([
          subscription({
            status: "canceled",
            customer: "old",
            canceled_at: secondsAt(120 * DAY),
            cancellation_details: { reason: "cancellation_requested" },
            ...price(10_000, "month"),
          }),
        ]),
      },
      90,
    );
    expect(data(result.health).voluntaryChurnRateBps).toBe(0);
  });

  it("no subscriptions divides by one rather than by zero", () => {
    expect(data(audit().health).voluntaryChurnRateBps).toBe(0);
    expect(data(audit().health).involuntaryChurnRateBps).toBe(0);
  });
});

describe("PER-SCOPE STATUS: a zero never means unknown", () => {

  it("the subscriptions read fails THREE scopes, because three depend on it", () => {
    const result = audit({ subscriptions: failed("subs unavailable") });
    expect(result.expiringCards.ok).toBe(false);
    expect(result.pastDueSubscriptions.ok).toBe(false);
    expect(result.health.ok).toBe(false);
    expect(result.failedInvoices.ok).toBe(true);
    expect(result.disputes.ok).toBe(true);
  });

  it("EITHER invoice read failing fails the invoice scope AND the advisory", () => {
    // Half a failed set is worse than none: legacy would report the uncollectible
    // half as the whole picture.
    const result = audit({ openInvoices: failed("open invoices unavailable") });
    expect(result.failedInvoices).toEqual({ ok: false, reason: "open invoices unavailable" });
    expect(result.cardUpdater).toEqual({ ok: false, reason: "open invoices unavailable" });
  });

  it("a failed EVENTS read fails only the advisory", () => {
    const result = audit({ cardUpdaterEvents: failed("events unavailable") });
    expect(result.cardUpdater).toEqual({ ok: false, reason: "events unavailable" });
    expect(result.failedInvoices.ok).toBe(true);
  });
});

describe("META and the no-write pin", () => {
  it("currency falls through the lists in legacy's order", () => {
    expect(audit().meta.currency).toBe("usd");
    expect(
      audit({ disputes: ok<Stripe.Dispute>([dispute({ currency: "GBP" })]) }).meta.currency,
    ).toBe("gbp");
    // Subscriptions win over disputes when both answered.
    expect(
      audit({
        subscriptions: ok<Stripe.Subscription>([subscription({ currency: "eur" })]),
        disputes: ok<Stripe.Dispute>([dispute({ currency: "gbp" })]),
      }).meta.currency,
    ).toBe("eur");
  });

  it("THE ENGINE WRITES NOTHING AND CALLS NOTHING, which PRICING rev 3 requires", () => {
    // The audit is FREE. A pure module cannot bill, and this is the pin that it
    // stayed pure: no outcome, no money write, no billing row, no Stripe client,
    // no database handle anywhere in the module.
    const source = readFileSync(
      fileURLToPath(new URL("../app/lib/audit/engine.ts", import.meta.url)),
      "utf8",
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      "recordOutcome",
      "executeMoneyWrite",
      "billingLineItems",
      "getDb",
      "getConnectedStripe",
      "db.",
      "await ",
    ]) {
      expect(code, `${forbidden} reached the pure engine`).not.toContain(forbidden);
    }
  });
});
